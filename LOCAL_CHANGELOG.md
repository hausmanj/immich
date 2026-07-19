# Local Changelog

This file tracks local-only changes in this checkout that have not necessarily been pulled from upstream Immich.

## 2026-07-19 - LLM Plugin Architecture Investigation

- Added `docs/local-llm-plugin-investigation-2026-07-19.md`.
- Investigated Immich's current plugin/workflow subsystem for adding Claude/OpenAI-style capabilities directly inside Immich.
- Key finding: Immich already supports Extism/WASM workflow plugins, external plugin import, workflow templates, host functions, and controlled outbound HTTP requests.
- Key constraint: current plugin payloads include asset metadata and original server paths, but do not expose thumbnail/preview/original media bytes or signed media URLs to plugins.
- Recommended path: extend plugin host functions with controlled preview/thumbnail access and server-managed LLM provider adapters before building a `packages/plugin-llm` plugin.

## 2026-07-19 - iOS Original-File Backup Investigation

- Added root `AGENTS.md` with local workspace guidance, including that iPhone/simulator testing is available.
- Upgraded mobile `photo_manager` from `3.9.0` to `3.10.0`.
  - Reason: `3.10.0` adds Darwin APIs for `AssetEntity.darwin.hasAdjustments` and `AssetEntity.darwin.getBaseFile()`.
  - Source: https://pub.dev/packages/photo_manager/changelog
- Updated iOS upload file extraction to:
  - detect Photos-adjusted assets;
  - attempt unedited base-file export;
  - log detailed adjusted-asset decisions;
  - fall back to the existing original-file export path instead of silently skipping content.
- Updated iOS native resource selection for hashing to prefer unedited original resources before rendered/current resources.
  - Partially adopted from upstream draft PR #28543: https://github.com/immich-app/immich/pull/28543
  - Only the safer native original-resource ordering idea was adopted; the full original+edited stacking behavior was not merged.
- Applied upstream PR #29351 locally: https://github.com/immich-app/immich/pull/29351
  - iOS now treats wired Ethernet as unmetered when the OS path is not cellular, expensive, or constrained.
- Added investigation notes:
  - `mobile/ios/unedited-original-upload-investigation.md`
  - `mobile/ios/open-pr-triage-2026-07-19.md`

### Verification

- `git diff --check` passed.
- Flutter/Dart tests were not run in the shell because `flutter`, `dart`, and `mise` were not available on `PATH`.
- iPhone/simulator testing is available and should be used for the next validation pass.
