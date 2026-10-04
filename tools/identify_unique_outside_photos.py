#!/usr/bin/env python3
"""Identify unique photos in mainphoto (and outside folders) that do not exist in originals or macbookpro.

Read-only analysis tool:
- Scans immichx database on NAS over SSH.
- Filters out any photo that already has a counterpart in originals or uploads_macbookpro.
- Deduplicates photos that only exist inside mainphoto (picks highest resolution/quality keeper).
- Resolves capture dates from EXIF or filename (fixing corrupt fallback timestamps).
- Generates a CSV manifest and a migration staging script.
"""

from __future__ import annotations

import csv
import gzip
import json
import os
import re
import shlex
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

REMOTE = "drhaus"
PORT = "22222"
USER = "hausmanj"
CONTAINER = "immichx-postgres"
DATABASE = "immichx"
OUT_DIR = Path("/Users/johnhausman/immich-unique-outside-photos")

# Date pattern matchers
RE_DELIMITED = re.compile(
    r'(?:^|[^0-9a-zA-Z])(19[7-9]\d|20[0-3]\d)[-_.](0[1-9]|1[0-2])[-_.](0[1-9]|[12]\d|3[01])'
    r'(?:(?:[ _T-]+|\s+at\s+)(0\d|1\d|2[0-3]|[0-9])[-_.:](0\d|[0-5]\d)(?:[-_.:](0\d|[0-5]\d))?(?:\s*(AM|PM))?)?'
    r'(?:[^0-9a-zA-Z]|$)',
    re.IGNORECASE,
)
RE_COMPACT = re.compile(
    r'(?:^|[^0-9])(19[7-9]\d|20[0-3]\d)(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])'
    r'(?:[-_ ]?(0\d|1\d|2[0-3])([0-5]\d)([0-5]\d)?)?'
    r'(?:[^0-9]|$)'
)


