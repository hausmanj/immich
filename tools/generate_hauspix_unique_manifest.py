#!/usr/bin/env python3
"""Generate Hauspix-compatible JSONL manifest for unique outside photos.

Reads unique_photos_for_originals.csv.gz and outputs a structured JSONL manifest
ready for Hauspix /manifest review, filtering, and sorting.
"""

from __future__ import annotations

import csv
import gzip
import json
import os
import sys
from pathlib import Path

CSV_GZ = Path("/Users/johnhausman/immich-unique-outside-photos/unique_photos_for_originals.csv.gz")
OUTPUT_JSONL = Path("/Users/johnhausman/immich-unique-outside-photos/unique_outside_photos.jsonl")

PATH_REPLACEMENTS = [
    ("/mnt/mainphoto/", "/volume1/photo/master photo library/"),
    ("/mnt/photos/", "/volume2/laptop backup/"),
    ("/mnt/uploads_macbookpro/", "/volume1/photosync/uploads_macbookpro/"),
    ("/mnt/originals/", "/volume1/photosync/originals_clean/"),
]


def to_native_path(container_path: str) -> str:
    for src, dst in PATH_REPLACEMENTS:
        if container_path.startswith(src):
            return dst + container_path[len(src) :]
    return container_path


def main():
    if not CSV_GZ.exists():
        print(f"Error: {CSV_GZ} does not exist.")
        return 1

    print(f"Reading {CSV_GZ}…")
    count = 0
    tier_counts = {"unique_clean": 0, "keeper_outside_dup": 0, "date_recovered": 0}

    with gzip.open(CSV_GZ, "rt", newline="", encoding="utf-8") as fin, \
         open(OUTPUT_JSONL, "w", encoding="utf-8") as fout:

        reader = csv.DictReader(fin)
        for row in reader:
            orig_path = row["original_path"]
            native_path = to_native_path(orig_path)

            # Rel path within master photo library
            rel = native_path.replace("/volume1/photo/master photo library/", "")
            parts = [p for p in rel.split("/") if p]
            album_name = parts[0] if len(parts) > 1 else "(library root)"
            subfolder_name = "/".join(parts[:-1]) if len(parts) > 1 else "(library root)"

            date_src = row.get("date_source") or "exif"
            status = row.get("status") or "unique_no_duplicates"
            resolved_date = row.get("resolved_date") or None
            recorded_date = row.get("recorded_date") or None

            # Classification tier & status badge
            if date_src == "filename_extracted":
                tier = "date_recovered"
                status_text = "DATE FIXED"
                status_kind = "C"  # Amber
                status_title = f"Date fixed from filename: {resolved_date} (recorded was {recorded_date})"
                tier_counts["date_recovered"] += 1
            elif status.startswith("best_of_"):
                tier = "keeper_outside_dup"
                status_text = "BEST COPY"
                status_kind = "B"  # Blue
                status_title = f"Selected best copy from duplicate group in master photo library ({status})"
                tier_counts["keeper_outside_dup"] += 1
            else:
                tier = "unique_clean"
                status_text = "UNIQUE"
                status_kind = "A"  # Green
                status_title = "Unique photo outside originals/macbookpro. No duplicates found."
                tier_counts["unique_clean"] += 1

            size_bytes = int(row.get("file_size_bytes") or 0)
            width = int(row.get("width") or 0) if row.get("width") else None
            height = int(row.get("height") or 0) if row.get("height") else None

            albums = [{"album": album_name}]
            if subfolder_name != album_name and subfolder_name != "(library root)":
                albums.append({"album": subfolder_name})

            rec = {
                "path": native_path,
                "tier": tier,
                "date": resolved_date if resolved_date and resolved_date != "undated" else None,
                "size": size_bytes,
                "width": width,
                "height": height,
                "copies_on_nas": 1,
                "albums": albums,
                "status_text": status_text,
                "status_kind": status_kind,
                "status_title": status_title,
                "n": 1,
                "copies": [native_path],
                "origin": orig_path,
                "verdict": "unique",
                "suggested_target": row.get("suggested_originals_subfolder") or "",
                "asset_id": row.get("asset_id") or "",
            }

            fout.write(json.dumps(rec, ensure_ascii=False) + "\n")
            count += 1

    print(f"Generated {count:,} JSONL records into {OUTPUT_JSONL}")
    print(f"  • unique_clean: {tier_counts['unique_clean']:,}")
    print(f"  • keeper_outside_dup: {tier_counts['keeper_outside_dup']:,}")
    print(f"  • date_recovered: {tier_counts['date_recovered']:,}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
