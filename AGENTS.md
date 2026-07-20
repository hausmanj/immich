# AGENTS.md

## Local Context

- This checkout is used for investigating Immich mobile/iOS behavior, especially backup reliability and original-file handling from iPhone Photos.
- Do not assume mobile/iOS changes are untestable locally. The user has iPhone/simulator testing available and has used it recently.
- Before finalizing iOS/mobile changes, try to run or ask to run the app on the available iPhone/simulator path when toolchain access is present.

## Current iOS Original-File Experiment

- The local patch is intentionally conservative: prefer unedited iOS Photos base files when available, log adjusted-asset decisions in detail, and fall back to the existing export path rather than silently skipping content.
- The user's Desktop export at `/Users/johnhausman/Desktop/Exported ICloud Photos - DO NOT DELETE` is a known-good Apple Photos "Export Unmodified Original" reference set. Treat it as ground truth for comparing iPhone/mobile upload output.
- The reference export is mounted read-only in the Immich dev server container at `/external/desktop-icloud-originals`.
- Observed reference export profile:
  - about 2.7 GB;
  - 56 date-named folders;
  - 1,822 `.JPG` files, 2 `.MOV` files, and one `.DS_Store`;
  - no `.AAE`, `.XMP`, or `.JSON` sidecars found in the initial scan;
  - sampled JPEGs preserve EXIF camera make/model, image dimensions, `DateTimeOriginal`, `CreateDate`, `ModifyDate`, and orientation;
  - sampled MOVs preserve QuickTime creation dates, dimensions, duration, and media type.
- Locally adopted changes:
  - `photo_manager` package updated from `3.9.0` to `3.10.0` in `mobile/pubspec.yaml` and `mobile/pubspec.lock`.
  - Full local adoption of upstream PR #29351, `fix(mobile): treat wired ethernet as unmetered on ios`.
  - Partial local adoption of upstream PR #28543, `feat(mobile): stack edited photos and bursts on ios`: only the safer native original-resource ordering idea was used. The full draft PR was not merged.
- Current in-progress mobile metadata enhancement:
  - iOS uploads carry a structured original-export audit in `mobile-app` asset metadata, including `originalUploadSource`, `hasAdjustments`, `usedBaseOriginal`, `usedFallback`, `uploadFileName`, `uploadFileSizeBytes`, dimensions, and duration.
  - Foreground and background upload paths should log `iOS original upload metadata` for comparison against the Desktop untouched-original export.
  - Background upload duration should be preserved instead of hard-coded to `0`.
- Current in-progress assistant context enhancement:
  - The in-app assistant is expected to see enough sampled asset context to reason about original-file integrity: checksum, source/original path, library ID, external-library flag, MIME type, file timestamps, upload/update timestamps, dimensions, duration, offline/edited state, EXIF file size, EXIF dates, timezone, orientation, GPS, camera/lens fields, and `mobile-app` asset metadata.
  - The assistant also gets deterministic full-library audits from `AssetRepository`: source-folder cohorts, capture-date cohorts, camera cohorts, location cohorts, checksum-algorithm cohorts, content-checksum duplicate candidates, matching file-trait duplicate candidates, video metadata cohorts, and mobile original-upload metadata cohorts.
  - External-library assets currently use `checksumAlgorithm=sha1-path`; treat those checksums as source-path identity, not byte-level original-file integrity. Only `checksumAlgorithm=sha1` is content-checksum evidence.
  - When a field is absent from the assistant context, call it "not visible in the assistant sample" rather than missing from the source file or database.
  - Prefer metadata audits and review plans over irreversible library reorganization.
  - Assistant action cards in the web UI may create review albums from explicit sampled `assetIds` or deterministic `cohortType`/`cohortKey` pairs. Broad cohort/folder/search ideas should stay as proposals or search links until reviewed.
  - Deterministic cohorts include `event` cohorts for multi-day place/trip groupings. Prefer these over daily `date` cohorts when organizing same-location travel or multi-day events.
  - `POST /assistant/review-album` materializes cohort-backed review albums server-side.
  - Any assistant mutation must have a persisted pre-change journal before it runs. The current journal directory is `/data/assistant-audits/change-journal`, which maps through the existing Docker/Synology `/data` volume.
  - The change journal format is intentionally generic: `actionType`, `status`, `request`, `before`, `after`, `undo`, target IDs, and any error/undo result.
  - `GET /assistant/mutation-capabilities` lists assistant mutation categories and whether apply/undo is supported.
  - `POST /assistant/mutation` can plan every requested capability and writes a journal before any apply attempt.
  - Apply + typed undo are currently enabled for `metadata_edit`, `archive_favorite`, and `stack_change`.
  - `folder_move` and `duplicate_resolution` are registered as capabilities but apply-blocked until typed undo is implemented for filesystem/database path rollback and duplicate trash/metadata/album/tag merge rollback.
  - `POST /assistant/undo` supports assistant-created review albums plus journaled metadata/favorite/archive/stack changes. Source assets are not deleted by these undo paths.
  - Runtime fix applied after initial assistant chat failure: assistant cohort SQL expressions must be inserted with trusted internal `sql.raw(...)` strings, while user-provided `cohortKey` values remain parameterized. The prior `RawBuilder` interpolation generated `(undefined) as key` at runtime.
  - `POST /assistant/tool` runs read-only deterministic assistant tools:
    - `metadata_search`: owner-scoped SQL search with path/name/extension/type/date/camera/location/GPS/mobile/checksum filters.
    - `content_hash_audit`: reads `originalPath` bytes and computes fresh SHA1 for byte-level evidence; does not treat `sha1-path` as content evidence.
    - `sidecar_pair_audit`: scans owned asset source directories for AAE/XMP/JSON sidecars, MOV paired media, and probable rendered/variant filename groups.
    - `mobile_original_compare`: compares mobile-upload audit metadata against the Desktop original reference cohort by filename, file size, dimensions, EXIF date, and camera fields.
  - Assistant tools must not impose scan/result caps. They should process every owner-scoped matching asset and preserve every tool result/error. Do not reintroduce default `limit` behavior for these tools.
  - Large assistant tool outputs are written as full JSON audit logs under `/data/assistant-audits` inside the Immich server container. On Docker/Synology this is expected to live under the existing host folder mapped to container `/data`, for example `/volume1/docker/immich/library/assistant-audits` when `/volume1/docker/immich/library:/data` is the compose mount.
  - The web/chat payload may omit inline row-level results when the audit log is written, but the log file must contain the complete result/error arrays and the response must report the full `resultCount`, `errorCount`, and `logFilePath`.
  - Assistant action cards can now include `toolType`/`toolInput`; the web UI shows a read-only audit/search button and appends tool results back into the chat.
  - Inline assistant tool results should stay human-readable. The web formatter groups sidecar/variant results and summarizes asset rows by filename, size, dimensions, timestamp, camera/edited flags, and source path instead of dumping raw JSON.
  - The Assistant web page persists conversation workflow state in browser localStorage key `immich-assistant-conversation-v1`, including messages, action cards, provider, prompt draft, and assessment. Creating a review album appends the album ID and change-journal path to the chat before navigating away.
  - When reopening or returning to the Assistant web page, the conversation pane should scroll to the latest message after persisted state loads and after new assistant/user/tool output is appended.
