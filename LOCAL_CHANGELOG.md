# Local Changelog

This file tracks local-only changes in this checkout that have not necessarily been pulled from upstream Immich.

## 2026-07-19 - In-App Library Assistant Prototype

- Runtime follow-up after importing the Desktop originals:
  - Fixed assistant cohort SQL generation after chat produced `column "undefined" does not exist`.
  - Cause: Kysely raw SQL fragments used for dynamic full-library audit cohorts were interpolated incorrectly inside a larger raw query.
  - Fix: cohort SQL is now selected from trusted internal string helpers and inserted with `sql.raw(...)`; user-provided cohort keys remain parameterized.
  - Restarted `immich-server`; server startup logs were clean.
  - The in-app assistant subsequently returned a full deterministic audit for `/external/desktop-icloud-originals`, including 1,824 external assets, 1,822 images, 2 videos, 2.92 GB, date span 2010-04-22 through 2012-12-27, source/date/camera/location cohorts, duplicate-candidate status, and cohort-backed review album actions.
  - A temporary local API key named `Codex local assistant smoke test` was created for probing and deleted afterward.
- Added a first-pass authenticated Immich web assistant at `/assistant`.
  - Sidebar entry: `Assistant`.
  - UI behavior: full-library assessment panel plus chat-style interaction inside Immich.
  - Current behavior is review-first. It can create reversible review albums only through explicit assistant action cards; it does not move, delete, tag, or rewrite source files automatically.
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
- Added server-side assistant search/identification audits that run before each chat response.
  - Full-library audit summary: image/video/favorite/archive/edited/external counts, EXIF/GPS/file-size/dimension/camera/mobile-app metadata coverage, date span, total file size, and checksum-algorithm counts.
  - Cohort identification: source folder, capture date, camera make/model, location, checksum algorithm, exact content-checksum duplicate candidates, matching file-trait duplicate candidates, video codec/format/pixel-format cohorts, and mobile original-upload metadata cohorts.
  - Follow-up change: added deterministic `event` cohorts for multi-day exact-place, region, and country trip candidates. Event cohorts include date span, active-day count, location-backed asset count, confidence, examples, and actionable `cohortType='event'`/`cohortKey` values.
  - The assistant prompt now prefers event cohorts for multi-day trips and same-location travel, and treats daily date cohorts as fallback review units rather than default trip boundaries.
  - External-library checksum semantics are now explicit: `sha1-path` is path identity, not byte-level file integrity; only `sha1` is content-checksum evidence.
- Added read-only executable assistant tools at `POST /assistant/tool`.
  - `metadata_search` performs owner-scoped deterministic SQL searches with filters for cohort, path, filename, extension, media type, date range, camera, location, missing GPS, unknown camera, mobile metadata, and checksum algorithm.
  - `content_hash_audit` reads original files from disk and computes fresh SHA1 hashes for actual byte-level evidence. It reports completion status, read errors, database checksum comparability, mismatches for true `sha1` rows, and exact byte-duplicate groups.
  - `sidecar_pair_audit` scans source directories for AAE/XMP/JSON sidecars, MOV paired-media candidates, and probable rendered/variant filename groups.
  - `mobile_original_compare` compares mobile-upload metadata cohorts against the Desktop originals reference prefix, using filename, file size, dimensions, EXIF date, make, and model.
  - Tool results are read-only and do not move, delete, tag, or alter source files.
  - Follow-up change: assistant tools no longer impose scan/result limits. If a tool matches 1,824 assets or 100,000 assets, it processes every owner-scoped match and preserves every result/error.
  - Follow-up change: large assistant tool outputs are written as complete JSON audit logs under `/data/assistant-audits` inside the server container, with full `resultCount`, `errorCount`, and `logFilePath` returned to the UI/chat. In Docker and Synology deployments this path should live inside the existing host folder mapped to container `/data`.
- Added assistant action support for executable tools.
  - The LLM action schema now accepts `toolType` and `toolInput`.
  - The web Assistant action cards show audit/search buttons for executable tool proposals.
  - Running a tool appends the deterministic result summary and examples back into the chat.
  - Follow-up change: inline tool results are now formatted by tool type instead of dumped as raw JSON. Sidecar/variant groups show grouped filename, size, dimensions, timestamp, camera/edited flags, and source path lines for review.
  - Follow-up change: the Assistant page now persists conversation workflow state in browser localStorage key `immich-assistant-conversation-v1`, including messages, action cards, provider, prompt draft, and assessment. Review-album creation appends the created album ID and change-journal path to the chat before navigating to the album.
  - Follow-up change: the Assistant conversation pane now scrolls to the latest message after restored state loads and when new user, assistant, or tool messages appear.
- Added a reversible assistant action path in the web UI:
  - Assistant action cards can create a review album only when the action contains explicit sampled asset IDs.
  - Assistant action cards can also create a review album from a deterministic server cohort by sending `cohortType` and `cohortKey` to `POST /assistant/review-album`; the server performs the cohort lookup at click time.
  - Broad searches, metadata audits, original-file audits, and folder plans remain review/search proposals unless concrete asset IDs or a deterministic cohort key are present.
  - Follow-up change: cohort-backed album creation no longer caps asset IDs; it materializes every matching cohort asset.