def parse_date_from_filename(filename: str) -> str | None:
    if not filename:
        return None
    m = RE_DELIMITED.search(filename)
    if m:
        yr, mo, dy, hr, mn, sc, ampm = m.groups()
        h = int(hr) if hr else 0
        if ampm:
            if ampm.upper() == 'PM' and h < 12:
                h += 12
            elif ampm.upper() == 'AM' and h == 12:
                h = 0
        return f"{yr}-{mo}-{dy} {h:02d}:{int(mn or 0):02d}:{int(sc or 0):02d}"

    m2 = RE_COMPACT.search(filename)
    if m2:
        yr, mo, dy, hr, mn, sc = m2.groups()
        return f"{yr}-{mo}-{dy} {int(hr or 0):02d}:{int(mn or 0):02d}:{int(sc or 0):02d}"

    return None


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


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print("=" * 70)
    print("IMMICHX UNIQUE OUTSIDE PHOTOS IDENTIFIER")
    print("=" * 70)

    # Step 1: Identify all duplicateIds that already exist in originals or macbookpro
    print("Fetching duplicate IDs already present in originals or uploads_macbookpro…")
    known_dup_ids_query = """
    SELECT DISTINCT "duplicateId"::text
    FROM asset
    WHERE "deletedAt" IS NULL
      AND "duplicateId" IS NOT NULL
      AND ("originalPath" LIKE '%/mnt/originals/%' OR "originalPath" LIKE '%/mnt/uploads_macbookpro/%');
    """
    known_dup_ids = set()
    for row in run_query(known_dup_ids_query):
        if row and row[0]:
            known_dup_ids.add(row[0])
    print(f"Found {len(known_dup_ids):,} duplicate groups already in originals / macbookpro.")

    # Step 2: Fetch all photos outside originals and macbookpro
    print("Fetching active photos outside originals and macbookpro…")
    outside_photos_query = """
    SELECT concat_ws(chr(9),
      a.id::text,
      coalesce(a."duplicateId"::text, ''),
      a."originalPath",
      a."originalFileName",
      coalesce(a.width, ae."exifImageWidth", 0)::text,
      coalesce(a.height, ae."exifImageHeight", 0)::text,
      coalesce(ae."fileSizeInByte", 0)::text,
      coalesce(ae."dateTimeOriginal", a."localDateTime")::timestamp(0)::text
    )
    FROM asset a
    LEFT JOIN asset_exif ae ON ae."assetId" = a.id
    WHERE a."deletedAt" IS NULL
      AND a.type = 'IMAGE'
      AND a."originalPath" NOT LIKE '%/mnt/originals/%'
      AND a."originalPath" NOT LIKE '%/mnt/uploads_macbookpro/%';
    """

    unique_photos = []
    internal_dup_groups: dict[str, list] = {}
    skipped_already_in_originals = 0
    total_scanned = 0

    for fields in run_query(outside_photos_query):
        if len(fields) != 8:
            continue
        total_scanned += 1
        asset_id, dup_id, orig_path, filename, width_str, height_str, size_str, date_str = fields
        width = int(width_str)
        height = int(height_str)
        pixels = width * height
        size_bytes = int(size_str)

        # Check if already present in originals or macbookpro
        if dup_id and dup_id in known_dup_ids:
            skipped_already_in_originals += 1
            continue

        item = {
            "asset_id": asset_id,
            "duplicate_id": dup_id,
            "original_path": orig_path,
            "filename": filename,
            "width": width,
            "height": height,
            "pixels": pixels,
            "file_size": size_bytes,
            "recorded_date": date_str,
        }

        if dup_id:
            internal_dup_groups.setdefault(dup_id, []).append(item)
        else:
            item["status"] = "unique_no_duplicates"
            unique_photos.append(item)

        if total_scanned % 25000 == 0:
            print(f"Scanned {total_scanned:,} photos…")

    print(f"Total scanned outside: {total_scanned:,}")
    print(f"Skipped (already in originals/macbookpro): {skipped_already_in_originals:,}")
    print(f"Unique with no duplicates: {len(unique_photos):,}")
    print(f"Internal duplicate groups (within mainphoto only): {len(internal_dup_groups):,}")

    # For internal duplicate groups, pick the best candidate (keeper)
    chosen_from_groups = 0
    discarded_internal_dups = 0
    for dup_id, group in internal_dup_groups.items():
        # Sort by pixels desc, then file_size desc
        group.sort(key=lambda x: (x["pixels"], x["file_size"]), reverse=True)
        best = group[0]
        best["status"] = f"best_of_{len(group)}_internal_copies"
        unique_photos.append(best)
        chosen_from_groups += 1
        discarded_internal_dups += len(group) - 1

    print(f"Chosen best copies from internal groups: {chosen_from_groups:,}")
    print(f"Secondary internal duplicate copies omitted: {discarded_internal_dups:,}")
    print(f"Total unique photos to migrate into originals: {len(unique_photos):,}")

    # Step 3: Date resolution & Manifest generation
    manifest_csv = OUT_DIR / "unique_photos_for_originals.csv.gz"
    print(f"Resolving dates and writing manifest to {manifest_csv}…")

    filename_dates_used = 0
    suspect_dates_repaired = 0

    with gzip.open(manifest_csv, "wt", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow([
            "asset_id",
            "duplicate_id",
            "original_path",
            "filename",
            "file_size_bytes",
            "width",
            "height",
            "recorded_date",
            "resolved_date",
            "date_source",
            "suggested_originals_subfolder",
            "status"
        ])

        for item in unique_photos:
            rec_date = item["recorded_date"]
            fn_date = parse_date_from_filename(item["filename"])
            resolved_date = rec_date
            date_source = "exif"

            # Check if recorded date is suspect or missing
            is_suspect = False
            if rec_date:
                # check August 2021
                if rec_date.startswith("2021-08"):
                    is_suspect = True
                # check if filename date differs significantly
                if fn_date and not fn_date.startswith(rec_date[:10]):
                    is_suspect = True
            else:
                is_suspect = True

            if fn_date and (is_suspect or not rec_date):
                resolved_date = fn_date
                date_source = "filename_extracted"
                filename_dates_used += 1
                if is_suspect:
                    suspect_dates_repaired += 1
            elif not resolved_date:
                resolved_date = "Unknown_Date"
                date_source = "unknown"

            # Compute suggested target folder: YYYY/YYYY-MM
            if resolved_date and resolved_date != "Unknown_Date":
                year = resolved_date[:4]
                year_month = resolved_date[:7]
                target_subfolder = f"{year}/{year_month}"
            else:
                target_subfolder = "Unsorted_Date"

            writer.writerow([
                item["asset_id"],
                item["duplicate_id"],
                item["original_path"],
                item["filename"],
                item["file_size"],
                item["width"],
                item["height"],
                rec_date,
                resolved_date,
                date_source,
                target_subfolder,
                item["status"]
            ])

    # Summary
    summary = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "total_outside_photos_scanned": total_scanned,
        "already_in_originals_or_macbookpro": skipped_already_in_originals,
        "unique_photos_needing_migration": len(unique_photos),
        "never_duplicated_count": len(unique_photos) - chosen_from_groups,
        "internal_duplicate_groups_consolidated": len(internal_dup_groups),
        "secondary_internal_copies_omitted": discarded_internal_dups,
        "filename_dates_recovered": filename_dates_used,
        "suspect_dates_corrected_by_filename": suspect_dates_repaired,
        "manifest_file": str(manifest_csv),
    }

    summary_file = OUT_DIR / "summary.json"
    with summary_file.open("w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)
        f.write("\n")

    print("\n" + json.dumps(summary, indent=2))
    print(f"\nManifest successfully written to: {manifest_csv}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
