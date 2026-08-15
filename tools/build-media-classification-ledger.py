#!/usr/bin/env python3
"""Build a read-only path-rule classification ledger from sealed media censuses.

The output directory must not already exist. The input census databases are opened
read-only and immutable; the completed ledger and reports are made read-only.
"""

from __future__ import annotations

import argparse
import collections
import hashlib
import json
import os
import re
import sqlite3
import sys
import time
from pathlib import Path
from typing import Iterable, Iterator, NamedTuple


RULESET_VERSION = "2026-07-23.1"
CLASSIFICATIONS = (
    "protected_reference",
    "source_candidate",
    "generated_derivative",
    "photos_library_internal_review",
    "application_noise",
    "unknown_error",
)

PROTECTED_PREFIXES = (
    "/volume1/photo/originals",
    "/volume1/photosync/originals_clean",
)

VOLUME1_SOURCE_PREFIXES = {
    "/volume1/photosync/uploads_macbookpro": "volume1_uploads_macbookpro",
    "/volume1/web/uploads_nextcloud": "volume1_nextcloud_upload",
    "/volume1/photosync/uploads_imazing": "volume1_imazing_upload",
    "/volume1/photo/archive": "volume1_photo_archive",
    "/volume1/photosync/hold": "volume1_hold_review",
    "/volume1/homes/tim": "volume1_user_home_review",
    "/volume1/homes/hausmanj": "volume1_user_home_review",
    "/volume1/video": "volume1_video_share_review",
}

APPLICATION_COMPONENTS = {
    ".cache",
    ".npm",
    ".yarn",
    "__pycache__",
    "cache",
    "caches",
    "node_modules",
    "program files",
    "program files (x86)",
    "site-packages",
    "temporaryitems",
}

DERIVATIVE_COMPONENTS = {
    ".thumbnails",
    "previews",
    "preview",
    "thumbnails",
    "transcoded",
}

GENERATED_BASENAME_RE = re.compile(
    r"(^|[-_. ])(backdrop|favicon|landscape|logo|poster|thumb|thumbnail)"
    r"([-_. ]|$)",
    re.IGNORECASE,
)


class Classification(NamedTuple):
    category: str
    reason: str
    confidence: str


def is_under(path: str, prefix: str) -> bool:
    return path == prefix or path.startswith(prefix + "/")


def classify_path(path: str) -> Classification:
    normalized = path.rstrip("/")
    lower = normalized.lower()
    parts = normalized.split("/")
    lower_parts = [part.lower() for part in parts]

    for prefix in PROTECTED_PREFIXES:
        if is_under(normalized, prefix):
            return Classification("protected_reference", "protected_originals_tree", "certain")

    photos_index = next(
        (index for index, part in enumerate(lower_parts) if part.endswith(".photoslibrary")),
        None,
    )
    if photos_index is not None:
        inside = lower_parts[photos_index + 1 :]
        if inside and inside[0] in {"originals", "masters"}:
            return Classification("source_candidate", "photos_library_original_or_master", "high")
        if len(inside) >= 2 and inside[0] == "resources" and inside[1] in {
            "proxies",
            "derivatives",
            "renders",
        }:
            return Classification(
                "generated_derivative", "photos_library_generated_resource", "certain"
            )
        return Classification(
            "photos_library_internal_review", "photos_library_noncanonical_internal", "high"
        )

    basename = lower_parts[-1] if lower_parts else lower
    if (
        any(part in DERIVATIVE_COMPONENTS for part in lower_parts)
        or GENERATED_BASENAME_RE.search(basename)
    ):
        return Classification("generated_derivative", "generated_path_or_filename", "medium")

    if (
        is_under(normalized, "/volume1/web_packages")
        or any(part in APPLICATION_COMPONENTS for part in lower_parts)
        or "/system/library/" in lower
        or "/library/developer/" in lower
        or "/windows/" in lower
        or any(
            part.endswith(".app")
            and lower_parts[index + 1 : index + 3] == ["contents", "resources"]
            for index, part in enumerate(lower_parts)
        )
    ):
        return Classification("application_noise", "application_or_cache_path", "high")

    for prefix, reason in VOLUME1_SOURCE_PREFIXES.items():
        if is_under(normalized, prefix):
            return Classification("source_candidate", reason, "medium")

    if lower.startswith("/volume2/"):
        if (
            "/google takeout" in lower
            or "/takeout" in lower
            or "/total google/" in lower
            or "/googletest/" in lower
        ):
            return Classification("source_candidate", "google_export_source", "medium")
        if lower.startswith("/volume2/photo backups/"):
            return Classification("source_candidate", "volume2_photo_backup_source", "medium")
        if lower.startswith("/volume2/laptop backup/raw photo and video files/"):
            return Classification("source_candidate", "volume2_raw_media_backup_source", "medium")
        if lower.startswith("/volume2/work backup/"):
            return Classification("unknown_error", "work_backup_owner_scope_review", "low")
        if lower.startswith("/volume2/laptop backup/"):
            return Classification("unknown_error", "laptop_backup_unclassified_path", "low")

    if lower.startswith("/volume1/web/"):
        return Classification("unknown_error", "volume1_web_nonupload_review", "low")
    if lower.startswith("/volume1/"):
        return Classification("unknown_error", "volume1_unclassified_path", "low")
    return Classification("unknown_error", "unexpected_root", "low")


