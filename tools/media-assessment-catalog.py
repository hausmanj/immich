#!/usr/bin/env python3
"""Durable SQLite media assessment catalog.

This is a read-only source scanner: it writes only to its SQLite database and
progress artifact. It enumerates scoped media paths, then fills per-path hashes,
raw ExifTool JSON, promoted EXIF/query fields, sidecar links, video probe JSON,
and basic quality/metadata scores. It is intentionally resumable at path level.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


IMAGE_EXTENSIONS = {
    "3fr", "ari", "arw", "avif", "bay", "bmp", "cap", "cr2", "cr3", "crw", "dcr",
    "dcs", "dib", "dng", "drf", "eip", "eps", "erf", "fff", "gif", "gpr", "heic",
    "heif", "hif", "ico", "iiq", "insp", "j2c", "j2k", "jfif", "jp2", "jpe",
    "jpeg", "jpf", "jpg", "jpm", "jpx", "jxl", "k25", "kdc", "mef", "mos", "mpo",
    "mrw", "nef", "nrw", "orf", "pef", "png", "psb", "psd", "ptx", "pxn", "raf",
    "raw", "rwl", "rw2", "sr2", "srf", "srw", "svg", "tif", "tiff", "webp", "x3f",
}
VIDEO_EXTENSIONS = {
    "3g2", "3gp", "3gpp", "asf", "avi", "braw", "divx", "dv", "f4v", "flv", "insv",
    "lrv", "m2t", "m2ts", "m4v", "mkv", "mov", "mp4", "mpe", "mpeg", "mpg", "mts",
    "mxf", "ogm", "ogv", "qt", "rm", "rmvb", "ts", "vob", "webm", "wmv",
}
SIDECAR_EXTENSIONS = {".aae", ".xmp", ".dop", ".pp3", ".thm", ".json"}
DEFAULT_EXCLUDED_NAMES = {
    "@eadir", "#recycle", "#snapshot", ".stversions", ".stfolder", "thumbs",
    "encoded-video", "node_modules", "__pycache__",
}
DEFAULT_DEFER_COMPONENTS = {"takeout", "google takeout", "total google", "googletest"}


SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS catalog_run (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  stage TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  hostname TEXT NOT NULL,
  pid INTEGER NOT NULL,
  scanned_dirs INTEGER NOT NULL DEFAULT 0,
  skipped_dirs INTEGER NOT NULL DEFAULT 0,
  cataloged_files INTEGER NOT NULL DEFAULT 0,
  assessed_files INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  last_path TEXT,
  summary_json TEXT
);

CREATE TABLE IF NOT EXISTS catalog_scope_rule (
  run_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  path TEXT NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY(run_id, scope, path)
);

CREATE TABLE IF NOT EXISTS catalog_file (
  path TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK(scope IN ('include', 'reference_only')),
  scope_reason TEXT NOT NULL,
  root TEXT NOT NULL,
  kind TEXT NOT NULL,
  extension TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  mtime_ns INTEGER NOT NULL,
  device INTEGER,
  inode INTEGER,
  first_seen_run TEXT NOT NULL,
  last_seen_run TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS catalog_file_scope_idx ON catalog_file(scope, kind, extension);
CREATE INDEX IF NOT EXISTS catalog_file_size_idx ON catalog_file(size_bytes);
CREATE INDEX IF NOT EXISTS catalog_file_inode_idx ON catalog_file(device, inode);

CREATE TABLE IF NOT EXISTS skipped_path (
  run_id TEXT NOT NULL,
  path TEXT NOT NULL,
  scope TEXT NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY(run_id, path)
);

CREATE TABLE IF NOT EXISTS file_assessment (
  path TEXT PRIMARY KEY REFERENCES catalog_file(path) ON DELETE CASCADE,
  status TEXT NOT NULL,
  assessed_at TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  mtime_ns INTEGER NOT NULL,
  sha1 TEXT,
  exif_status TEXT NOT NULL,
  ffprobe_status TEXT,
  width INTEGER,
  height INTEGER,
  duration_seconds REAL,
  camera_make TEXT,
  camera_model TEXT,
  lens_model TEXT,
  date_time_original TEXT,
  create_date TEXT,
  media_create_date TEXT,
  gps_latitude REAL,
  gps_longitude REAL,
  orientation TEXT,
  codec TEXT,
  container_format TEXT,
  has_sidecar INTEGER NOT NULL DEFAULT 0,
  metadata_score INTEGER NOT NULL DEFAULT 0,
  technical_score INTEGER NOT NULL DEFAULT 0,
  quality_score INTEGER NOT NULL DEFAULT 0,
  assessment_error TEXT
);
CREATE INDEX IF NOT EXISTS file_assessment_sha1_idx ON file_assessment(sha1);
CREATE INDEX IF NOT EXISTS file_assessment_quality_idx ON file_assessment(quality_score);
CREATE INDEX IF NOT EXISTS file_assessment_dates_idx ON file_assessment(date_time_original, create_date, media_create_date);

CREATE TABLE IF NOT EXISTS exif_raw (
  path TEXT PRIMARY KEY REFERENCES catalog_file(path) ON DELETE CASCADE,
  exiftool_json TEXT NOT NULL,
  captured_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ffprobe_raw (
  path TEXT PRIMARY KEY REFERENCES catalog_file(path) ON DELETE CASCADE,
  ffprobe_json TEXT NOT NULL,
  captured_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS file_sidecar (
  path TEXT NOT NULL REFERENCES catalog_file(path) ON DELETE CASCADE,
  sidecar_path TEXT NOT NULL,
  sidecar_kind TEXT NOT NULL,
  size_bytes INTEGER,
  mtime_ns INTEGER,
  PRIMARY KEY(path, sidecar_path)
);

CREATE TABLE IF NOT EXISTS catalog_error (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
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


def normalize_path(path: str) -> str:
    return os.path.abspath(path).rstrip("/")


def is_under(path: str, root: str) -> bool:
    return path == root or path.startswith(root + os.sep)


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


def path_components(path: str) -> list[str]:
    return [part.casefold() for part in Path(path).parts if part not in {os.sep, ""}]


class ScopePolicy:
    def __init__(self, args: argparse.Namespace):
        self.include_roots = [normalize_path(item) for item in args.include_root]
        self.reference_roots = [normalize_path(item) for item in args.reference_root]
        self.defer_roots = [normalize_path(item) for item in args.defer_root]
        self.exclude_roots = [normalize_path(item) for item in args.exclude_root]
        self.excluded_names = {item.casefold() for item in args.exclude_name}.union(DEFAULT_EXCLUDED_NAMES)
        self.defer_components = {item.casefold() for item in args.defer_component}.union(DEFAULT_DEFER_COMPONENTS)
        self.scan_roots = sorted(set(self.include_roots + self.reference_roots))

    def to_json(self) -> dict[str, Any]:
        return {
            "includeRoots": self.include_roots,
            "referenceRoots": self.reference_roots,
            "deferRoots": self.defer_roots,
            "excludeRoots": self.exclude_roots,
            "excludedNames": sorted(self.excluded_names),
            "deferComponents": sorted(self.defer_components),
            "imageExtensions": sorted(IMAGE_EXTENSIONS),
            "videoExtensions": sorted(VIDEO_EXTENSIONS),
            "followSymlinks": False,
        }

    def scope_for(self, path: str) -> tuple[str, str]:
        normalized = normalize_path(path)
        components = path_components(normalized)
        basename = components[-1] if components else ""
        if basename.startswith("._"):
            return ("exclude", "apple_double_resource_fork")
        if any(component in self.excluded_names for component in components):
            return ("exclude", "excluded_component")
        if any(is_under(normalized, root) for root in self.exclude_roots):
            return ("exclude", "excluded_root")
        if any(component in self.defer_components for component in components):
            return ("deferred", "deferred_component")
        if any(is_under(normalized, root) for root in self.defer_roots):
            return ("deferred", "deferred_root")
        if any(is_under(normalized, root) for root in self.reference_roots):
            return ("reference_only", "reference_root")
        if any(is_under(normalized, root) for root in self.include_roots):
            return ("include", "include_root")
        return ("exclude", "outside_scope")

    def root_for(self, path: str) -> str:
        normalized = normalize_path(path)
        candidates = self.include_roots + self.reference_roots
        matches = [root for root in candidates if is_under(normalized, root)]
        return max(matches, key=len) if matches else "."


def record_error(connection: sqlite3.Connection, run_id: str, path: str, operation: str, error: BaseException | str) -> None:
    message = str(error) if isinstance(error, str) else f"{type(error).__name__}: {error}"
    connection.execute(
        "INSERT INTO catalog_error(run_id, path, operation, error, created_at) VALUES (?, ?, ?, ?, ?)",
        (run_id, path, operation, message, utc_now()),
    )
    connection.execute(
        "UPDATE catalog_run SET error_count = error_count + 1, updated_at = ?, last_path = ? WHERE id = ?",
        (utc_now(), path, run_id),
    )


def create_or_resume_run(connection: sqlite3.Connection, run_id: str, policy: dict[str, Any]) -> None:
    now = utc_now()
    existing = connection.execute("SELECT * FROM catalog_run WHERE id = ?", (run_id,)).fetchone()
    if existing:
        if json.loads(existing["policy_json"]) != policy:
            raise SystemExit("Existing catalog run policy differs; refusing unsafe resume")
        connection.execute(
            "UPDATE catalog_run SET status = 'running', updated_at = ?, hostname = ?, pid = ? WHERE id = ?",
            (now, socket.gethostname(), os.getpid(), run_id),
        )
    else:
        connection.execute(
            """
            INSERT INTO catalog_run(id, status, stage, policy_json, started_at, updated_at, hostname, pid)
            VALUES (?, 'running', 'starting', ?, ?, ?, ?, ?)
            """,
            (run_id, json_dump(policy), now, now, socket.gethostname(), os.getpid()),
        )
    connection.commit()


def update_stage(connection: sqlite3.Connection, run_id: str, stage: str) -> None:
    connection.execute(
        "UPDATE catalog_run SET stage = ?, updated_at = ? WHERE id = ?",
        (stage, utc_now(), run_id),
    )
    connection.commit()


def status_payload(connection: sqlite3.Connection, run_id: str) -> dict[str, Any]:
    run = connection.execute("SELECT * FROM catalog_run WHERE id = ?", (run_id,)).fetchone()
    if not run:
        raise SystemExit(f"unknown run id: {run_id}")
    counts = connection.execute(
        """
        SELECT
          COUNT(*) AS catalog_files,
          SUM(CASE WHEN scope = 'include' THEN 1 ELSE 0 END) AS include_files,
          SUM(CASE WHEN scope = 'reference_only' THEN 1 ELSE 0 END) AS reference_files
        FROM catalog_file
        """
    ).fetchone()
    assessed = connection.execute("SELECT COUNT(*) FROM file_assessment WHERE status = 'ok'").fetchone()[0]
    pending = connection.execute(
        """
        SELECT COUNT(*)
        FROM catalog_file
        LEFT JOIN file_assessment ON file_assessment.path = catalog_file.path
        WHERE catalog_file.scope IN ('include', 'reference_only')
          AND (
            file_assessment.path IS NULL
            OR file_assessment.size_bytes != catalog_file.size_bytes
            OR file_assessment.mtime_ns != catalog_file.mtime_ns
            OR file_assessment.status != 'ok'
          )
        """
    ).fetchone()[0]
    payload = dict(run)
    payload["policy"] = json.loads(payload.pop("policy_json"))
    payload["summary"] = json.loads(payload["summary_json"]) if payload.get("summary_json") else None
    payload["counts"] = {
        "catalogFiles": int(counts["catalog_files"] or 0),
        "includeFiles": int(counts["include_files"] or 0),
        "referenceFiles": int(counts["reference_files"] or 0),
        "assessedOk": int(assessed or 0),
        "assessmentPending": int(pending or 0),
    }
    return payload


def emit_progress(connection: sqlite3.Connection, run_id: str, progress_file: str | None) -> None:
    payload = status_payload(connection, run_id)
    payload["heartbeatAt"] = utc_now()
    write_json_atomic(progress_file, payload)
    print(json_dump({
        "runId": run_id,
        "status": payload["status"],
        "stage": payload["stage"],
        "scannedDirs": payload["scanned_dirs"],
        "catalogFiles": payload["counts"]["catalogFiles"],
        "assessedOk": payload["counts"]["assessedOk"],
        "assessmentPending": payload["counts"]["assessmentPending"],
        "errors": payload["error_count"],
        "lastPath": payload["last_path"],
    }), flush=True)


def scan_paths(connection: sqlite3.Connection, run_id: str, policy: ScopePolicy, progress_file: str | None, progress_seconds: float) -> None:
    update_stage(connection, run_id, "enumerating_paths")
    for scope, roots in (("include", policy.include_roots), ("reference_only", policy.reference_roots), ("deferred", policy.defer_roots), ("exclude", policy.exclude_roots)):
        for root in roots:
            connection.execute(
                "INSERT OR IGNORE INTO catalog_scope_rule(run_id, scope, path, reason) VALUES (?, ?, ?, ?)",
                (run_id, scope, root, f"{scope}_root"),
            )
    connection.commit()

    last_progress = time.monotonic()
    for root in policy.scan_roots:
        if not os.path.isdir(root):
            record_error(connection, run_id, root, "scan_root", "root is not a directory")
            connection.commit()
            continue
        stack = [root]
        while stack:
            directory = stack.pop()
            directory_scope, directory_reason = policy.scope_for(directory)
            if directory_scope in {"exclude", "deferred"} and normalize_path(directory) != normalize_path(root):
                connection.execute(
                    "INSERT OR IGNORE INTO skipped_path(run_id, path, scope, reason) VALUES (?, ?, ?, ?)",
                    (run_id, directory, directory_scope, directory_reason),
                )
                connection.execute(
                    "UPDATE catalog_run SET skipped_dirs = skipped_dirs + 1, updated_at = ?, last_path = ? WHERE id = ?",
                    (utc_now(), directory, run_id),
                )
                connection.commit()
                continue
            try:
                entries = list(os.scandir(directory))
            except OSError as error:
                record_error(connection, run_id, directory, "scandir", error)
                connection.commit()
                continue
            for entry in entries:
                path = entry.path
                try:
                    if entry.is_symlink():
                        continue
                    if entry.is_dir(follow_symlinks=False):
                        stack.append(path)
                        continue
                    if not entry.is_file(follow_symlinks=False):
                        continue
                    scope, reason = policy.scope_for(path)
                    if scope in {"exclude", "deferred"}:
                        connection.execute(
                            "INSERT OR IGNORE INTO skipped_path(run_id, path, scope, reason) VALUES (?, ?, ?, ?)",
                            (run_id, path, scope, reason),
                        )
                        continue
                    identified = media_kind(entry.name)
                    if not identified:
                        continue
                    kind, extension = identified
                    stat = entry.stat(follow_symlinks=False)
                    connection.execute(
                        """
                        INSERT INTO catalog_file(
                          path, scope, scope_reason, root, kind, extension, size_bytes, mtime_ns,
                          device, inode, first_seen_run, last_seen_run, active
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
                        ON CONFLICT(path) DO UPDATE SET
                          scope = excluded.scope,
                          scope_reason = excluded.scope_reason,
                          root = excluded.root,
                          kind = excluded.kind,
                          extension = excluded.extension,
                          size_bytes = excluded.size_bytes,
                          mtime_ns = excluded.mtime_ns,
                          device = excluded.device,
                          inode = excluded.inode,
                          last_seen_run = excluded.last_seen_run,
                          active = 1
                        """,
                        (
                            path, scope, reason, policy.root_for(path), kind, extension,
                            stat.st_size, stat.st_mtime_ns, stat.st_dev, stat.st_ino, run_id, run_id,
                        ),
                    )
                    connection.execute(
                        "UPDATE catalog_run SET cataloged_files = cataloged_files + 1, last_path = ? WHERE id = ?",
                        (path, run_id),
                    )
                except OSError as error:
                    record_error(connection, run_id, path, "entry", error)
            connection.execute(
                "UPDATE catalog_run SET scanned_dirs = scanned_dirs + 1, updated_at = ?, last_path = ? WHERE id = ?",
                (utc_now(), directory, run_id),
            )
            connection.commit()
            if time.monotonic() - last_progress >= progress_seconds:
                emit_progress(connection, run_id, progress_file)
                last_progress = time.monotonic()
    emit_progress(connection, run_id, progress_file)


def sha1_file(path: str) -> str:
    digest = hashlib.sha1()
    with open(path, "rb") as stream:
        while chunk := stream.read(8 * 1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def run_exiftool(paths: list[str], exiftool: str) -> dict[str, dict[str, Any]]:
    if not paths:
        return {}
    result = subprocess.run(
        [exiftool, "-json", "-n", "-G1", "-api", "largefilesupport=1", "--", *paths],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode not in {0, 1}:
        raise RuntimeError(f"exiftool failed with code {result.returncode}: {result.stderr[:4000]}")
    rows = json.loads(result.stdout or "[]")
    return {str(row.get("SourceFile")): row for row in rows if row.get("SourceFile")}


def run_ffprobe(path: str, ffprobe: str) -> tuple[str, dict[str, Any] | None]:
    result = subprocess.run(
        [ffprobe, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        return ("error", {"error": result.stderr.strip()[:4000]})
    try:
        return ("ok", json.loads(result.stdout or "{}"))
    except json.JSONDecodeError as error:
        return ("error", {"error": f"JSONDecodeError: {error}"})


def tag(row: dict[str, Any], *names: str) -> Any:
    for name in names:
        if name in row:
            return row[name]
    suffixes = tuple(f":{name}" for name in names)
    for key, value in row.items():
        if key.endswith(suffixes):
            return value
    return None


def number(value: Any) -> float | None:
    if value in {None, ""}:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def integer(value: Any) -> int | None:
    parsed = number(value)
    return int(parsed) if parsed is not None else None


def promote_exif(row: dict[str, Any], ffprobe: dict[str, Any] | None) -> dict[str, Any]:
    width = integer(tag(row, "ImageWidth", "ExifImageWidth", "SourceImageWidth"))
    height = integer(tag(row, "ImageHeight", "ExifImageHeight", "SourceImageHeight"))
    duration = number(tag(row, "Duration", "MediaDuration"))
    codec = tag(row, "CompressorName", "VideoCodec", "CompressorID")
    container = tag(row, "FileType", "MIMEType")
    if ffprobe:
      streams = ffprobe.get("streams") or []
      video = next((stream for stream in streams if stream.get("codec_type") == "video"), None)
      if video:
          width = width or integer(video.get("width"))
          height = height or integer(video.get("height"))
          codec = codec or video.get("codec_name")
      fmt = ffprobe.get("format") or {}
      duration = duration or number(fmt.get("duration"))
      container = container or fmt.get("format_name")
    gps_lat = number(tag(row, "GPSLatitude", "Composite:GPSLatitude"))
    gps_lon = number(tag(row, "GPSLongitude", "Composite:GPSLongitude"))
    promoted = {
        "width": width,
        "height": height,
        "duration_seconds": duration,
        "camera_make": tag(row, "Make"),
        "camera_model": tag(row, "Model"),
        "lens_model": tag(row, "LensModel", "LensID"),
        "date_time_original": tag(row, "DateTimeOriginal"),
        "create_date": tag(row, "CreateDate"),
        "media_create_date": tag(row, "MediaCreateDate", "TrackCreateDate"),
        "gps_latitude": gps_lat,
        "gps_longitude": gps_lon,
        "orientation": tag(row, "Orientation"),
        "codec": codec,
        "container_format": container,
    }
    return promoted


def score(promoted: dict[str, Any], size_bytes: int, has_sidecar: bool) -> tuple[int, int, int]:
    metadata = 0
    if promoted.get("date_time_original") or promoted.get("create_date") or promoted.get("media_create_date"):
        metadata += 30
    if promoted.get("gps_latitude") is not None and promoted.get("gps_longitude") is not None:
        metadata += 20
    if promoted.get("camera_make") or promoted.get("camera_model"):
        metadata += 15
    if promoted.get("lens_model"):
        metadata += 5
    if promoted.get("width") and promoted.get("height"):
        metadata += 10
    if has_sidecar:
        metadata += 5
    pixels = (promoted.get("width") or 0) * (promoted.get("height") or 0)
    technical = 0
    if pixels >= 12_000_000:
        technical += 35
    elif pixels >= 8_000_000:
        technical += 30
    elif pixels >= 3_000_000:
        technical += 20
    elif pixels > 0:
        technical += 10
    if size_bytes >= 20_000_000:
        technical += 20
    elif size_bytes >= 5_000_000:
        technical += 15
    elif size_bytes >= 1_000_000:
        technical += 10
    if promoted.get("duration_seconds"):
        technical += 10
    return metadata, technical, metadata + technical


def sidecars_for(path: str) -> list[tuple[str, str, int | None, int | None]]:
    source = Path(path)
    stem = source.with_suffix("")
    candidates = set()
    for extension in SIDECAR_EXTENSIONS:
        candidates.add(str(stem) + extension)
        candidates.add(str(source) + extension)
    out = []
    for candidate in sorted(candidates):
        try:
            state = os.stat(candidate, follow_symlinks=False)
        except OSError:
            continue
        if os.path.isfile(candidate):
            out.append((candidate, Path(candidate).suffix.lower().lstrip("."), state.st_size, state.st_mtime_ns))
    return out


def pending_batch(connection: sqlite3.Connection, limit: int) -> list[sqlite3.Row]:
    return connection.execute(
        """
        SELECT catalog_file.*
        FROM catalog_file
        LEFT JOIN file_assessment ON file_assessment.path = catalog_file.path
        WHERE catalog_file.scope IN ('include', 'reference_only')
          AND catalog_file.active = 1
          AND (
            file_assessment.path IS NULL
            OR file_assessment.size_bytes != catalog_file.size_bytes
            OR file_assessment.mtime_ns != catalog_file.mtime_ns
            OR file_assessment.status != 'ok'
          )
        ORDER BY catalog_file.scope DESC, catalog_file.path
        LIMIT ?
        """,
        (limit,),
    ).fetchall()


def assess_paths(connection: sqlite3.Connection, run_id: str, args: argparse.Namespace) -> None:
    update_stage(connection, run_id, "assessing_files")
    last_progress = time.monotonic()
    while True:
        rows = pending_batch(connection, args.batch_size)
        if not rows:
            break
        paths = [str(row["path"]) for row in rows]
        try:
            exif_by_path = run_exiftool(paths, args.exiftool)
        except BaseException as error:
            for path in paths:
                record_error(connection, run_id, path, "exiftool_batch", error)
            connection.commit()
            exif_by_path = {}

        for row in rows:
            path = str(row["path"])
            now = utc_now()
            try:
                state = os.stat(path, follow_symlinks=False)
                digest = sha1_file(path)
                sidecars = sidecars_for(path)
                exif = exif_by_path.get(path, {"SourceFile": path, "Error": "missing from exiftool batch"})
                exif_status = "error" if exif.get("Error") else "ok"
                ffprobe_status = None
                ffprobe_json = None
                if row["kind"] == "video" and args.ffprobe:
                    ffprobe_status, ffprobe_json = run_ffprobe(path, args.ffprobe)
                promoted = promote_exif(exif, ffprobe_json if ffprobe_status == "ok" else None)
                metadata_score, technical_score, quality_score = score(promoted, state.st_size, bool(sidecars))
                connection.execute("DELETE FROM file_sidecar WHERE path = ?", (path,))
                for sidecar_path, sidecar_kind, sidecar_size, sidecar_mtime in sidecars:
                    connection.execute(
                        "INSERT OR REPLACE INTO file_sidecar(path, sidecar_path, sidecar_kind, size_bytes, mtime_ns) VALUES (?, ?, ?, ?, ?)",
                        (path, sidecar_path, sidecar_kind, sidecar_size, sidecar_mtime),
                    )
                connection.execute(
                    "INSERT OR REPLACE INTO exif_raw(path, exiftool_json, captured_at) VALUES (?, ?, ?)",
                    (path, json.dumps(exif, ensure_ascii=False, sort_keys=True), now),
                )
                if ffprobe_json is not None:
                    connection.execute(
                        "INSERT OR REPLACE INTO ffprobe_raw(path, ffprobe_json, captured_at) VALUES (?, ?, ?)",
                        (path, json.dumps(ffprobe_json, ensure_ascii=False, sort_keys=True), now),
                    )
                connection.execute(
                    """
                    INSERT OR REPLACE INTO file_assessment(
                      path, status, assessed_at, size_bytes, mtime_ns, sha1, exif_status, ffprobe_status,
                      width, height, duration_seconds, camera_make, camera_model, lens_model,
                      date_time_original, create_date, media_create_date, gps_latitude, gps_longitude,
                      orientation, codec, container_format, has_sidecar, metadata_score, technical_score,
                      quality_score, assessment_error
                    ) VALUES (?, 'ok', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
                    """,
                    (
                        path, now, state.st_size, state.st_mtime_ns, digest, exif_status, ffprobe_status,
                        promoted["width"], promoted["height"], promoted["duration_seconds"],
                        promoted["camera_make"], promoted["camera_model"], promoted["lens_model"],
                        promoted["date_time_original"], promoted["create_date"], promoted["media_create_date"],
                        promoted["gps_latitude"], promoted["gps_longitude"], promoted["orientation"],
                        promoted["codec"], promoted["container_format"], 1 if sidecars else 0,
                        metadata_score, technical_score, quality_score,
                    ),
                )
                connection.execute(
                    "UPDATE catalog_run SET assessed_files = assessed_files + 1, updated_at = ?, last_path = ? WHERE id = ?",
                    (now, path, run_id),
                )
            except BaseException as error:
                record_error(connection, run_id, path, "assess_file", error)
                connection.execute(
                    """
                    INSERT OR REPLACE INTO file_assessment(
                      path, status, assessed_at, size_bytes, mtime_ns, exif_status, assessment_error
                    ) VALUES (?, 'error', ?, ?, ?, 'not_read', ?)
                    """,
                    (path, now, row["size_bytes"], row["mtime_ns"], f"{type(error).__name__}: {error}"),
                )
            connection.commit()
            if time.monotonic() - last_progress >= args.progress_seconds:
                emit_progress(connection, run_id, args.progress_file)
                last_progress = time.monotonic()
    emit_progress(connection, run_id, args.progress_file)


def build_summary(connection: sqlite3.Connection, run_id: str) -> dict[str, Any]:
    base = status_payload(connection, run_id)
    by_scope = [dict(row) for row in connection.execute(
        "SELECT scope, COUNT(*) AS files, SUM(size_bytes) AS bytes FROM catalog_file GROUP BY scope ORDER BY scope"
    )]
    by_extension = [dict(row) for row in connection.execute(
        "SELECT extension, COUNT(*) AS files, SUM(size_bytes) AS bytes FROM catalog_file GROUP BY extension ORDER BY files DESC LIMIT 50"
    )]
    quality = [dict(row) for row in connection.execute(
        """
        SELECT
          COUNT(*) AS assessed,
          SUM(CASE WHEN date_time_original IS NOT NULL OR create_date IS NOT NULL OR media_create_date IS NOT NULL THEN 1 ELSE 0 END) AS with_date,
          SUM(CASE WHEN gps_latitude IS NOT NULL AND gps_longitude IS NOT NULL THEN 1 ELSE 0 END) AS with_gps,
          SUM(CASE WHEN camera_make IS NOT NULL OR camera_model IS NOT NULL THEN 1 ELSE 0 END) AS with_camera,
          SUM(CASE WHEN has_sidecar = 1 THEN 1 ELSE 0 END) AS with_sidecar
        FROM file_assessment
        WHERE status = 'ok'
        """
    )]
    exact_groups = connection.execute(
        "SELECT COUNT(*) FROM (SELECT sha1 FROM file_assessment WHERE sha1 IS NOT NULL GROUP BY sha1 HAVING COUNT(*) > 1)"
    ).fetchone()[0]
    return {
        "runId": run_id,
        "status": base["status"],
        "stage": base["stage"],
        "startedAt": base["started_at"],
        "completedAt": base["completed_at"],
        "counts": base["counts"],
        "byScope": by_scope,
        "byExtension": by_extension,
        "qualityCoverage": quality[0] if quality else {},
        "exactDuplicateHashGroups": exact_groups,
        "errors": base["error_count"],
    }


def run_command(args: argparse.Namespace) -> int:
    policy = ScopePolicy(args)
    if not policy.scan_roots:
        raise SystemExit("at least one --include-root or --reference-root is required")
    run_id = args.run_id or str(uuid.uuid4())
    connection = connect(args.database)
    try:
        create_or_resume_run(connection, run_id, policy.to_json())
        emit_progress(connection, run_id, args.progress_file)
        scan_paths(connection, run_id, policy, args.progress_file, args.progress_seconds)
        assess_paths(connection, run_id, args)
        completed_at = utc_now()
        connection.execute(
            "UPDATE catalog_run SET status = 'completed', stage = 'completed', updated_at = ?, completed_at = ? WHERE id = ?",
            (completed_at, completed_at, run_id),
        )
        summary = build_summary(connection, run_id)
        connection.execute(
            "UPDATE catalog_run SET summary_json = ? WHERE id = ?",
            (json_dump(summary), run_id),
        )
        connection.commit()
        emit_progress(connection, run_id, args.progress_file)
        write_json_atomic(args.summary_file, summary)
        print(json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True), flush=True)
        return 0
    except KeyboardInterrupt:
        connection.execute(
            "UPDATE catalog_run SET status = 'interrupted', updated_at = ? WHERE id = ?",
            (utc_now(), run_id),
        )
        connection.commit()
        emit_progress(connection, run_id, args.progress_file)
        return 130
    except BaseException:
        connection.execute(
            "UPDATE catalog_run SET status = 'interrupted', updated_at = ? WHERE id = ?",
            (utc_now(), run_id),
        )
        connection.commit()
        emit_progress(connection, run_id, args.progress_file)
        raise
    finally:
        connection.close()


def status_command(args: argparse.Namespace) -> int:
    connection = connect(args.database)
    try:
        run_id = args.run_id
        if not run_id:
            row = connection.execute("SELECT id FROM catalog_run ORDER BY started_at DESC LIMIT 1").fetchone()
            if not row:
                raise SystemExit("no catalog runs exist")
            run_id = str(row["id"])
        print(json.dumps(status_payload(connection, run_id), ensure_ascii=False, indent=2, sort_keys=True))
        return 0
    finally:
        connection.close()


def summary_command(args: argparse.Namespace) -> int:
    connection = connect(args.database)
    try:
        run_id = args.run_id
        if not run_id:
            row = connection.execute("SELECT id FROM catalog_run ORDER BY started_at DESC LIMIT 1").fetchone()
            if not row:
                raise SystemExit("no catalog runs exist")
            run_id = str(row["id"])
        print(json.dumps(build_summary(connection, run_id), ensure_ascii=False, indent=2, sort_keys=True))
        return 0
    finally:
        connection.close()


def add_common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--database", required=True)
    parser.add_argument("--run-id")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Build a path-complete SQLite media assessment catalog.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    run = subparsers.add_parser("run")
    add_common(run)
    run.add_argument("--progress-file")
    run.add_argument("--summary-file")
    run.add_argument("--include-root", action="append", default=[])
    run.add_argument("--reference-root", action="append", default=[])
    run.add_argument("--defer-root", action="append", default=[])
    run.add_argument("--exclude-root", action="append", default=[])
    run.add_argument("--exclude-name", action="append", default=[])
    run.add_argument("--defer-component", action="append", default=[])
    run.add_argument("--exiftool", default="exiftool")
    run.add_argument("--ffprobe", default="ffprobe")
    run.add_argument("--batch-size", type=int, default=50)
    run.add_argument("--progress-seconds", type=float, default=10.0)
    run.set_defaults(func=run_command)

    status = subparsers.add_parser("status")
    add_common(status)
    status.set_defaults(func=status_command)

    summary = subparsers.add_parser("summary")
    add_common(summary)
    summary.set_defaults(func=summary_command)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
