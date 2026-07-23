#!/usr/bin/env python3
"""Crash-resumable, read-only media census for large filesystem trees.

The scanner writes only to its SQLite database/progress file. Source trees are
opened for directory enumeration and stat calls; media bytes are never opened.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import sqlite3
import sys
import tempfile
import time
import uuid
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


IMAGE_EXTENSIONS = {
    "3fr",
    "ari",
    "arw",
    "avif",
    "bay",
    "bmp",
    "cap",
    "cr2",
    "cr3",
    "crw",
    "dcr",
    "dcs",
    "dib",
    "dng",
    "drf",
    "eip",
    "eps",
    "erf",
    "fff",
    "gif",
    "gpr",
    "heic",
    "heif",
    "hif",
    "ico",
    "iiq",
    "insp",
    "j2c",
    "j2k",
    "jfif",
    "jp2",
    "jpe",
    "jpeg",
    "jpf",
    "jpg",
    "jpm",
    "jpx",
    "jxl",
    "k25",
    "kdc",
    "mef",
    "mos",
    "mpo",
    "mrw",
    "nef",
    "nrw",
    "orf",
    "pef",
    "png",
    "psb",
    "psd",
    "ptx",
    "pxn",
    "raf",
    "raw",
    "rwl",
    "rw2",
    "sr2",
    "srf",
    "srw",
    "svg",
    "tif",
    "tiff",
    "webp",
    "x3f",
}

VIDEO_EXTENSIONS = {
    "3g2",
    "3gp",
    "3gpp",
    "asf",
    "avi",
    "braw",
    "divx",
    "dv",
    "f4v",
    "flv",
    "insv",
    "lrv",
    "m2t",
    "m2ts",
    "m4v",
    "mkv",
    "mov",
    "mp4",
    "mpe",
    "mpeg",
    "mpg",
    "mts",
    "mxf",
    "ogm",
    "ogv",
    "qt",
    "rm",
    "rmvb",
    "ts",
    "vob",
    "webm",
    "wmv",
}

# This is an operating boundary, not merely a default CLI preference.
PROTECTED_EXCLUDED_COMPONENTS = {"jellyfinmedia"}
DEFAULT_EXCLUDED_COMPONENTS = {"@eadir"}


SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS scan_run (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  root TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  hostname TEXT NOT NULL,
  pid INTEGER NOT NULL,
  files_seen INTEGER NOT NULL DEFAULT 0,
  media_files INTEGER NOT NULL DEFAULT 0,
  media_bytes INTEGER NOT NULL DEFAULT 0,
  image_files INTEGER NOT NULL DEFAULT 0,
  video_files INTEGER NOT NULL DEFAULT 0,
  directories_completed INTEGER NOT NULL DEFAULT 0,
  excluded_directories INTEGER NOT NULL DEFAULT 0,
  symlinks_skipped INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  last_path TEXT,
  summary_json TEXT
);

CREATE TABLE IF NOT EXISTS scan_directory (
  run_id TEXT NOT NULL REFERENCES scan_run(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  PRIMARY KEY (run_id, path)
);
CREATE INDEX IF NOT EXISTS scan_directory_status_idx ON scan_directory(run_id, status, path);

CREATE TABLE IF NOT EXISTS media_file (
  path TEXT PRIMARY KEY,
  root TEXT NOT NULL,
  share TEXT NOT NULL,
  kind TEXT NOT NULL,
  extension TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  mtime_ns INTEGER NOT NULL,
  device INTEGER,
  inode INTEGER,
  first_seen_run TEXT NOT NULL,
  last_seen_run TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS media_file_share_idx ON media_file(share);
CREATE INDEX IF NOT EXISTS media_file_extension_idx ON media_file(extension);
CREATE INDEX IF NOT EXISTS media_file_kind_idx ON media_file(kind);
CREATE INDEX IF NOT EXISTS media_file_inode_idx ON media_file(device, inode);

CREATE TABLE IF NOT EXISTS scan_media_file (
  run_id TEXT NOT NULL REFERENCES scan_run(id) ON DELETE CASCADE,
  path TEXT NOT NULL REFERENCES media_file(path),
  PRIMARY KEY (run_id, path)
);
CREATE INDEX IF NOT EXISTS scan_media_file_path_idx ON scan_media_file(path);

CREATE TABLE IF NOT EXISTS scan_exclusion (
  run_id TEXT NOT NULL REFERENCES scan_run(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY (run_id, path)
);

CREATE TABLE IF NOT EXISTS scan_error (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES scan_run(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  operation TEXT NOT NULL,
  error TEXT NOT NULL,
  created_at TEXT NOT NULL
);
"""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def json_dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def write_json_atomic(path: str | None, value: Any) -> None:
    if not path:
        return
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{target.name}.", dir=str(target.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def connect(database: str) -> sqlite3.Connection:
    Path(database).parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(database, timeout=60)
    connection.row_factory = sqlite3.Row
    connection.executescript(SCHEMA)
    return connection


