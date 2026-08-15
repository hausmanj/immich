# External Photo File Organization

Use `tools/photo-file-organizer.mjs` for physical file organization outside Immich when the goal is to move or copy specific trips into date-folder structures that match Apple Photos unmodified-original exports.

The default folder format is Apple-style date folders:

```text
Oct 15, 2012/
Oct 16, 2012/
Oct 17, 2012/
```

Planning is read-only:

```bash
node tools/photo-file-organizer.mjs plan \
  --source "/path/to/source/trip/files" \
  --dest "/path/to/originals-folder" \
  --event-name "French Polynesia" \
  --start 2012-10-15 \
  --end 2012-10-20 \
  --plan-file "/path/to/audits/french-polynesia-plan.json"
```

To reconcile backup folders against an existing originals tree, use `reconcile-plan`. This computes content SHA1 hashes for originals and source files. `--originals` is comparison evidence. New keeper candidates go to the separate `--dest` staging tree and matches go to the separate `--duplicates` quarantine tree.

```bash
node tools/photo-file-organizer.mjs reconcile-plan \
  --source "/path/to/backup/folder" \
  --originals "/path/to/photo/originals" \
  --dest "/path/to/photo/staged-new-candidates" \
  --duplicates "/path/to/photo/duplicates" \
  --plan-file "/path/to/audits/backup-reconcile-plan.json"
```

If the source folder does not already have a meaningful event name, pass one explicitly:

```bash
node tools/photo-file-organizer.mjs reconcile-plan \
  --source "/path/to/backup/french-polynesia-files" \
  --originals "/path/to/photo/originals" \
  --dest "/path/to/photo/staged-new-candidates" \
  --duplicates "/path/to/photo/duplicates" \
  --event-name "French Polynesia Leeward Islands" \
  --start 2012-10-15 \
  --end 2012-10-20 \
  --plan-file "/path/to/audits/french-polynesia-reconcile-plan.json"
```

For a detached perceptual run, use the safe launcher. It creates one unique run directory with immutable `plan.json`, mutable-until-complete `progress.json`, append-only `resume.jsonl`, and a new append-only log for every attempt:

```bash
tools/run-photo-file-organizer-safe.sh \
  --artifact-root "/volume1/docker/immich/agent/photo-organizer-runs" \
  --run-label "volume1-pilot" \
  --source "/volume1/photosync/uploads_macbookpro" \
  --originals "/volume1/photosync/originals_clean" \
  --dest "/volume1/photosync/organizer-staging/volume1-pilot" \
  --duplicates "/volume1/photosync/duplicates-quarantine/volume1-pilot" \
  --ffmpeg /usr/local/bin/ffmpeg7
```

If an incomplete attempt stalls, rerun the safe launcher with `--run-dir <exact-run-directory> --resume-run` and the same source/comparison/destination arguments. A completed run cannot be resumed or overwritten.

Apply writes a journal before moving or copying:

```bash
node tools/photo-file-organizer.mjs apply \
  --plan-file "/path/to/audits/french-polynesia-plan.json" \
  --journal-dir "/path/to/audits/journals"
```

Undo reads the journal and reverses completed operations:

```bash
node tools/photo-file-organizer.mjs undo \
  --journal-file "/path/to/audits/journals/2026-...-photo-file-organizer-....json"
```

Safety behavior:

- `plan` never changes source or destination files.
- `reconcile-plan` never changes source, originals, or duplicates files.
- `/volume1/photo/originals` and `/volume1/photosync/originals_clean` are hard protected references. They are comparison-only; planning requires a separate non-protected `--dest`, and `apply`/`undo` reject operations whose source or destination touches either tree.
- `reconcile-plan` treats content SHA1 matches as duplicate evidence; filename/date similarity alone is not enough to move a file to duplicates.
- Plan artifacts use exclusive creation and are never overwritten. Long runs keep all plan/progress/resume artifacts in one unique run directory and use one append-only log per attempt.
- `apply` refuses plans with conflicts/skipped rows unless `--allow-partial` is passed.
- `apply` never overwrites an existing destination.
- `apply` re-checks file size and SHA1, when present, before moving/copying.
- `apply` records each operation in a typed journal before moving/copying.
- `undo` moves files back for move operations.
- `undo` deletes copied files for copy operations only after checking size still matches.
- EXIF dates are preferred when `exiftool` is available; filename dates are the next fallback; file modified time is the last fallback.

Useful options:

- `--mode move|copy`: default is `move`.
- `--folder-format apple-date|year-apple-date|iso-date|year-iso-date`: default is `apple-date`.
- `--extensions jpg,jpeg,heic,mov,mp4`: override the media extension list.
- `--hash`: compute SHA1 evidence during planning.
- `--no-exif`: skip EXIF extraction and use filename/mtime dates.
- `--max-depth N`: limit recursive source scanning depth.
