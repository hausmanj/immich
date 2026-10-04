#!/usr/bin/env python3
"""Stage unique outside photos to originals intake folder on NAS.

Reads unique_photos_for_originals.csv.gz and generates or executes rsync / cp
commands to stage photos into organized YYYY/YYYY-MM/ subdirectories in originals intake.
Always runs in DRY-RUN mode unless explicitly invoked with --execute.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import json
import os
import shlex
import subprocess
import sys
from pathlib import Path

MANIFEST = Path("/Users/johnhausman/immich-unique-outside-photos/unique_photos_for_originals.csv.gz")
REMOTE = "drhaus"
PORT = "22222"
USER = "hausmanj"
DEFAULT_TARGET = "/volume1/photosync/originals_clean/Intake_Unique_Mainphoto"


def main():
    parser = argparse.ArgumentParser(description="Stage unique outside photos to originals intake")
    parser.add_argument("--execute", action="store_true", help="Actually copy files (default is DRY-RUN)")
    parser.add_argument("--limit", type=int, default=None, help="Limit number of files to process")
    parser.add_argument("--target-base", default=DEFAULT_TARGET, help="Destination directory on NAS")
    args = parser.parse_args()

    if not MANIFEST.exists():
        print(f"Error: Manifest {MANIFEST} does not exist. Run identify_unique_outside_photos.py first.")
        return 1

    print("=" * 70)
    print("STAGE UNIQUE PHOTOS TO ORIGINALS INTAKE")
    print(f"Mode: {'EXECUTE (LIVE COPY)' if args.execute else 'DRY RUN (NO FILES TOUCHED)'}")
    print(f"Target Directory: {args.target_base}")
    print("=" * 70)

    count = 0
    total_bytes = 0
    commands = []

    with gzip.open(MANIFEST, "rt", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            src = row["original_path"]
            # Convert /mnt/mainphoto/ to /volume1/photo/master photo library/
            nas_src = src.replace("/mnt/mainphoto/", "/volume1/photo/master photo library/")
            nas_src = nas_src.replace("/mnt/photos/", "/volume2/laptop backup/")

            subfolder = row["suggested_originals_subfolder"]
            target_dir = f"{args.target_base}/{subfolder}"
            filename = row["filename"]
            target_file = f"{target_dir}/{filename}"

            total_bytes += int(row["file_size_bytes"] or 0)
            commands.append((nas_src, target_dir, target_file))
            count += 1
            if args.limit and count >= args.limit:
                break

    print(f"Total files in queue: {count:,} ({total_bytes / (1024**3):.2f} GB)")

    if not args.execute:
        print("\nDRY RUN complete. Showing first 10 staging mappings:")
        for src, dest_dir, dest_file in commands[:10]:
            print(f"  {src}  ->  {dest_file}")
        print(f"\nTo execute staging on NAS, re-run with: python3 stage_unique_photos_to_originals.py --execute")
        if not args.limit:
            print(f"(Recommended to test first with: python3 stage_unique_photos_to_originals.py --execute --limit 50)")
        return 0

    # Execute copies on NAS in batches via SSH
    print(f"\nExecuting copy of {len(commands):,} files to NAS…")
    batch_size = 500
    for i in range(0, len(commands), batch_size):
        batch = commands[i : i + batch_size]
        script_lines = []
        for src, dest_dir, dest_file in batch:
            script_lines.append(f"mkdir -p {shlex.quote(dest_dir)} && cp -n {shlex.quote(src)} {shlex.quote(dest_file)}")
        remote_script = "\n".join(script_lines)

        ssh_cmd = ["ssh", "-p", PORT, "-o", "BatchMode=yes", f"{USER}@{REMOTE}", "sh -e"]
        proc = subprocess.run(ssh_cmd, input=remote_script, text=True, capture_output=True)
        if proc.returncode != 0:
            print(f"Error executing batch {i//batch_size + 1}: {proc.stderr}")
            return 1
        print(f"Staged {min(i + batch_size, len(commands)):,} / {len(commands):,} files…")

    print("\nStaging complete!")
    return 0


if __name__ == "__main__":
    sys.exit(main())
