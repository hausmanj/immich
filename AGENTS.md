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
  - When a field is absent from the assistant context, call it "not visible in the assistant sample" rather than missing from the source file or database.
  - Prefer metadata audits and review plans over irreversible library reorganization.
  - Assistant action cards in the web UI may create review albums only from explicit sampled `assetIds`. Broad cohort/folder/search ideas should stay as proposals or search links until reviewed.
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
- Mobile validation is still pending because `flutter` and `dart` were not on PATH in this shell. Do not claim the mobile upload patch is device-verified until it has run on iPhone or iOS Simulator.
- Next practical test after import: ask the in-app Codex assistant to audit `/external/desktop-icloud-originals` for original-file evidence, then compare sampled external-library assets against the Desktop export by filename, size, dimensions, EXIF dates/GPS/camera fields, and checksum.
- If the assistant returns an album/review action with concrete `assetIds`, the web UI should show a `Create review album` button. This is the only current in-app organization mutation path and should remain reversible.

## Repo Hygiene

- Do not overwrite unrelated local changes.
- Do not merge large upstream PRs into this workspace without reviewing scope and risk first.
- For open PR triage, record decisions in a dated note under `mobile/ios/` when the topic is iOS backup/original handling.
