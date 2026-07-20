# Local Changelog

This file tracks local-only changes in this checkout that have not necessarily been pulled from upstream Immich.

## 2026-07-19 - In-App Library Assistant Prototype

- Added a first-pass authenticated Immich web assistant at `/assistant`.
  - Sidebar entry: `Assistant`.
  - UI behavior: full-library assessment panel plus chat-style interaction inside Immich.
  - Current behavior is read-only; no albums, tags, assets, files, or metadata are changed automatically.
- Added `GET /assistant/assessment` on the server.
  - Requires `asset.read`.
  - Reads indexed metadata/statistics for large-library organization planning.
  - Returns total/type counts, album/unorganized/favorite/archive counts, top year buckets, camera make/model slices, location slices, and review-first findings.
- Added `POST /assistant/chat` on the server.
  - Requires `asset.read`.
  - Samples owned albums, recent assets, unorganized assets, and search statistics.
  - Uses a local assistant CLI command when `IMMICH_ASSISTANT_LOCAL_COMMAND` is configured, otherwise uses the existing LLM env config from the workflow plugin prototype.
  - The local command path executes without a shell, passes the prompt/context over stdin, and expects JSON or plain text on stdout.
  - Supports OpenAI Responses API and Anthropic Messages API.
- Added local assistant CLI env settings:
  - `IMMICH_ASSISTANT_PROVIDER`
  - `IMMICH_ASSISTANT_LOCAL_COMMAND`
  - `IMMICH_ASSISTANT_LOCAL_ARGS`
  - `IMMICH_ASSISTANT_LOCAL_URL`
  - `IMMICH_ASSISTANT_LOCAL_TIMEOUT_SECONDS`
  - `IMMICH_ASSISTANT_CLAUDE_COMMAND`
  - `IMMICH_ASSISTANT_CLAUDE_ARGS`
  - `IMMICH_ASSISTANT_CLAUDE_URL`
  - `IMMICH_ASSISTANT_CLAUDE_TIMEOUT_SECONDS`
  - `IMMICH_ASSISTANT_CODEX_COMMAND`
  - `IMMICH_ASSISTANT_CODEX_ARGS`
  - `IMMICH_ASSISTANT_CODEX_URL`
  - `IMMICH_ASSISTANT_CODEX_TIMEOUT_SECONDS`
- Added `tools/assistant-cli-bridge.mjs`, a host-side bridge for Docker Desktop on macOS.
  - Reason: host-installed `claude` and `codex` are macOS binaries and cannot run directly inside the Linux Immich server container.
  - Bridge endpoints: `/claude`, `/codex`, and `/health` on port `3737`.
  - Local `docker/.env` now points Claude and Codex assistant providers at `host.docker.internal:3737`.
- Added an assistant provider selector in the web UI so chat can explicitly use Auto, Claude CLI, or Codex CLI.
  - Direct OpenAI and Anthropic API paths remain backend fallback plumbing, but are hidden from the Assistant UI to keep the tool focused on local Claude/Codex access.
- Expanded the assistant asset sample context for imported-original audits.
  - Added checksum, original path, library ID, external-library flag, MIME type, file timestamps, upload/update timestamps, dimensions, duration, offline/edited state, EXIF file size, EXIF image dimensions, EXIF date fields, timezone, orientation, GPS coordinates, and camera/lens fields.
  - Added external-library summaries, source-path cohorts with examples, metadata coverage percentages, time buckets, camera/location suggestions, and sampled `mobile-app` asset metadata.
  - Tightened the prompt so the assistant says a field is "not visible in the assistant sample" instead of implying it is missing from the source file or Immich database.
- Added OpenAPI schema entries for the assistant request/response DTOs.
- The assistant prompt is intentionally review-first:
  - suggest searches, album plans, folder plans, metadata audits, original-file audits, and review sets;
  - do not suggest tagging unless explicitly requested;
  - never claim changes were applied;
  - avoid deletion suggestions unless explicitly asked.

### Verification

- Server TypeScript check passed: `pnpm --filter immich run check`.
- Server lint passed: `pnpm --filter immich run lint`.
- Server build passed: `mise run //server:build`.
- OpenAPI spec sync passed: `mise run //server:sync-open-api`.
- Web Svelte check passed: `pnpm --filter immich-web run check:svelte`.
- Web TypeScript check passed: `pnpm --filter immich-web run check:typescript`.
- Web lint passed: `pnpm --filter immich-web run lint`.
- `git diff --check` passed.

## 2026-07-19 - LLM Workflow Plugin Prototype

