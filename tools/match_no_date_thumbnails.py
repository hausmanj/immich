#!/usr/bin/env python3
"""Match active _no date thumbnail/preview photos in ImmichX to their full-res originals.

Scans active photos in /mnt/mainphoto/_no date/ (including the ~30k June 2015 cluster)
and finds their nearest visual neighbor across the rest of the library using CLIP embeddings.
Links them into duplicate groups in ImmichX so they appear in Immich Duplicates utility,
allowing the user to review and resolve them with the full-res version preserved.

Usage:
  python3 match_no_date_thumbnails.py            # Dry-run mode (summary only)
  python3 match_no_date_thumbnails.py --apply    # Commit updates to database
"""

from __future__ import annotations

import argparse
import shlex
import subprocess
import sys
import time
import uuid

REMOTE = "drhaus"
PORT = "22222"
USER = "hausmanj"
CONTAINER = "immichx-postgres"
DATABASE = "immichx"
MAX_DISTANCE = 0.080
BATCH_SIZE = 100


def execute_sql(sql_commands: str) -> None:
    command = (
        f"/usr/local/bin/docker exec -i {shlex.quote(CONTAINER)} "
        f"psql -U postgres -d {shlex.quote(DATABASE)}"
    )
    ssh_cmd = ["ssh", "-p", PORT, "-o", "BatchMode=yes", f"{USER}@{REMOTE}", command]
    proc = subprocess.run(ssh_cmd, input=sql_commands, text=True, capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError(f"Database command failed: {proc.stderr.strip()}")


def run_query(query: str):
    command = (
        f"/usr/local/bin/docker exec {shlex.quote(CONTAINER)} "
        f"psql -U postgres -d {shlex.quote(DATABASE)} -A -t -F $'\\t' "
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
        line = line.rstrip("\n")
        if line:
            yield line.split("\t")
    stderr = proc.stderr.read() if proc.stderr else ""
    if proc.wait() != 0:
        raise RuntimeError(f"Database query failed: {stderr.strip()}")


def main():
    parser = argparse.ArgumentParser(description="Match _no date thumbnails to full-res originals")
    parser.add_argument("--apply", action="store_true", help="Apply updates to immichx database")
    parser.add_argument("--distance", type=float, default=MAX_DISTANCE, help=f"Max visual distance (default {MAX_DISTANCE})")
    parser.add_argument("--limit", type=int, default=0, help="Limit number of candidates to process (0 for unlimited)")
    parser.add_argument("--batch-size", type=int, default=BATCH_SIZE, help=f"Batch size (default {BATCH_SIZE})")
    parser.add_argument("-v", "--verbose", action="store_true", help="Print details of each matched pair")
    args = parser.parse_args()

    max_dist = args.distance
    batch_size = args.batch_size
    mode_str = "APPLY MODE" if args.apply else "DRY-RUN MODE (pass --apply to execute)"
    print("=" * 70)
    print(f"IMMICHX THUMBNAIL VISUAL DEDUPLICATION ({mode_str})")
    print(f"Max distance threshold: {max_dist}")
    print("=" * 70)

    # 1. Fetch candidate asset IDs that are not yet paired with an original in /mnt/originals, /mnt/uploads_macbookpro, or general library
    print("Querying candidate assets in _no date and derivative folders…")
    candidate_query = """
    SELECT a.id, coalesce(a."duplicateId"::text, '')
    FROM asset a
    JOIN smart_search s ON a.id = s."assetId"
    WHERE (
      a."originalPath" LIKE '/mnt/mainphoto/_no date/%'
      OR a."originalPath" LIKE '%/apple_derivatives/%'
      OR a."originalPath" LIKE '%/photo exif unknown/%'
    )
      AND a."deletedAt" IS NULL
      AND (
        a."duplicateId" IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM asset orig 
          WHERE orig."duplicateId" = a."duplicateId" 
            AND orig."originalPath" NOT LIKE '/mnt/mainphoto/_no date/%'
            AND orig."originalPath" NOT LIKE '%/apple_derivatives/%'
            AND orig."originalPath" NOT LIKE '%/photo exif unknown/%'
        )
      )
    ORDER BY a."fileCreatedAt" ASC, a.id ASC;
    """
    candidates = list(run_query(candidate_query))
    if args.limit > 0:
        candidates = candidates[:args.limit]
    total_candidates = len(candidates)
    print(f"Found {total_candidates:,} candidate assets to check against library originals.\n")

    if total_candidates == 0:
        print("No candidates found.")
        return 0

    total_matches = 0
    total_batches = (total_candidates + batch_size - 1) // batch_size
    start_time = time.time()

    for batch_num in range(total_batches):
        batch_slice = candidates[batch_num * batch_size : (batch_num + 1) * batch_size]
        batch_ids = [c[0] for c in batch_slice]
        ids_sql_list = ", ".join(f"'{cid}'::uuid" for cid in batch_ids)

        # Batch tiered lateral join query:
        # Strictly matches candidate thumbnails against REAL library originals only.
        # NEVER matches a thumbnail against another thumbnail or derivative cache.
        # Enforces size asymmetry (original must be larger than derivative) and aspect ratio sanity.
        # Tier 0: /mnt/originals/
        # Tier 1: /mnt/uploads_macbookpro/
        # Tier 2: Regular library photos
        match_query = f"""
        SELECT 
          a.id, 
          coalesce(a."duplicateId"::text, ''),
          b.id, 
          coalesce(b."duplicateId"::text, ''),
          b.dist,
          a.cand_name,
          coalesce(a.cand_size, 0),
          b.orig_name,
          coalesce(b.orig_size, 0),
          b.orig_path
        FROM (
          SELECT a.id, a."originalFileName" as cand_name, a."duplicateId", s.embedding, ea."fileSizeInByte" as cand_size,
                 ea."exifImageWidth" as cand_w, ea."exifImageHeight" as cand_h
          FROM asset a
          JOIN smart_search s ON a.id = s."assetId"
          LEFT JOIN asset_exif ea ON a.id = ea."assetId"
          WHERE a.id IN ({ids_sql_list})
        ) a
        CROSS JOIN LATERAL (
          SELECT id, "duplicateId", dist, orig_name, orig_size, orig_path
          FROM (
            SELECT b.id, b."duplicateId", b."originalFileName" as orig_name, b."originalPath" as orig_path,
                   (a.embedding <=> s2.embedding) as dist,
                   b.type as orig_type, eb."fileSizeInByte" as orig_size,
                   eb."exifImageWidth" as orig_w, eb."exifImageHeight" as orig_h
            FROM asset b
            JOIN smart_search s2 ON b.id = s2."assetId"
            LEFT JOIN asset_exif eb ON b.id = eb."assetId"
            WHERE b.id != a.id
              AND b."deletedAt" IS NULL
              AND b.type IN ('IMAGE', 'VIDEO')
              AND b."stackId" IS NULL
              AND b.visibility IN ('archive', 'timeline')
              AND b."originalPath" NOT LIKE '/mnt/mainphoto/_no date/%'
              AND b."originalPath" NOT LIKE '%/apple_derivatives/%'
              AND b."originalPath" NOT LIKE '%/photo exif unknown/%'
              AND b."originalPath" NOT LIKE '%/_app_assets/%'
              AND (
                a.cand_size IS NULL 
                OR eb."fileSizeInByte" IS NULL 
                OR eb."fileSizeInByte" > a.cand_size * 1.5
              )
            ORDER BY a.embedding <=> s2.embedding ASC
            LIMIT 5
          ) top5
          WHERE (
            -- High confidence visual match with size asymmetry
            (dist <= {max_dist} AND (
              orig_type = 'VIDEO'
              OR orig_w IS NULL OR orig_h IS NULL OR a.cand_w IS NULL OR a.cand_h IS NULL
              OR ABS((orig_w::float / NULLIF(orig_h, 0)) - (a.cand_w::float / NULLIF(a.cand_h, 0))) <= 0.06
              OR (a.cand_w = a.cand_h AND dist <= 0.065) -- square cropped thumbnail
            ))
          )
          ORDER BY 
            CASE 
              WHEN orig_path LIKE '/mnt/originals/%' THEN 0
              WHEN orig_path LIKE '/mnt/uploads_macbookpro/%' THEN 1
              ELSE 2
            END ASC,
            dist ASC
          LIMIT 1
        ) b;
        """

        matches = list(run_query(match_query))
        batch_matches_count = len(matches)
        total_matches += batch_matches_count

        if args.verbose:
            for row in matches:
                cand_id, cand_dup_id, match_id, match_dup_id, dist_str, cname, csz, oname, osz, opath = row
                ckb = int(csz) // 1024 if csz.isdigit() else 0
                okb = int(osz) // 1024 if osz.isdigit() else 0
                print(f"  [MATCH dist={float(dist_str):.4f}] {cname} ({ckb}KB) -> {oname} ({okb}KB) in {opath[:60]}")

        if args.apply and matches:
            now_iso = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
            sql_statements = ["BEGIN;"]

            # Assign duplicateId strictly per match pair without cascading or chaining groups
            for row in matches:
                cand_id, cand_dup_id, match_id, match_dup_id = row[0], row[1], row[2], row[3]
                target_dup_id = match_dup_id or cand_dup_id or str(uuid.uuid4())
                sql_statements.append(f"""
                UPDATE asset
                SET "duplicateId" = '{target_dup_id}'::uuid
                WHERE id IN ('{cand_id}'::uuid, '{match_id}'::uuid);
                """)
                sql_statements.append(f"""
                INSERT INTO asset_job_status ("assetId", "duplicatesDetectedAt")
                VALUES ('{cand_id}'::uuid, '{now_iso}'), ('{match_id}'::uuid, '{now_iso}')
                ON CONFLICT ("assetId") DO UPDATE
                SET "duplicatesDetectedAt" = EXCLUDED."duplicatesDetectedAt";
                """)

            sql_statements.append("COMMIT;")
            execute_sql("\n".join(sql_statements))

        elapsed = time.time() - start_time
        processed = min((batch_num + 1) * batch_size, total_candidates)
        rate = processed / elapsed if elapsed > 0 else 0
        eta_seconds = (total_candidates - processed) / rate if rate > 0 else 0
        print(
            f"Batch {batch_num + 1:3d}/{total_batches} "
            f"[{processed:6,d}/{total_candidates:,}] "
            f"— Matched: {batch_matches_count:3d} (Total matched: {total_matches:5,d}) "
            f"— {rate:5.1f} assets/s, ETA: {int(eta_seconds)}s",
            flush=True,
        )

    print("\n" + "=" * 70)
    print(f"COMPLETED in {time.time() - start_time:.1f}s")
    print(f"Total candidates scanned: {total_candidates:,}")
    print(f"Total duplicates matched: {total_matches:,}")
    if not args.apply:
        print("\nTo apply these duplicate links to the database, run:")
        print("  python3 match_no_date_thumbnails.py --apply")
    else:
        print("\nAll matched duplicates successfully linked in ImmichX!")
        print("Open ImmichX Duplicates (/utilities/duplicates) to review them.")
    print("=" * 70)
    return 0


if __name__ == "__main__":
    sys.exit(main())