- Relevant notes:
  - `mobile/ios/unedited-original-upload-investigation.md`
  - `mobile/ios/open-pr-triage-2026-07-19.md`
- Runtime log markers to preserve/search:
  - `iOS asset has Photos adjustments; attempting unedited base export`
  - `Using unedited base file for adjusted iOS asset`
  - `Unable to export unedited base file for adjusted iOS asset; falling back to existing original-file export to avoid skipping content`
  - `Adjusted iOS asset fallback export result`
  - `iOS original upload metadata`

## Testing Guidance

- Preferred validation for iOS backup/original-file work:
  - build/run the mobile app on iPhone or iOS Simulator when Flutter/Xcode tooling is available;
  - use a Photos library sample with at least one edited asset, one unedited asset, and if possible an iCloud/Optimize Storage case;
  - export Immich logs and inspect the markers above;
  - compare uploaded output against known-good originals from the Desktop export and/or osxphotos by filename, size, dimensions, EXIF, and checksum.
- For the Desktop reference export in the dev app:
  - use `/external/desktop-icloud-originals` as the external-library import path;
  - keep the mount read-only;
  - do not move, rename, delete, or normalize the source files as part of organization experiments;
  - use organization plans, review queues, albums, and metadata audits first.
- Simulator testing is useful for app flow, logging, and Photos import behavior. Physical-device testing is still preferable for iCloud Photos and Optimize iPhone Storage edge cases.

## Reopen Checkpoint

- Start by reading `AGENTS.md` and `LOCAL_CHANGELOG.md`; the latter is the local change log the user asked to keep.
- The local dev Docker stack has been used successfully with Docker Desktop running.
- The host CLI bridge for in-app Claude/Codex assistance is `tools/assistant-cli-bridge.mjs`, expected on `http://127.0.0.1:3737`; `docker/.env` points the Claude and Codex assistant providers at `host.docker.internal:3737`.
- Never print or commit secrets from `docker/.env`.
- The assistant UI intentionally exposes only Auto, Claude CLI, and Codex CLI; direct OpenAI/Anthropic API providers are kept as backend fallback plumbing.
- Current server validation passed with:
  - `/Users/johnhausman/.local/pnpm/node_modules/.bin/pnpm --filter immich run check`
  - `/Users/johnhausman/.local/pnpm/node_modules/.bin/pnpm --filter immich run lint`
  - `git diff --check`
