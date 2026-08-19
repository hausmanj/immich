# iPhone Original Capture & Derived-Metadata Backfill Design - 2026-08-19

Status: **DRAFT** for John's review. This note drafts the next phase of the
byte-exact original capture mission (`PROJECT_GUIDE.md` §4): replacing the
osxphotos/iCloud→Mac→NAS workflow with a direct Immich-app-to-server path that
lands untouched originals on the NAS and carries derived metadata in a
server-independent sidecar.

Decisions already agreed (session of 2026-08-19) are marked **[agreed]**;
items still open are listed at the end.

## Purpose

Get unmodified RAW/ProRAW/originals off iPhones directly into Immich without
the lossy iCloud round-trip, such that:

1. Files on the NAS are byte-for-byte what was on the phone.
2. Content stands on its own if/when the Immich server is lost or decommissioned
   — derived data lives beside files on the NAS, not only inside Immich's DB.
3. Assets lacking embedded EXIF (screenshots etc.) get accurate dates from the
   Photos record at extraction time, never overwriting existing values.

## What already exists on this fork (verified 2026-08-19)

No new "watcher" mechanism is needed. Current behavior on
`feat/perceptual-dedup-and-context-checkpoint`:

### Wake-driven sync loop ("the watcher")

- iOS allows no always-on process. The app re-syncs on every foreground/resume
  (`main.dart` lifecycle observer) and via scheduled `BGAppRefreshTask`
  background uploads (~20s budget each).
- Each cycle runs `_localSyncService.sync()` → Swift fetches the whole
  `PHPhotoLibrary` (`ios/Runner/Images/LocalImagesImpl.swift`) → diffs against
  the local drift DB → hashes + uploads new items. Background cycles run
  local/remote sync, hash, and backup concurrently within the budget
  (`lib/domain/services/background_worker.service.dart`, `onIosUpload`).
- iCloud storage optimization handled: cloud-resident assets download through
  `StorageRepository.loadFileFromCloud()` before upload.
- At-home on Wi-Fi/5G this delivers the within-minutes freshness expectation;
  coarse wake-driven polling by design.

### Byte-exact extraction patch (from `mobile/ios/unedited-original-upload-investigation.md`, 2026-07-19)

Stock Immich could hash/upload Photos' *rendered* representation of adjusted
assets instead of the original. This branch already patches it:

- `photo_manager` 3.10.0 Darwin APIs: `hasAdjustments` detection plus
  `getBaseFile()` to export the unedited base file when adjustments exist.
- Hashing reordered to prefer `.photo`/`.video` original resources over
  rendered ones.
- Fallback path uploads something rather than silently skipping if base export
  fails; runtime log markers documented in that investigation doc.
- Upstream PR #29351 adopted fully (wired Ethernet counts as unmetered).
- Upstream PR #28543 adopted **partially** — see Delta 4.

## Ground rules

- Never alter original files or embedded EXIF during materialization/transfer
  (matches the source-album work's rule and the whole point of byte-exactness).
- Every derived field carries a provenance marker so it is auditable and
  idempotent on retry/re-upload.
- Merge rule everywhere: existing value always wins; fill gaps only.

## Delta 1 — Derived-metadata backfill at transfer time **[agreed on priority ladder]**

For each asset, per-field resolution order:

| Priority | Source | Notes |
|---|---|---|
| 1 | Embedded EXIF/IPTC/XMP in the file bytes | Never overwritten. Screenshots/RAWs with data keep it verbatim. |
| 2 | Photos record metadata captured at extraction time (`PHAsset.creationDate`, album identity) | Accurate even offline; record-at-extraction beats transfer-time when upload lags days. |
| 3 | Observed/transfer timestamp | Last resort only, clearly marked as such. |

Explicitly NOT synthesized: location (guessing pollutes hauspix/Immichgo
verification downstream) and camera/device model when unknown — mark absent
rather than invent.

Nothing today writes derived metadata anywhere; files go up byte-as-is. This
delta adds that layer without touching file bytes.

## Delta 2 — Sidecar JSON design **[agreed on concept; schema below is draft]**

Per-asset sidecar produced on-device at extraction/upload time and carried two
ways so content survives Immich's death:

1. **Opaque blob on the asset** — uploaded alongside/attached to the Immich
   asset record (metadata payload), versioned schema.
2. **NAS neighbor file** — hauspix import materializes the same JSON next to
   landed files under `/volume1/photo/master photo library/...` during import.
   If Immich disappears entirely, every NAS file still has its provenance
   neighbor.

Draft schema sketch (field list to firm up):

```json
{
  "schema": "immich-derived/1",
  "sourceAssetId": "<PHLocalIdentifier>",
  "hashes": { "sha1": "...", "blake3": "..." },
  "derivedFields": {
    "dateTimeOriginal": {"value": "...", "provenance": "phAsset.creationDate@extraction"},
    ...
  },
  "neverSynthesized": ["location"],
  "extractedAt": "...",
  "deviceModelKnown": true
}
```

Open detail: exact neighbor-file naming/placement convention on the NAS should
be confirmed against hauspix's `PHOTO_ORGANIZATION_GUIDE.md` before building
the import-side writer.

## Delta 3 — Offline staging policy **[recommendation pending confirmation]**

Extract at upload-time within the existing queue (files already flow through
`StorageRepository`) rather than pre-extracting into app-owned storage at
detection time. Rationale: RAW/ProRAW bursts can be multi-GB over a few days
offline; extracting on demand keeps on-disk footprint minimal and reuses the
existing retry/queue machinery. Consequence: derived metadata is captured at
upload-time from whatever record data is locally available — acceptable since
`creationDate` lives in the local Photos DB, not iCloud.

If on-device headroom ever proves a constraint for offline-first use, revisit
eviction/prioritization policy then.

## Delta 4 — Close out PR #28543 ambiguity **[decision needed]**

The 07-19 investigation adopted only the safer original-resource ordering from
upstream PR #28543 ("stack edited photos and bursts on iOS"); the full
original+edited stacking behavior was deliberately not merged. For this
mission (originals only) that appears correct, but it should be recorded as an
explicit decision so it doesn't linger as ambiguity when upstream diverges
further. Proposed wording: *originals-only by design; do not merge #28543
stacking unless requirements change.*

## Validation plan

1. On-device log-marker check on John's real library: confirm
   `Using unedited base file for adjusted iOS asset` fires where adjustments
   exist (markers listed in the 07-19 investigation doc).
2. Fresh upload of a screenshot/EXIF-less asset through the isolated mobile-test
   stack; verify sidecar JSON produced with priority-ladder provenance and no
   embedded-byte modification (hash compare pre/post transfer).
3. NAS-side neighbor-file materialization dry-run on the safe local dataset
   before touching `/volume1/photo/...`.

## Open questions

- Sidecar neighbor naming/placement convention on the NAS (confirm vs hauspix guide).
- Confirm Delta 3 recommendation (extract at upload-time) is acceptable.
- Record the Delta 4 originals-only decision explicitly.
- Where on the Immich server side does the opaque blob attach (metadata JSON field vs binary attachment) — decide during implementation scoping.
