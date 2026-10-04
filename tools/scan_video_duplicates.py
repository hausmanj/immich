#!/usr/bin/env python3
"""Dedicated Video Duplicate Scanner for ImmichX.

Scans all videos in immichx, including the ~35k videos that lacked CLIP embeddings.
Detects duplicates using:
1. Exact file checksums (SHA1 / file hash).
2. Video duration (within 500ms) + matching resolution + capture date or filename.
Assigns or merges duplicateId in immichx-postgres so they appear in ImmichX Duplicates.
Always runs in DRY-RUN mode unless invoked with --apply.
"""

from __future__ import annotations

import argparse
import json
import shlex
import subprocess
import sys
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

REMOTE = "drhaus"
PORT = "22222"
USER = "hausmanj"
CONTAINER = "immichx-postgres"
DATABASE = "immichx"


def run_query(query: str):
    command = (
        f"/usr/local/bin/docker exec {shlex.quote(CONTAINER)} "
        f"psql -U postgres -d {shlex.quote(DATABASE)} -A -t "
        f"-c {shlex.quote(query)}"
    )
    ssh_cmd = ["ssh", "-p", PORT, "-o", "BatchMode=yes", f"{USER}@{REMOTE}", command]
    proc = subprocess.Popen(
        ssh_cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    assert proc.stdout is not None
    for line in proc.stdout:
        fields = line.rstrip("\n").split("\t")
        yield fields
    stderr = proc.stderr.read() if proc.stderr else ""
    if proc.wait() != 0:
        raise RuntimeError(f"Database query failed: {stderr.strip()}")


def execute_sql(sql_commands: str):
    command = (
        f"/usr/local/bin/docker exec -i {shlex.quote(CONTAINER)} "
        f"psql -U postgres -d {shlex.quote(DATABASE)}"
    )
    ssh_cmd = ["ssh", "-p", PORT, "-o", "BatchMode=yes", f"{USER}@{REMOTE}", command]
    proc = subprocess.run(ssh_cmd, input=sql_commands, text=True, capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError(f"SQL execution failed: {proc.stderr}")
    return proc.stdout


def main():
    parser = argparse.ArgumentParser(description="Scan videos for duplicates in ImmichX")
    parser.add_argument("--apply", action="store_true", help="Apply duplicate links to database (default is DRY-RUN)")
    args = parser.parse_args()

    print("=" * 70)
    print("IMMICHX DEDICATED VIDEO DUPLICATE SCANNER")
    print(f"Mode: {'APPLY (UPDATING DATABASE)' if args.apply else 'DRY RUN (REPORT ONLY)'}")
    print("=" * 70)

    print("Fetching active video inventory from immichx…")
    # Query all active videos with duration, size, dimensions, checksum
    query = """
    SELECT concat_ws(chr(9),
      a.id::text,
      coalesce(a."duplicateId"::text, ''),
      encode(a.checksum, 'hex'),
      a."originalPath",
      a."originalFileName",
      coalesce(a.duration, 0)::text,
      coalesce(a.width, ae."exifImageWidth", 0)::text,
      coalesce(a.height, ae."exifImageHeight", 0)::text,
      coalesce(ae."fileSizeInByte", 0)::text,
      coalesce(ae."dateTimeOriginal", a."localDateTime")::timestamp(0)::text
    )
    FROM asset a
    LEFT JOIN asset_exif ae ON ae."assetId" = a.id
    WHERE a."deletedAt" IS NULL
      AND a.type = 'VIDEO';
    """

    videos = []
    by_checksum = defaultdict(list)
    by_duration_and_name = defaultdict(list)
    by_duration_and_dims = defaultdict(list)

    total_videos = 0
    for fields in run_query(query):
        if len(fields) != 10:
            continue
        asset_id, dup_id, checksum, orig_path, filename, dur_str, w_str, h_str, size_str, date_str = fields
        duration = int(dur_str)
        width = int(w_str)
        height = int(h_str)
        file_size = int(size_str)

        v = {
            "id": asset_id,
            "duplicate_id": dup_id or None,
            "checksum": checksum,
            "path": orig_path,
            "filename": filename,
            "duration": duration,
            "width": width,
            "height": height,
            "file_size": file_size,
            "date": date_str,
        }
        videos.append(v)
        total_videos += 1

        if checksum and checksum != '':
            by_checksum[checksum].append(v)

        # Bucket duration to nearest 500ms (0.5s)
        dur_bucket = round(duration / 500) * 500 if duration > 0 else 0
        norm_name = filename.lower()
        if norm_name and dur_bucket > 0:
            by_duration_and_name[(dur_bucket, norm_name)].append(v)

        if dur_bucket > 0 and width > 0 and height > 0:
            # Aspect ratio rounded to 2 decimals
            aspect = round(width / height, 2)
            by_duration_and_dims[(dur_bucket, aspect, date_str[:10] if date_str else "")].append(v)

    print(f"Loaded {total_videos:,} active videos.")

    # Match groups
    matched_groups: list[list[dict]] = []
    seen_ids = set()

    # 1. Exact checksum matches
    exact_matches = 0
    for chk, group in by_checksum.items():
        if len(group) > 1:
            exact_matches += 1
            matched_groups.append(group)
            for item in group:
                seen_ids.add(item["id"])

    print(f"Found {exact_matches:,} exact checksum video duplicate groups.")

    # 2. Duration + Filename matches
    dur_name_matches = 0
    for (dur_b, name), group in by_duration_and_name.items():
        unseen = [item for item in group if item["id"] not in seen_ids]
        if len(unseen) > 1:
            dur_name_matches += 1
            matched_groups.append(unseen)
            for item in unseen:
                seen_ids.add(item["id"])

    print(f"Found {dur_name_matches:,} duration + filename video duplicate groups.")

    # 3. Duration + Aspect + Capture Date matches (e.g. converted / transcoded copies)
    dur_dim_matches = 0
    for (dur_b, aspect, date_prefix), group in by_duration_and_dims.items():
        if not date_prefix:
            continue
        unseen = [item for item in group if item["id"] not in seen_ids]
        if len(unseen) > 1:
            dur_dim_matches += 1
            matched_groups.append(unseen)
            for item in unseen:
                seen_ids.add(item["id"])

    print(f"Found {dur_dim_matches:,} duration + aspect + capture date video duplicate groups.")

    total_groups = len(matched_groups)
    total_duplicate_videos = sum(len(g) for g in matched_groups)
    print("=" * 70)
    print(f"TOTAL DETECTED VIDEO DUPLICATE GROUPS: {total_groups:,}")
    print(f"TOTAL VIDEOS INVOLVED: {total_duplicate_videos:,}")
    print("=" * 70)

    if not args.apply:
        print("\nDRY RUN complete. Showing first 5 video duplicate groups:")
        for idx, g in enumerate(matched_groups[:5], 1):
            print(f"\nGroup {idx} ({len(g)} videos):")
            for item in g:
                print(f"  • [{item['id']}] {item['duration']}ms | {item['width']}x{item['height']} | {item['date']} | {item['path']}")
        print("\nTo apply these duplicate links in ImmichX, run:")
        print("  python3 scan_video_duplicates.py --apply")
        return 0

    # Apply to database
    print(f"\nApplying {total_groups:,} video duplicate groups to immichx database…")
    sql_statements = ["BEGIN;"]
    now_iso = datetime.now(timezone.utc).isoformat()

    for group in matched_groups:
        # Check if an existing duplicateId exists in the group
        existing_dup_ids = [v["duplicate_id"] for v in group if v["duplicate_id"]]
        target_dup_id = existing_dup_ids[0] if existing_dup_ids else str(uuid.uuid4())

        asset_ids_sql = ", ".join(f"'{v['id']}'::uuid" for v in group)
        sql_statements.append(f"""
        UPDATE asset
        SET "duplicateId" = '{target_dup_id}'::uuid
        WHERE id IN ({asset_ids_sql});
        """)
        sql_statements.append(f"""
        INSERT INTO asset_job_status ("assetId", "duplicatesDetectedAt")
        VALUES {', '.join(f"('{v['id']}'::uuid, '{now_iso}')" for v in group)}
        ON CONFLICT ("assetId") DO UPDATE
        SET "duplicatesDetectedAt" = EXCLUDED."duplicatesDetectedAt";
        """)

    sql_statements.append("COMMIT;")
    batch_script = "\n".join(sql_statements)

    print("Executing update transaction over SSH…")
    execute_sql(batch_script)
    print("Successfully updated video duplicate links in ImmichX database!")
    return 0


if __name__ == "__main__":
    sys.exit(main())
