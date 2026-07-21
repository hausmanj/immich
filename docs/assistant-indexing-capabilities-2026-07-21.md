# Assistant Indexing Capability Assessment - 2026-07-21

This note captures the current state of the in-app assistant indexing work and the path needed for very large, messy libraries such as the read-only laptop-backup mount.

## Current Immich Indexing

Immich already has a strong asset pipeline once files become assets:

- external library scan imports supported media paths into `asset`;
- metadata extraction populates EXIF, dimensions, dates, GPS, camera fields, video details, sidecars, thumbnails, search, and face/smart-search jobs where enabled;
- duplicate detection exists for normal Immich assets through existing duplicate APIs and `duplicateId`;
- external library checksums are `sha1-path`, so they are source-path identity rather than byte-level file content evidence.

This is enough for normal photo-library operation, but it is not enough for the user's intended "picture hell" workflow where the assistant must classify and organize up to 1M+ mixed files including originals, renders, icons, app assets, message attachments, thumbnails, caches, exported folders, and backups.

## Current Assistant Capabilities

The local assistant prototype currently has these useful pieces:

- Persisted assistant index:
  - `assistant_index_run`
  - `assistant_index_asset`
  - `assistant_index_group`
  - `POST /assistant/index-runs`
  - `GET /assistant/index-runs`
  - `GET /assistant/index-runs/:id`
  - imported asset evidence rows, raw filesystem inventory rows, content SHA1, hash status/errors, inventory kind, noise/risk labels, and evidence JSON;
  - persisted groups for source directory, file extension, camera, location, noise/risk labels, inventory kind, exact content duplicates, file-trait duplicates, variant families, and coverage state.
- `GET /assistant/assessment` loads live Immich metadata and deterministic SQL cohorts.
- Deterministic cohorts include source folder, capture date, camera, location, checksum algorithm, video, mobile metadata, duplicate candidates, and event/trip cohorts.
- `organizationCoveragePlan` covers whole libraries by selecting event cohorts first and then covering remaining source folders.
- `POST /assistant/tool` runs read-only evidence tools:
  - `metadata_search`
  - `content_hash_audit`
  - `sidecar_pair_audit`
  - `mobile_original_compare`
- Large tool results are written to JSON logs under `/data/assistant-audits`.
- Review albums, metadata edits, archive/favorite changes, and stack changes have journaled apply/undo paths.
- Folder moves and duplicate resolution are registered but intentionally apply-blocked until typed undo is implemented.

## Major Gaps

The assistant now has a persisted evidence index with non-blocking execution, but it still needs durable checkpoint/resume and higher-level organization intelligence for 1M+ messy files.

Priority gaps:

- Assistant-owned persisted inventory/index tables now exist for imported asset evidence, raw unimported file inventory, content hashes, duplicate signatures, and first-pass classifications, but not yet for final organization decisions.
- The assistant-owned persisted index now runs in the background after the API creates a run, but it is still in-process. It needs durable queue-backed execution, cancel/resume, restart recovery, and stale-index detection before very large 1M+ runs.
- Content hash evidence is now stored as a reusable index field, but perceptual/near-duplicate signatures are not.
- Raw inventory covers non-imported files under target import roots, but it still needs richer source-tree classification for backup/application/export roots.
- No dedicated classifier for low-value or risky cohorts such as icons, thumbnails, tiny files, app caches, message attachment thumbnails, temporary files, stickers, screenshots, or rendered copies.
- No coverage ledger that proves every indexed asset is assigned to exactly one proposed review bucket or explicitly marked as deferred/noise/risk.
- No confidence model that combines folder provenance, file naming, EXIF, dimensions, file size, camera, GPS, content hash, perceptual similarity, and sidecars.
- No typed undo for duplicate resolution or folder moves, so those must remain apply-blocked.
- Library scan/import jobs currently use very large batches for network-mounted folders; observed laptop-backup import jobs held 10,000 paths each and can overload a Docker/Synology path before rows appear in Immich.
- Assistant conversation persistence is browser-local only; it should become server-side if long-running workflows need to survive browser/session/device changes.

## Recommended Indexing Architecture

Add assistant-owned persisted indexing, separate from irreversible organization actions:

- `assistant_index_run`
  - one row per index/audit run;
  - records owner, library/import path filters, status, progress counters, started/finished timestamps, log path, error counts, and tool version.
- `assistant_index_asset`
  - one row per indexed asset or file candidate;
  - stores asset ID when imported, original path, source library, file size, mtime, extension, MIME/type, dimensions, duration, EXIF dates, GPS, camera fields, Immich checksum semantics, actual content hash when computed, sidecar flags, and classification labels.
- `assistant_index_group`
  - groups related assets/files into candidate events, duplicate sets, rendered/original families, folder cohorts, device/camera cohorts, trips, and noise buckets.
- `assistant_index_finding`
  - stores reviewable findings with severity/confidence, evidence JSON, suggested action, and journal requirements.
- `assistant_coverage_plan`
  - stores a complete proposed organization plan with exactly-once coverage accounting.

The assistant should answer from this index first, and only run expensive tools when the index is stale or missing a required evidence pass.

## Recommended Passes

Build the index in staged, resumable passes:

1. Inventory pass: enumerate files/assets, record paths, sizes, extensions, mtimes, read errors, and import status.
2. Metadata pass: collect Immich/EXIF/video fields and metadata coverage.
3. Source-tree pass: build folder summaries and identify backup/application/export/source roots.
4. Noise pass: classify likely icons, thumbnails, temp files, app caches, stickers, tiny images, and generated preview files.
5. Originality pass: compute content hashes and compare with Immich checksum semantics, file traits, sidecars, and edited/variant filename patterns.
6. Similarity pass: add perceptual hash or smart-search/CLIP based near-duplicate grouping where appropriate.
7. Event pass: cluster by source folder, date span, camera, GPS anchors, and adjacent no-GPS support days.
8. Coverage pass: create a complete review-first organization plan with no unaccounted assets.
9. Mutation planning pass: propose only journaled, undoable actions; leave folder moves and duplicate resolution blocked until undo exists.

## Immediate Implementation Order

1. Convert the in-process background assistant index pass into queued/resumable jobs with cancel/resume and restart recovery.
2. Convert current read-only audit tools into background jobs that write durable indexed evidence and logs.
3. Expand the source-tree/noise classifier for the laptop-backup style library before importing or organizing everything.
4. Add a coverage ledger so the assistant can prove what is covered, deferred, risky, or unclassified.
5. Add perceptual or embedding-backed similarity groups for near duplicates, icons, renders, and thumbnails.
6. Add typed undo for duplicate resolution, then enable duplicate apply only for high-confidence groups.
7. Add typed undo for folder moves before any physical organization feature is enabled.
8. Move assistant conversation/workflow state from browser localStorage to server-side persisted sessions.

## Laptop-Backup Observation

The read-only laptop-backup external library path was accepted by Immich at `/external/laptop-backup/Raw Photo and Video Files`.

During the initial scan, logs showed the library crawler discovering at least 30,000 candidate files in 10,000-file batches, but the library still had zero committed asset rows at the time of inspection. Active BullMQ library jobs contained large `LibrarySyncFiles` payloads with 10,000 paths each, including many probable thumbnails and message attachment files. This supports the need for smaller, resumable, classified indexing before relying on broad external-library import for this data set.