def media_kind(filename: str) -> tuple[str, str] | None:
    suffix = Path(filename).suffix
    if not suffix:
        return None
    extension = suffix[1:].lower()
    if extension in IMAGE_EXTENSIONS:
        return ("image", extension)
    if extension in VIDEO_EXTENSIONS:
        return ("video", extension)
    return None


def share_for(root: str, path: str) -> str:
    relative = os.path.relpath(path, root)
    return relative.split(os.sep, 1)[0] if relative != "." else "."


def exclusion_reason(
    root: str,
    path: str,
    excluded_components: set[str],
    excluded_top_level_prefixes: tuple[str, ...],
) -> str | None:
    relative = os.path.relpath(path, root)
    components = relative.split(os.sep)
    folded = {component.casefold() for component in components}
    protected = folded.intersection(PROTECTED_EXCLUDED_COMPONENTS)
    if protected:
        return "protected_component:JellyfinMedia"
    configured = folded.intersection(excluded_components)
    if configured:
        return f"excluded_component:{sorted(configured)[0]}"
    if len(components) == 1 and excluded_top_level_prefixes and components[0].startswith(excluded_top_level_prefixes):
        return "excluded_top_level_system_tree"
    return None


def scalar(connection: sqlite3.Connection, sql: str, parameters: tuple[Any, ...]) -> int:
    row = connection.execute(sql, parameters).fetchone()
    return int(row[0] or 0)


def status_payload(connection: sqlite3.Connection, run_id: str) -> dict[str, Any]:
    run = connection.execute("SELECT * FROM scan_run WHERE id = ?", (run_id,)).fetchone()
    if run is None:
        raise SystemExit(f"Unknown scan run: {run_id}")
    payload = dict(run)
    payload["policy"] = json.loads(payload.pop("policy_json"))
    summary_json = payload.pop("summary_json")
    payload["summary"] = json.loads(summary_json) if summary_json else None
    payload["directoryQueue"] = {
        row["status"]: row["count"]
        for row in connection.execute(
            "SELECT status, COUNT(*) AS count FROM scan_directory WHERE run_id = ? GROUP BY status",
            (run_id,),
        )
    }
    payload["pendingDirectories"] = payload["directoryQueue"].get("pending", 0)
    payload["processingDirectories"] = payload["directoryQueue"].get("processing", 0)
    return payload


def top_rows(
    connection: sqlite3.Connection,
    run_id: str,
    column: str,
    limit: int = 200,
) -> list[dict[str, Any]]:
    if column not in {"share", "extension", "kind"}:
        raise ValueError(column)
    rows = connection.execute(
        f"""
        SELECT media_file.{column} AS key, COUNT(*) AS files, SUM(media_file.size_bytes) AS bytes
        FROM scan_media_file
        JOIN media_file ON media_file.path = scan_media_file.path
        WHERE scan_media_file.run_id = ?
        GROUP BY media_file.{column}
        ORDER BY files DESC, key
        LIMIT ?
        """,
        (run_id, limit),
    )
    return [dict(row) for row in rows]


def build_summary(connection: sqlite3.Connection, run_id: str) -> dict[str, Any]:
    payload = status_payload(connection, run_id)
    return {
        "runId": run_id,
        "status": payload["status"],
        "root": payload["root"],
        "startedAt": payload["started_at"],
        "updatedAt": payload["updated_at"],
        "completedAt": payload["completed_at"],
        "policy": payload["policy"],
        "counts": {
            "filesSeen": payload["files_seen"],
            "mediaFiles": payload["media_files"],
            "mediaBytes": payload["media_bytes"],
            "imageFiles": payload["image_files"],
            "videoFiles": payload["video_files"],
            "directoriesCompleted": payload["directories_completed"],
            "excludedDirectories": payload["excluded_directories"],
            "symlinksSkipped": payload["symlinks_skipped"],
            "errors": payload["errors"],
        },
        "directoryQueue": payload["directoryQueue"],
        "byShare": top_rows(connection, run_id, "share"),
        "byKind": top_rows(connection, run_id, "kind"),
        "byExtension": top_rows(connection, run_id, "extension"),
        "exclusions": [
            dict(row)
            for row in connection.execute(
                "SELECT reason, COUNT(*) AS directories FROM scan_exclusion WHERE run_id = ? GROUP BY reason ORDER BY directories DESC, reason",
                (run_id,),
            )
        ],
        "errorOperations": [
            dict(row)
            for row in connection.execute(
                "SELECT operation, COUNT(*) AS errors FROM scan_error WHERE run_id = ? GROUP BY operation ORDER BY errors DESC, operation",
                (run_id,),
            )
        ],
    }