- After the deterministic-audit upgrade, the in-app assistant successfully returned full-library chat output for `/external/desktop-icloud-originals`: 1,824 external assets, 1,822 images, 2 videos, 2010-04-22 through 2012-12-27, 2.92 GB, 228 GPS-backed assets, and 1,596 assets with no visible location.
- After assistant tool upgrade:
  - Full Desktop-originals byte-hash audit completed for 1,824/1,824 assets with zero file read errors and zero exact byte-duplicate groups.
  - Full Desktop-originals sidecar/pair audit scanned 56/56 directories with zero AAE/XMP/JSON sidecars and zero sidecar errors.
  - Sidecar/pair audit found 8 probable filename variant groups under `/external/desktop-icloud-originals/Feb 16, 2011`, involving paired names such as `IMG_4596.JPG` and `IMG_4596(1).JPG`; those are review candidates, not automatic duplicates.
  - `mobile_original_compare` currently returns zero mobile cohorts for the Desktop external import because `mobile-app` metadata is not present on these external-library assets.
- After no-limit tool update:
  - `content_hash_audit` over `/external/desktop-icloud-originals` returned `complete=true`, `scannedAssets=1824`, `hashedAssets=1824`, `errorCount=0`, and `resultCount=1824`.
  - Cohort-backed review album actions no longer cap cohort size; they materialize every matching asset ID.
- After log-backed tool update:
  - Large tool output is compacted in the chat/API response but not skipped; the full result/error arrays are written to `/data/assistant-audits`.
  - Verified probe: `/external/desktop-icloud-originals` hash audit wrote `/data/assistant-audits/2026-07-20T11-36-08-089Z-content_hash_audit-6e99b3f4-2bb7-4ec7-b325-5fce710837d7.json` with 1,824 result rows, 0 error rows, and 856,341 bytes.
- After assistant undo-safety update:
  - Review-album creation writes a pre-change journal before creating the album, then updates it with the created album ID and undo strategy.
  - Verified probe: created `Codex undo smoke test album` with one asset, wrote `/data/assistant-audits/change-journal/2026-07-20T11-56-32-703Z-assistant_review_album_create-3d7a919a-f1e2-40d6-bf5f-5a56b0dae95b.json`, then `POST /assistant/undo` deleted the album and updated the journal to `status=undone`.
- After mutation capability update:
  - Verified `GET /assistant/mutation-capabilities` returns `metadata_edit`, `archive_favorite`, `stack_change`, `folder_move`, and `duplicate_resolution`.
  - Verified duplicate-resolution apply is blocked and journaled while undo is unavailable.
  - Verified `archive_favorite` apply on asset `9f6e56f5-a1a9-40ce-ac87-8fa3aa3d2515` changed favorite state, then `POST /assistant/undo` restored `isFavorite=false` and `visibility=timeline` from the journal.
  - Verified `stack_change` create with assets `cf47e24a-a465-4315-a95b-dc9de04bf1c3` and `af88efde-f81d-4862-9991-7b29cef66c1f`, then `POST /assistant/undo` deleted the created stack and restored both assets to `stackId=null`.
  - After event/trip cohort update:
    - `deterministicAudits.eventCohorts` identifies multi-day exact-place, region, and country trip candidates with date span, active-day count, location-backed asset count, confidence, and `cohortType='event'`.
    - The assistant prompt now explicitly avoids daily album splits when a higher-confidence event cohort covers the same trip/location span.
    - Verified runtime behavior: the assistant identified `French Polynesia / Leeward Islands` from 2012-10-15 through 2012-10-19 as one event cohort with 164 assets and returned an actionable `cohortType='event'`.
    - Verified event cohort materialization: created a temporary 164-asset review album from that event key, then `POST /assistant/undo` deleted the album without deleting source assets.
  - Event/trip cohort follow-up after Bora Bora review issue:
    - The original event materialization was too GPS/place-literal and created a 164-asset French Polynesia review album that excluded no-location same-trip photos.
    - Event cohorts are now GPS/place-anchored but materialize compatible no-location assets in the event date span plus assets in source folders anchored by the place evidence.
    - Direct database verification for French Polynesia / Leeward Islands showed the corrected materialized review cohort is 551 assets: 164 GPS/place anchors, 387 no-location support assets, and source-folder carryover through 2012-10-20.
    - Adjacent 2012-10-21 has 11 no-location assets in its own source folder and should be called out as a separate review candidate unless more evidence ties it to the same trip.
    - Assistant action cards become stale after a newer user message; old create/run buttons should not stay executable for a different user request.
- Temporary local Codex assistant smoke-test API keys were created only for probing and deleted afterward.
- Mobile validation is still pending because `flutter` and `dart` were not on PATH in this shell. Do not claim the mobile upload patch is device-verified until it has run on iPhone or iOS Simulator.
- Next practical test after import: ask the in-app Codex assistant to audit `/external/desktop-icloud-originals` for original-file evidence, then compare sampled external-library assets against the Desktop export by filename, size, dimensions, EXIF dates/GPS/camera fields, and checksum.
- If the assistant returns an album/review action with concrete `assetIds` or `cohortType`/`cohortKey`, the web UI should show a `Create review album` button. This is the only current in-app organization mutation path and should remain reversible.

## Repo Hygiene

- Do not overwrite unrelated local changes.
- Do not merge large upstream PRs into this workspace without reviewing scope and risk first.
- For open PR triage, record decisions in a dated note under `mobile/ios/` when the topic is iOS backup/original handling.