def parse_input(value: str) -> tuple[str, Path]:
    if "=" not in value:
        raise argparse.ArgumentTypeError("--input must be LABEL=/absolute/path.sqlite")
    label, raw_path = value.split("=", 1)
    if not label or not raw_path.startswith("/"):
        raise argparse.ArgumentTypeError("--input must be LABEL=/absolute/path.sqlite")
    return label, Path(raw_path)


def sha256_file(path: Path, chunk_size: int = 8 * 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_json(path: Path, value: object) -> None:
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2, sort_keys=True)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def cohort_key(path: str, depth: int = 5) -> str:
    parts = path.strip("/").split("/")
    return "/" + "/".join(parts[:depth])


def completed_run(connection: sqlite3.Connection) -> sqlite3.Row:
    connection.row_factory = sqlite3.Row
    rows = connection.execute(
        """
        SELECT *
        FROM scan_run
        WHERE status = ?
        ORDER BY completed_at DESC
        """,
        ("completed",),
    ).fetchall()
    if len(rows) != 1:
        raise RuntimeError(f"expected exactly one completed scan run, found {len(rows)}")
    return rows[0]


def input_rows(
    connection: sqlite3.Connection, run_id: str
) -> Iterator[tuple[str, str, str, str, int, int]]:
    yield from connection.execute(
        """
        SELECT media_file.path,
               media_file.share,
               media_file.kind,
               media_file.extension,
               media_file.size_bytes,
               media_file.mtime_ns
        FROM scan_media_file
        JOIN media_file ON media_file.path = scan_media_file.path
        WHERE scan_media_file.run_id = ?
        ORDER BY media_file.path
        """,
        (run_id,),
    )