def emit_progress(connection: sqlite3.Connection, run_id: str, progress_file: str | None) -> None:
    payload = status_payload(connection, run_id)
    payload["heartbeatAt"] = utc_now()
    write_json_atomic(progress_file, payload)
    print(json_dump({
        "runId": run_id,
        "status": payload["status"],
        "directoriesCompleted": payload["directories_completed"],
        "pendingDirectories": payload["pendingDirectories"],
        "filesSeen": payload["files_seen"],
        "mediaFiles": payload["media_files"],
        "mediaBytes": payload["media_bytes"],
        "errors": payload["errors"],
        "lastPath": payload["last_path"],
        "heartbeatAt": payload["heartbeatAt"],
    }), flush=True)


def record_error(
    connection: sqlite3.Connection,
    run_id: str,
    path: str,
    operation: str,
    error: BaseException,
) -> None:
    connection.execute(
        "INSERT INTO scan_error(run_id, path, operation, error, created_at) VALUES (?, ?, ?, ?, ?)",
        (run_id, path, operation, f"{type(error).__name__}: {error}", utc_now()),
    )


def create_or_resume_run(
    connection: sqlite3.Connection,
    root: str,
    policy: dict[str, Any],
    requested_run_id: str | None,
    resume_latest: bool,
) -> tuple[str, bool]:
    if requested_run_id or resume_latest:
        if requested_run_id:
            row = connection.execute("SELECT * FROM scan_run WHERE id = ?", (requested_run_id,)).fetchone()
        else:
            row = connection.execute(
                "SELECT * FROM scan_run WHERE root = ? AND status IN ('running', 'interrupted') ORDER BY started_at DESC LIMIT 1",
                (root,),
            ).fetchone()
        if row is None:
            raise SystemExit("No resumable scan run found")
        if row["root"] != root:
            raise SystemExit(f"Run root mismatch: stored={row['root']} requested={root}")
        if json.loads(row["policy_json"]) != policy:
            raise SystemExit("Run exclusion/extension policy does not match; start a new run")
        run_id = str(row["id"])
        connection.execute(
            "UPDATE scan_directory SET status = 'pending' WHERE run_id = ? AND status = 'processing'",
            (run_id,),
        )
        connection.execute(
            "UPDATE scan_run SET status = 'running', updated_at = ?, pid = ?, hostname = ? WHERE id = ?",
            (utc_now(), os.getpid(), socket.gethostname(), run_id),
        )
        connection.commit()
        return (run_id, True)

    run_id = str(uuid.uuid4())
    now = utc_now()
    connection.execute(
        """
        INSERT INTO scan_run(id, status, root, policy_json, started_at, updated_at, hostname, pid)
        VALUES (?, 'running', ?, ?, ?, ?, ?, ?)
        """,
        (run_id, root, json_dump(policy), now, now, socket.gethostname(), os.getpid()),
    )
    connection.execute(
        "INSERT INTO scan_directory(run_id, path, status) VALUES (?, ?, 'pending')",
        (run_id, root),
    )
    connection.commit()
    return (run_id, False)