- Added `packages/plugin-llm`, a built-in workflow plugin prototype for AI-assisted asset descriptions.
  - Template: `suggest-descriptions`.
  - Method: `assetSuggestDescription`.
  - Trigger: `AssetMetadataExtraction`.
  - Default behavior: dry run, only process assets with empty descriptions, and log every skip/suggestion/error.
- Added server-managed LLM environment config:
  - `IMMICH_LLM_PROVIDER=openai|anthropic`
  - `IMMICH_LLM_OPENAI_API_KEY`
  - `IMMICH_LLM_OPENAI_MODEL` default `gpt-5.6-luna`
  - `IMMICH_LLM_ANTHROPIC_API_KEY`
  - `IMMICH_LLM_ANTHROPIC_MODEL` default `claude-sonnet-5`
- Extended workflow plugin host functions:
  - `getAssetPreviewDataUrl`
  - `analyzeAssetWithLlm`
  - `writeWorkflowAuditLog`
- Added server-side OpenAI Responses API and Anthropic Messages API calls behind the `analyzeAssetWithLlm` host function.
- Wired `packages/plugin-llm` into local dev compose mounts and the plugin build task.
- Added config repository tests for LLM env defaults, overrides, and invalid provider handling.
- Updated `docs/local-llm-plugin-investigation-2026-07-19.md` with the implemented prototype details.
- Checked upstream `immich-app/immich` `main` for agent guidance files.
  - No upstream `AGENTS.md` was present.
  - No obvious `CLAUDE`, `Codex`, Copilot, Cursor, or instruction file was present.
  - The only upstream `agent` filename match was `mobile/lib/utils/user_agent.dart`.

### Verification

- Installed workspace dependencies with `pnpm install --frozen-lockfile`.
- Installed and trusted the repo's pinned `mise` toolchain so `extism-js` is available.
- `@immich/sdk` build passed.
- `@immich/plugin-sdk` build passed.
- `@immich/plugin-core` WASM build passed.
- `@immich/plugin-llm` WASM build passed.
- Server TypeScript check passed with `tsc --noEmit`.
- Focused config repository test passed: `src/repositories/config.repository.spec.ts` (36 tests).
- `git diff --check` passed.
- A broad server test attempt was not usable in the sandbox because controller specs tried to bind `0.0.0.0` and failed with `listen EPERM`.

## 2026-07-19 - LLM Plugin Architecture Investigation

- Added `docs/local-llm-plugin-investigation-2026-07-19.md`.
- Investigated Immich's current plugin/workflow subsystem for adding Claude/OpenAI-style capabilities directly inside Immich.
- Key finding: Immich already supports Extism/WASM workflow plugins, external plugin import, workflow templates, host functions, and controlled outbound HTTP requests.
- Key constraint: current plugin payloads include asset metadata and original server paths, but do not expose thumbnail/preview/original media bytes or signed media URLs to plugins.
- Recommended path: extend plugin host functions with controlled preview/thumbnail access and server-managed LLM provider adapters before building a `packages/plugin-llm` plugin.

## 2026-07-19 - iOS Original-File Backup Investigation

- Added root `AGENTS.md` with local workspace guidance, including that iPhone/simulator testing is available.
- Added the user's Desktop Apple Photos "Export Unmodified Original" folder as a read-only dev-server external-library mount:
  - Host path: `/Users/johnhausman/Desktop/Exported ICloud Photos - DO NOT DELETE`
  - Container path for Immich external library import: `/external/desktop-icloud-originals`
  - Initial scan profile: about 2.7 GB, 56 date-named folders, 1,822 JPGs, 2 MOVs, one `.DS_Store`, and no AAE/XMP/JSON sidecars found.
- Upgraded mobile `photo_manager` from `3.9.0` to `3.10.0`.
  - Reason: `3.10.0` adds Darwin APIs for `AssetEntity.darwin.hasAdjustments` and `AssetEntity.darwin.getBaseFile()`.
  - Source: https://pub.dev/packages/photo_manager/changelog
- Updated iOS upload file extraction to:
  - detect Photos-adjusted assets;
  - attempt unedited base-file export;
  - log detailed adjusted-asset decisions;
  - fall back to the existing original-file export path instead of silently skipping content.
- Added structured iOS original-upload audit metadata to foreground and background uploads.
  - Stored in the existing `mobile-app` asset metadata payload.
  - Includes original upload source, adjustment status, base-original/fallback flags, uploaded filename, upload file size, dimensions, and duration.
  - Adds the log marker `iOS original upload metadata`.
- Fixed background upload metadata so video duration is sent from the local asset instead of hard-coded as `0`.
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
