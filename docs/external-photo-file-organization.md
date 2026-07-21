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
- `apply` refuses plans with conflicts/skipped rows unless `--allow-partial` is passed.
- `apply` never overwrites an existing destination.
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