def scan_directory(
    connection: sqlite3.Connection,
    run_id: str,
    root: str,
    directory: str,
    excluded_components: set[str],
    excluded_top_level_prefixes: tuple[str, ...],
) -> None:
    files_seen = 0
    media_files = 0
    media_bytes = 0
    images = 0
    videos = 0
    exclusions = 0
    symlinks = 0
    errors = 0

    connection.execute("BEGIN IMMEDIATE")
    try:
        try:
            iterator = os.scandir(directory)
        except OSError as error:
            record_error(connection, run_id, directory, "scandir", error)
            connection.execute(
                "UPDATE scan_directory SET status = 'error', error = ? WHERE run_id = ? AND path = ?",
                (f"{type(error).__name__}: {error}", run_id, directory),
            )
            connection.execute(
                "UPDATE scan_run SET errors = errors + 1, updated_at = ?, last_path = ? WHERE id = ?",
                (utc_now(), directory, run_id),
            )
            connection.commit()
            return

        with iterator:
            for entry in iterator:
                path = entry.path
                try:
                    if entry.is_symlink():
                        symlinks += 1
                        continue
                    if entry.is_dir(follow_symlinks=False):
                        reason = exclusion_reason(
                            root,
                            path,
                            excluded_components,
                            excluded_top_level_prefixes,
                        )
                        if reason:
                            connection.execute(
                                "INSERT OR IGNORE INTO scan_exclusion(run_id, path, reason) VALUES (?, ?, ?)",
                                (run_id, path, reason),
                            )
                            exclusions += 1
                        else:
                            connection.execute(
                                "INSERT OR IGNORE INTO scan_directory(run_id, path, status) VALUES (?, ?, 'pending')",
                                (run_id, path),
                            )
                        continue
                    if not entry.is_file(follow_symlinks=False):
                        continue
                    files_seen += 1
                    identified = media_kind(entry.name)
                    if not identified:
                        continue
                    kind, extension = identified
                    stat = entry.stat(follow_symlinks=False)
                    share = share_for(root, path)
                    connection.execute(
                        """
                        INSERT INTO media_file(
                          path, root, share, kind, extension, size_bytes, mtime_ns, device, inode,
                          first_seen_run, last_seen_run
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(path) DO UPDATE SET
                          root = excluded.root,
                          share = excluded.share,
                          kind = excluded.kind,
                          extension = excluded.extension,
                          size_bytes = excluded.size_bytes,
                          mtime_ns = excluded.mtime_ns,
                          device = excluded.device,
                          inode = excluded.inode,
                          last_seen_run = excluded.last_seen_run
                        """,
                        (
                            path,
                            root,
                            share,
                            kind,
                            extension,
                            stat.st_size,
                            stat.st_mtime_ns,
                            stat.st_dev,
                            stat.st_ino,
                            run_id,
                            run_id,
                        ),
                    )
                    inserted = connection.execute(
                        "INSERT OR IGNORE INTO scan_media_file(run_id, path) VALUES (?, ?)",
                        (run_id, path),
                    ).rowcount
                    if inserted:
                        media_files += 1
                        media_bytes += stat.st_size
                        if kind == "image":
                            images += 1
                        else:
                            videos += 1
                except OSError as error:
                    record_error(connection, run_id, path, "entry", error)
                    errors += 1

        connection.execute(
            "UPDATE scan_directory SET status = 'complete', error = NULL WHERE run_id = ? AND path = ?",
            (run_id, directory),
        )
        connection.execute(
            """
            UPDATE scan_run SET
              files_seen = files_seen + ?,
              media_files = media_files + ?,
              media_bytes = media_bytes + ?,
              image_files = image_files + ?,
              video_files = video_files + ?,
              directories_completed = directories_completed + 1,
              excluded_directories = excluded_directories + ?,
              symlinks_skipped = symlinks_skipped + ?,
              errors = errors + ?,
              updated_at = ?,
              last_path = ?
            WHERE id = ?
            """,
            (
                files_seen,
                media_files,
                media_bytes,
                images,
                videos,
                exclusions,
                symlinks,
                errors,
                utc_now(),
                directory,
                run_id,
            ),
        )
        connection.commit()
    except BaseException:
        connection.rollback()
        raise