- Added assistant mutation safety journaling.
  - `POST /assistant/review-album` now writes a pre-change journal before creating the album.
  - Journals are stored under `/data/assistant-audits/change-journal`, so Docker/Synology deployments keep them inside the existing host folder mapped to container `/data`.
  - Each journal records action type, status, request, full target asset IDs, before-state album context, after-state created album context, undo strategy, and errors/undo results when present.
  - Added `GET /assistant/mutation-capabilities` to advertise mutation capability status.
  - Added `POST /assistant/mutation` to plan or apply assistant mutations. It always writes a journal before applying.
  - Apply + typed undo are currently enabled for `metadata_edit`, `archive_favorite`, and `stack_change`.
  - `folder_move` and `duplicate_resolution` are registered capabilities but apply-blocked until typed undo exists for filesystem/database path rollback and duplicate trash/metadata/album/tag merge rollback.
  - Added `POST /assistant/undo` for supported assistant changes. It currently undoes assistant-created review albums plus journaled metadata/favorite/archive/stack changes. Source assets are not deleted by these undo paths.
- Added OpenAPI schema entries for the assistant request/response DTOs.
- The assistant prompt is intentionally review-first:
  - suggest searches, album plans, folder plans, metadata audits, original-file audits, and review sets;
  - do not suggest tagging unless explicitly requested;
  - never claim changes were applied;
  - treat impactful organization changes as requiring read-only evidence first plus a persisted assistant change journal and undo path;
  - avoid deletion suggestions unless explicitly asked.

### Assistant Tool Runtime Probe

- `metadata_search` over `/external/desktop-icloud-originals` with `fileExtension=JPG` returned 1,822 matching assets and explicit truncation for a limited probe.
- Full `content_hash_audit` over `/external/desktop-icloud-originals` completed for 1,824/1,824 assets:
  - `hashedAssets=1824`;
  - `errorCount=0`;
  - `storedSha1ComparableAssets=0` because the imported external library uses `sha1-path`;
  - `exactContentDuplicateGroupCount=0`.
- No-limit tool probe after removing caps:
  - `content_hash_audit` over `/external/desktop-icloud-originals` returned `complete=true`;
  - `scannedAssets=1824`;
  - `hashedAssets=1824`;
  - `resultCount=1824`;
  - `errorCount=0`.
- Log-backed no-limit tool probe:
  - `content_hash_audit` over `/external/desktop-icloud-originals` again returned `complete=true`, `scannedAssets=1824`, `hashedAssets=1824`, `resultCount=1824`, and `errorCount=0`;
  - inline result rows were omitted from the chat/API payload because the full result set was written to `/data/assistant-audits/2026-07-20T11-36-08-089Z-content_hash_audit-6e99b3f4-2bb7-4ec7-b325-5fce710837d7.json`;
  - the JSON log was verified inside `immich_server` at 856,341 bytes with 1,824 `results` rows and 0 `errors` rows.
- Undo-safety runtime probe:
  - Created a one-asset assistant review album named `Codex undo smoke test album`;
  - verified the pre-change journal at `/data/assistant-audits/change-journal/2026-07-20T11-56-32-703Z-assistant_review_album_create-3d7a919a-f1e2-40d6-bf5f-5a56b0dae95b.json`;
  - called `POST /assistant/undo`, which deleted the created album without deleting the source asset and updated the journal to `status=undone`;
  - verified the test album no longer exists in the database.
- Mutation capability runtime probe:
  - `GET /assistant/mutation-capabilities` returned all requested categories: `metadata_edit`, `archive_favorite`, `stack_change`, `folder_move`, and `duplicate_resolution`;
  - `duplicate_resolution` apply returned `status=blocked` and wrote `/data/assistant-audits/change-journal/2026-07-20T12-17-02-688Z-duplicate_resolution-b83f4c3d-a86a-4166-95d9-91bf16e7081c.json`;
  - `archive_favorite` apply changed one test asset and wrote `/data/assistant-audits/change-journal/2026-07-20T12-17-02-693Z-archive_favorite-49c598f9-ff0a-40b8-90d2-04a61fa7ea05.json`;
  - `POST /assistant/undo` restored the test asset to `isFavorite=false` and `visibility=timeline` and updated the journal to `status=undone`.
  - `stack_change` create stacked two test assets and wrote `/data/assistant-audits/change-journal/2026-07-20T12-18-10-100Z-stack_change-750bc028-9ef2-4f11-9d93-62050d62f333.json`;
  - `POST /assistant/undo` deleted the created stack and verified both test assets were restored to `stackId=null`.
- Event/trip cohort runtime probe:
  - Assistant chat identified `French Polynesia / Leeward Islands` from 2012-10-15 through 2012-10-19 as one multi-day event cohort with 164 assets instead of proposing daily albums;
  - the returned action carried `cohortType='event'` and an event JSON `cohortKey`;
  - `POST /assistant/review-album` materialized that event key into a temporary 164-asset review album;
  - `POST /assistant/undo` deleted the temporary event review album without deleting source assets.
- Full `sidecar_pair_audit` over `/external/desktop-icloud-originals` completed:
  - `directoriesScanned=56`;
  - `sidecarFileCount=0`;
  - `sidecarMatchCount=0`;
  - `orphanSidecarCount=0`;
  - `probableRenderedPairCount=8`.
- The 8 probable variant groups are all under `/external/desktop-icloud-originals/Feb 16, 2011` and use names like `IMG_4596.JPG` plus `IMG_4596(1).JPG`. They differ in size and orientation/dimensions and should be treated as review candidates, not automatically skipped duplicates.
- `mobile_original_compare` returned zero mobile cohorts for the current external import, which is expected until iPhone/mobile uploads with `mobile-app` metadata exist.
- Temporary local API keys named `Codex local assistant smoke test`, `Codex local assistant tool smoke test`, `Codex local assistant no-limit smoke test`, `Codex local assistant log smoke test`, `Codex local assistant undo smoke test`, `Codex local assistant mutation smoke test`, and `Codex local assistant stack mutation smoke test` were deleted after probing.

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