def create_ledger_schema(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        PRAGMA journal_mode = DELETE;
        PRAGMA synchronous = FULL;
        PRAGMA temp_store = FILE;
        CREATE TABLE ledger_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE ledger_entry (
          source_label TEXT NOT NULL,
          run_id TEXT NOT NULL,
          path TEXT NOT NULL,
          share TEXT NOT NULL,
          kind TEXT NOT NULL,
          extension TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          mtime_ns INTEGER NOT NULL,
          classification TEXT NOT NULL CHECK (
            classification IN (
              'protected_reference',
              'source_candidate',
              'generated_derivative',
              'photos_library_internal_review',
              'application_noise',
              'unknown_error'
            )
          ),
          reason TEXT NOT NULL,
          confidence TEXT NOT NULL CHECK (confidence IN ('certain', 'high', 'medium', 'low')),
          mutation_allowed INTEGER NOT NULL DEFAULT 0 CHECK (mutation_allowed = 0),
          PRIMARY KEY (source_label, path)
        ) WITHOUT ROWID;
        CREATE TABLE scan_error_evidence (
          source_label TEXT NOT NULL,
          run_id TEXT NOT NULL,
          path TEXT NOT NULL,
          operation TEXT NOT NULL,
          error TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        """
    )


def build_ledger(inputs: list[tuple[str, Path]], output_dir: Path) -> dict[str, object]:
    output_dir.mkdir(mode=0o700, parents=True, exist_ok=False)
    started = time.time()
    progress_path = output_dir / "progress.json"
    building_path = output_dir / "classification-ledger.sqlite.building"
    final_path = output_dir / "classification-ledger.sqlite"
    ledger = sqlite3.connect(building_path)
    create_ledger_schema(ledger)
    ledger.execute(
        "INSERT INTO ledger_metadata(key, value) VALUES (?, ?)",
        ("ruleset_version", RULESET_VERSION),
    )

    category_counts: collections.Counter[tuple[str, str]] = collections.Counter()
    category_bytes: collections.Counter[tuple[str, str]] = collections.Counter()
    reason_counts: collections.Counter[tuple[str, str, str]] = collections.Counter()
    reason_bytes: collections.Counter[tuple[str, str, str]] = collections.Counter()
    unknown_cohorts: collections.Counter[tuple[str, str]] = collections.Counter()
    unknown_cohort_bytes: collections.Counter[tuple[str, str]] = collections.Counter()
    examples: dict[tuple[str, str], list[str]] = collections.defaultdict(list)
    input_details: list[dict[str, object]] = []
    total_rows = 0
    total_expected = 0
    total_errors = 0

    for source_label, input_path in inputs:
        if not input_path.is_file():
            raise FileNotFoundError(input_path)
        source_hash = sha256_file(input_path)
        source = sqlite3.connect(
            f"file:{input_path}?mode=ro&immutable=1",
            uri=True,
        )
        run = completed_run(source)
        expected = int(run["media_files"])
        total_expected += expected
        input_details.append(
            {
                "sourceLabel": source_label,
                "path": str(input_path),
                "sha256": source_hash,
                "runId": run["id"],
                "root": run["root"],
                "status": run["status"],
                "completedAt": run["completed_at"],
                "expectedMediaFiles": expected,
                "expectedMediaBytes": int(run["media_bytes"]),
            }
        )
        ledger.execute(
            "INSERT INTO ledger_metadata(key, value) VALUES (?, ?)",
            (f"input.{source_label}", json.dumps(input_details[-1], sort_keys=True)),
        )

        batch: list[tuple[object, ...]] = []
        source_rows = 0
        for path, share, kind, extension, size_bytes, mtime_ns in input_rows(
            source, run["id"]
        ):
            result = classify_path(path)
            batch.append(
                (
                    source_label,
                    run["id"],
                    path,
                    share,
                    kind,
                    extension,
                    size_bytes,
                    mtime_ns,
                    result.category,
                    result.reason,
                    result.confidence,
                )
            )
            key = (source_label, result.category)
            reason_key = (source_label, result.category, result.reason)
            category_counts[key] += 1
            category_bytes[key] += size_bytes
            reason_counts[reason_key] += 1
            reason_bytes[reason_key] += size_bytes
            if len(examples[key]) < 5:
                examples[key].append(path)
            if result.category == "unknown_error":
                unknown_key = (source_label, cohort_key(path))
                unknown_cohorts[unknown_key] += 1
                unknown_cohort_bytes[unknown_key] += size_bytes

            source_rows += 1
            total_rows += 1
            if len(batch) >= 20_000:
                ledger.executemany(
                    """
                    INSERT INTO ledger_entry(
                      source_label, run_id, path, share, kind, extension,
                      size_bytes, mtime_ns, classification, reason, confidence
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    batch,
                )
                ledger.commit()
                batch.clear()
                atomic_json(
                    progress_path,
                    {
                        "status": "running",
                        "rulesetVersion": RULESET_VERSION,
                        "sourceLabel": source_label,
                        "processedRows": total_rows,
                        "expectedRows": total_expected,
                        "updatedAtEpoch": time.time(),
                    },
                )
        if batch:
            ledger.executemany(
                """
                INSERT INTO ledger_entry(
                  source_label, run_id, path, share, kind, extension,
                  size_bytes, mtime_ns, classification, reason, confidence
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                batch,
            )
            ledger.commit()
        if source_rows != expected:
            raise RuntimeError(
                f"{source_label}: expected {expected} media rows, classified {source_rows}"
            )

        errors = source.execute(
            """
            SELECT path, operation, error, created_at
            FROM scan_error
            WHERE run_id = ?
            ORDER BY id
            """,
            (run["id"],),
        ).fetchall()
        total_errors += len(errors)
        ledger.executemany(
            """
            INSERT INTO scan_error_evidence(
              source_label, run_id, path, operation, error, created_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            [(source_label, run["id"], *error) for error in errors],
        )
        ledger.commit()
        source.close()

    if total_rows != total_expected:
        raise RuntimeError(f"expected {total_expected} total rows, classified {total_rows}")

    ledger.executescript(
        """
        CREATE INDEX ledger_entry_classification_idx
          ON ledger_entry(classification, source_label);
        CREATE INDEX ledger_entry_reason_idx
          ON ledger_entry(reason, source_label);
        CREATE INDEX ledger_entry_share_idx
          ON ledger_entry(source_label, share);
        ANALYZE;
        """
    )
    integrity = ledger.execute("PRAGMA integrity_check").fetchone()[0]
    if integrity != "ok":
        raise RuntimeError(f"output ledger integrity check failed: {integrity}")
    ledger.commit()
    ledger.close()
    os.replace(building_path, final_path)

    category_summary = []
    for source_label, category in sorted(category_counts):
        category_summary.append(
            {
                "sourceLabel": source_label,
                "classification": category,
                "files": category_counts[(source_label, category)],
                "bytes": category_bytes[(source_label, category)],
                "examples": examples[(source_label, category)],
            }
        )
    reason_summary = [
        {
            "sourceLabel": source_label,
            "classification": category,
            "reason": reason,
            "files": count,
            "bytes": reason_bytes[(source_label, category, reason)],
        }
        for (source_label, category, reason), count in sorted(
            reason_counts.items(), key=lambda item: (-item[1], item[0])
        )
    ]
    unknown_summary = [
        {
            "sourceLabel": source_label,
            "pathCohort": path,
            "files": count,
            "bytes": unknown_cohort_bytes[(source_label, path)],
        }
        for (source_label, path), count in sorted(
            unknown_cohorts.items(), key=lambda item: (-item[1], item[0])
        )
    ]
    summary = {
        "status": "completed",
        "rulesetVersion": RULESET_VERSION,
        "classificationIsPathRuleEvidenceNotADeletionDecision": True,
        "mutationAllowedForEveryRow": False,
        "inputs": input_details,
        "expectedRows": total_expected,
        "classifiedRows": total_rows,
        "unclassifiedRows": 0,
        "scanErrorEvidenceRows": total_errors,
        "categorySummary": category_summary,
        "reasonSummary": reason_summary,
        "elapsedSeconds": round(time.time() - started, 3),
    }
    atomic_json(output_dir / "summary.json", summary)
    atomic_json(
        output_dir / "unknown-and-error-report.json",
        {
            "rulesetVersion": RULESET_VERSION,
            "unknownPathCohorts": unknown_summary,
            "scanErrorEvidenceRows": total_errors,
            "note": (
                "unknown_error rows remain in classification-ledger.sqlite; "
                "this report is a grouped review queue."
            ),
        },
    )
    atomic_json(
        progress_path,
        {
            "status": "completed",
            "rulesetVersion": RULESET_VERSION,
            "processedRows": total_rows,
            "expectedRows": total_expected,
            "updatedAtEpoch": time.time(),
        },
    )

    with (output_dir / "INPUT-SHA256SUMS").open("x", encoding="utf-8") as stream:
        for detail in input_details:
            stream.write(f"{detail['sha256']}  {detail['path']}\n")
    output_artifacts = (
        final_path,
        output_dir / "summary.json",
        output_dir / "unknown-and-error-report.json",
        progress_path,
    )
    with (output_dir / "SHA256SUMS").open("x", encoding="utf-8") as stream:
        for artifact in output_artifacts:
            stream.write(f"{sha256_file(artifact)}  {artifact.name}\n")

    for artifact in output_dir.iterdir():
        artifact.chmod(0o444)
    output_dir.chmod(0o555)
    return summary


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--input",
        action="append",
        type=parse_input,
        required=True,
        help="Input as LABEL=/absolute/path/to/sealed.sqlite; repeat for each volume",
    )
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    if not args.output_dir.is_absolute():
        parser.error("--output-dir must be absolute")
    labels = [label for label, _ in args.input]
    if len(labels) != len(set(labels)):
        parser.error("--input labels must be unique")

    try:
        summary = build_ledger(args.input, args.output_dir)
    except Exception as error:
        print(f"classification ledger failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