def run_scan(arguments: argparse.Namespace) -> int:
    root = os.path.abspath(arguments.root)
    database = os.path.abspath(arguments.database)
    if not os.path.isdir(root):
        raise SystemExit(f"Scan root is not a readable directory: {root}")
    excluded_components = DEFAULT_EXCLUDED_COMPONENTS.union(
        component.casefold() for component in arguments.exclude_component
    )
    policy = {
        "protectedExcludedComponents": sorted(PROTECTED_EXCLUDED_COMPONENTS),
        "excludedComponents": sorted(excluded_components),
        "excludedTopLevelPrefixes": sorted(arguments.exclude_top_level_prefix),
        "followSymlinks": False,
        "detection": "extension",
        "imageExtensions": sorted(IMAGE_EXTENSIONS),
        "videoExtensions": sorted(VIDEO_EXTENSIONS),
    }
    connection = connect(database)
    run_id, resumed = create_or_resume_run(
        connection,
        root,
        policy,
        arguments.run_id,
        arguments.resume_latest,
    )
    print(json_dump({
        "event": "scan_started",
        "runId": run_id,
        "resumed": resumed,
        "database": database,
        "root": root,
        "policy": policy,
    }), flush=True)
    emit_progress(connection, run_id, arguments.progress_file)

    last_progress = time.monotonic()
    try:
        while True:
            row = connection.execute(
                "SELECT path FROM scan_directory WHERE run_id = ? AND status = 'pending' ORDER BY path LIMIT 1",
                (run_id,),
            ).fetchone()
            if row is None:
                break
            directory = str(row["path"])
            connection.execute(
                "UPDATE scan_directory SET status = 'processing' WHERE run_id = ? AND path = ?",
                (run_id, directory),
            )
            connection.commit()
            scan_directory(
                connection,
                run_id,
                root,
                directory,
                excluded_components,
                tuple(arguments.exclude_top_level_prefix),
            )
            if time.monotonic() - last_progress >= arguments.progress_seconds:
                emit_progress(connection, run_id, arguments.progress_file)
                last_progress = time.monotonic()

        completed_at = utc_now()
        connection.execute(
            "UPDATE scan_run SET status = 'completed', updated_at = ?, completed_at = ? WHERE id = ?",
            (completed_at, completed_at, run_id),
        )
        connection.commit()
        summary = build_summary(connection, run_id)
        connection.execute(
            "UPDATE scan_run SET summary_json = ? WHERE id = ?",
            (json_dump(summary), run_id),
        )
        connection.commit()
        emit_progress(connection, run_id, arguments.progress_file)
        write_json_atomic(arguments.summary_file, summary)
        print(json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True), flush=True)
        return 0
    except KeyboardInterrupt:
        connection.execute(
            "UPDATE scan_run SET status = 'interrupted', updated_at = ? WHERE id = ?",
            (utc_now(), run_id),
        )
        connection.commit()
        emit_progress(connection, run_id, arguments.progress_file)
        return 130
    except BaseException as error:
        connection.execute(
            "UPDATE scan_run SET status = 'interrupted', updated_at = ? WHERE id = ?",
            (utc_now(), run_id),
        )
        connection.commit()
        emit_progress(connection, run_id, arguments.progress_file)
        print(f"media-census failed: {type(error).__name__}: {error}", file=sys.stderr, flush=True)
        raise
    finally:
        connection.close()


def run_status(arguments: argparse.Namespace) -> int:
    connection = connect(os.path.abspath(arguments.database))
    try:
        if arguments.run_id:
            run_id = arguments.run_id
        else:
            row = connection.execute("SELECT id FROM scan_run ORDER BY started_at DESC LIMIT 1").fetchone()
            if row is None:
                raise SystemExit("No census runs exist")
            run_id = str(row["id"])
        payload = status_payload(connection, run_id)
        print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
        return 0
    finally:
        connection.close()


def run_summary(arguments: argparse.Namespace) -> int:
    connection = connect(os.path.abspath(arguments.database))
    try:
        if arguments.run_id:
            run_id = arguments.run_id
        else:
            row = connection.execute("SELECT id FROM scan_run ORDER BY started_at DESC LIMIT 1").fetchone()
            if row is None:
                raise SystemExit("No census runs exist")
            run_id = str(row["id"])
        print(json.dumps(build_summary(connection, run_id), ensure_ascii=False, indent=2, sort_keys=True))
        return 0
    finally:
        connection.close()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Read-only, SQLite-backed photo/video census with durable directory checkpoints."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    scan = subparsers.add_parser("scan", help="start or resume a census")
    scan.add_argument("--root", required=True)
    scan.add_argument("--database", required=True)
    scan.add_argument("--progress-file")
    scan.add_argument("--summary-file")
    scan.add_argument("--run-id", help="resume this interrupted/running run")
    scan.add_argument("--resume-latest", action="store_true")
    scan.add_argument("--exclude-component", action="append", default=[])
    scan.add_argument("--exclude-top-level-prefix", action="append", default=["@"])
    scan.add_argument("--progress-seconds", type=float, default=10.0)
    scan.set_defaults(func=run_scan)

    status = subparsers.add_parser("status", help="show the latest durable run status")
    status.add_argument("--database", required=True)
    status.add_argument("--run-id")
    status.set_defaults(func=run_status)

    summary = subparsers.add_parser("summary", help="rebuild a run summary from the catalog")
    summary.add_argument("--database", required=True)
    summary.add_argument("--run-id")
    summary.set_defaults(func=run_summary)
    return parser


def main() -> int:
    arguments = build_parser().parse_args()
    return int(arguments.func(arguments))


if __name__ == "__main__":
    raise SystemExit(main())
