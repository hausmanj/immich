# AGENTS.md

## Local Context

- This checkout is used for investigating Immich mobile/iOS behavior, especially backup reliability and original-file handling from iPhone Photos.
- Do not assume mobile/iOS changes are untestable locally. The user has iPhone/simulator testing available and has used it recently.
- Before finalizing iOS/mobile changes, try to run or ask to run the app on the available iPhone/simulator path when toolchain access is present.

## Current iOS Original-File Experiment

- The local patch is intentionally conservative: prefer unedited iOS Photos base files when available, log adjusted-asset decisions in detail, and fall back to the existing export path rather than silently skipping content.
- Locally adopted changes:
  - `photo_manager` package updated from `3.9.0` to `3.10.0` in `mobile/pubspec.yaml` and `mobile/pubspec.lock`.
  - Full local adoption of upstream PR #29351, `fix(mobile): treat wired ethernet as unmetered on ios`.
  - Partial local adoption of upstream PR #28543, `feat(mobile): stack edited photos and bursts on ios`: only the safer native original-resource ordering idea was used. The full draft PR was not merged.
- Relevant notes:
  - `mobile/ios/unedited-original-upload-investigation.md`
  - `mobile/ios/open-pr-triage-2026-07-19.md`
- Runtime log markers to preserve/search:
  - `iOS asset has Photos adjustments; attempting unedited base export`
  - `Using unedited base file for adjusted iOS asset`
  - `Unable to export unedited base file for adjusted iOS asset; falling back to existing original-file export to avoid skipping content`
  - `Adjusted iOS asset fallback export result`

## Testing Guidance

- Preferred validation for iOS backup/original-file work:
  - build/run the mobile app on iPhone or iOS Simulator when Flutter/Xcode tooling is available;
  - use a Photos library sample with at least one edited asset, one unedited asset, and if possible an iCloud/Optimize Storage case;
  - export Immich logs and inspect the markers above;
  - compare uploaded output against known-good originals from iCloud/osxphotos by filename, size, dimensions, EXIF, and checksum.
- Simulator testing is useful for app flow, logging, and Photos import behavior. Physical-device testing is still preferable for iCloud Photos and Optimize iPhone Storage edge cases.

## Repo Hygiene

- Do not overwrite unrelated local changes.
- Do not merge large upstream PRs into this workspace without reviewing scope and risk first.
- For open PR triage, record decisions in a dated note under `mobile/ios/` when the topic is iOS backup/original handling.
