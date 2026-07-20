# Local LLM Plugin Investigation - 2026-07-19

This note records the first pass on adding Claude/OpenAI-style capabilities directly into Immich.

## Current Immich Plugin Surface

Immich already has a first-class plugin/workflow subsystem:

- Plugins are WebAssembly modules loaded with Extism.
- The built-in plugin lives in `packages/plugin-core`.
- External plugins are imported at server bootstrap when `IMMICH_ALLOW_EXTERNAL_PLUGINS` is enabled and `IMMICH_PLUGINS_INSTALL_FOLDER` points at plugin folders.
- A plugin folder must contain `manifest.json`; the manifest declares `name`, `version`, `wasmPath`, `methods`, optional workflow `templates`, method schemas, `hostFunctions`, and `allowedHosts`.
- Plugin methods are exposed through workflow steps. Current workflow triggers are `AssetCreate` and `AssetMetadataExtraction`.
- Current workflow event type is `AssetV1`.

Important local references:

- `server/src/services/workflow-execution.service.ts`
- `server/src/dtos/plugin-manifest.dto.ts`
- `server/src/dtos/plugin.dto.ts`
- `server/src/repositories/plugin.repository.ts`
- `server/src/repositories/workflow.repository.ts`
- `packages/plugin-sdk/src/types.ts`
- `packages/plugin-sdk/src/host-functions.ts`
- `packages/plugin-core/src/index.ts`
- `packages/plugin-core/manifest.json`

## What Plugins Can Do Today

Current host functions available to plugin methods:

- `searchAlbums`
- `createAlbum`
- `addAssetsToAlbum`
- `addAssetsToAlbums`
- `httpRequest`

`httpRequest` is gated by the plugin method's `allowedHosts` manifest value. A direct OpenAI/Anthropic plugin could call external provider APIs today if the plugin enables host functions and lists the relevant hostnames.

Current `AssetV1` workflow payload includes:

- asset id, owner id, type, original server path, original filename, timestamps, checksum, stack/duplicate IDs, visibility, and `isEdited`
- EXIF-like metadata such as make/model, dimensions, file size, dates, GPS/city/state/country, description, rating, tags, and timezone

Current workflow writes can update only a narrow asset surface:

- favorite state
- visibility
- date/time original
- longitude/latitude
- description
- rating

Album organization is possible through existing host functions.

## Main Constraint

A pure plugin does not currently receive image bytes, thumbnail bytes, preview bytes, or a signed internal media URL. It receives metadata and filesystem path strings.

That means:

- metadata-only LLM classification is possible today;
- direct vision analysis of the photo/video itself is not cleanly possible as a normal plugin today;
- exposing raw `originalPath` to a WASM plugin is not enough unless WASI filesystem access is deliberately mounted and secured, which is riskier than adding explicit host functions.

## Provider Reality Check

For Immich, "Claude/ChatGPT plugin" should probably mean "LLM provider integration" inside Immich workflows, not a ChatGPT App as the first step.

OpenAI:

- The current OpenAI guidance recommends the Responses API for new projects.
- The Responses API supports multimodal image input and structured JSON output, which maps well to asset captions, tags, and organization suggestions.
- Relevant docs:
  - https://developers.openai.com/api/docs/guides/migrate-to-responses
  - https://developers.openai.com/api/docs/guides/images-vision
  - https://developers.openai.com/api/docs/guides/structured-outputs

Anthropic:

- Claude's Messages API supports image inputs.
- Claude supports tool use and strict JSON-schema-constrained tool inputs.
- Relevant docs:
  - https://platform.claude.com/docs/en/build-with-claude/vision
  - https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use

ChatGPT Apps SDK:

- This is a separate integration shape: expose Immich tools to ChatGPT with an MCP server and optional UI component.
- That would put the user experience in ChatGPT, not directly inside Immich.
- Relevant docs:
  - https://developers.openai.com/apps-sdk

## Architecture Options

### Option 1: Metadata-Only Plugin

Build a new WASM plugin using only existing host functions.

Capabilities:

- classify assets by filename, date, location, camera metadata, existing description, tags, and `isEdited`;
- call OpenAI/Anthropic using `httpRequest`;
- add assets to albums;
- update description/rating through workflow changes.

Advantages:

- Smallest implementation.
- No server API or host-function changes.
- Good for quick proof of concept.

Problems:

- No vision analysis, so the model cannot actually inspect photo content.
- Provider API keys would likely live in workflow-step config unless we add a safer secret mechanism.
- Large-library automation would be weak because it would organize from metadata only.

### Option 2: Add Asset Media Host Functions

Extend the plugin host API with explicit, audited media access.

Candidate host functions:

- `getAssetThumbnailDataUrl(assetId, options)`
- `getAssetPreviewDataUrl(assetId, options)`
- `getAssetOriginalInfo(assetId)`
- `getAssetOriginalDataUrl(assetId, options)` only behind an explicit unsafe/expensive opt-in
- `upsertTags(tags)`
- `addTagsToAsset(assetId, tagIds)`
- `updateAssetMetadata(assetId, patch)`
- `writeWorkflowAuditLog(entry)`

Recommended defaults:

- Send generated preview/thumbnail, not original bytes.
- Cap image dimensions and bytes.
- Require per-workflow opt-in for external provider calls.
- Record provider, model, asset id, asset checksum, prompt template version, response id if available, and every mutation.
- Dry-run by default for new workflows that can change tags/albums/descriptions.

This is the best path if the goal is directly inside Immich and useful for large library organization.

### Option 3: Native LLM Provider Service

Add a server-managed LLM service and let workflow/plugin steps call it indirectly.

Shape:

- `LlmProvider` interface in the server.
- OpenAI and Anthropic adapters.
- API keys stored outside plugin config, ideally in encrypted server config or environment variables for a first local-only patch.
- A host function such as `analyzeAssetWithLlm(assetId, request)` that returns structured suggestions.

Advantages:

- Avoids leaking API keys into plugin WASM config.
- Centralizes rate limits, retries, privacy controls, model selection, and logs.
- Easier to test and support than making every plugin implement provider details.

Tradeoff:

- More server code than a pure plugin.

### Option 4: ChatGPT App / MCP Server For Immich

Expose Immich as a ChatGPT app so ChatGPT can search assets/albums and propose changes.

Advantages:

- Good conversational UX.
- Useful for ad hoc curation and manual review.

Problems:

- It is not "directly inside Immich."
- Requires external reachability or a secure tunnel, OAuth/auth work, and careful photo privacy boundaries.
- Not the right first step for automatic large-library processing.

## Recommendation

Start with Option 2 plus the server-side parts of Option 3:

1. Add minimal plugin host functions for safe media access and audit logging.
2. Add a server-managed provider abstraction for OpenAI/Anthropic instead of putting API keys in workflow-step JSON.
3. Build one local plugin package, likely `packages/plugin-llm`, with templates such as:
   - "Suggest description for new assets"
   - "Tag assets for review"
   - "Create event albums from new uploads"
   - "Flag screenshots/receipts/documents"
4. Make the first implementation dry-run/review-first:
   - write suggestions to logs or a review table;
   - optionally create an "AI Review" album;
   - do not auto-delete, skip, or rewrite originals.

This preserves the existing workflow/plugin design while adding the one capability plugins currently lack: controlled access to asset visual content.

## Implemented Local Prototype

Commit-in-progress implementation follows the recommended Option 2 plus the server-managed parts of Option 3.

Added:

- `packages/plugin-llm`
- server host function `getAssetPreviewDataUrl`
- server host function `analyzeAssetWithLlm`
- server host function `writeWorkflowAuditLog`
- OpenAI Responses API adapter
- Anthropic Messages API adapter
- built-in plugin import list for `immich-plugin-core` and `immich-plugin-llm`
- plugin SDK host-function bindings for the new functions

Configuration is environment-variable based for the local prototype:

- `IMMICH_LLM_PROVIDER=openai|anthropic`
- `IMMICH_LLM_OPENAI_API_KEY`
- `IMMICH_LLM_OPENAI_MODEL`
- `IMMICH_LLM_ANTHROPIC_API_KEY`
- `IMMICH_LLM_ANTHROPIC_MODEL`

The first plugin method is `assetSuggestDescription`. It runs from the `AssetMetadataExtraction` workflow trigger, sends the generated preview image plus selected asset metadata to the server-managed provider adapter, asks for strict JSON with `description`, `tags`, and `confidence`, and logs every decision with asset id, filename, `isEdited`, provider/model result, and dry-run status.

The workflow template defaults to:

- dry run enabled
- only process assets whose description is empty
- use preview media, not originals
- no content deletion or upload skipping

Failure behavior:

- missing API key returns `status: disabled`
- provider/media errors return `status: error`
- the plugin writes an audit log entry and returns no asset mutation
- the workflow does not randomly skip or delete source content

## Relationship To iPhone Original Upload Work

The original-file iPhone upload problem should stay in the mobile/native upload path. An LLM plugin should not decide whether to skip edited/original assets during upload.

The LLM work can help after upload:

- detect likely screenshots, documents, memes, receipts, blurry photos, and events;
- propose descriptions and tags;
- create review albums;
- identify assets whose upload/original status deserves manual audit.

It should not be used as a guard that randomly prevents content from uploading.

## Logging Requirements

Any LLM workflow should log enough to audit every decision:

- workflow id and step id
- asset id
- owner id
- original filename
- asset checksum
- `isEdited`
- media variant sent: thumbnail, preview, or original
- provider and model
- provider request/response id when available
- token/input image sizing metadata when available
- prompt template version
- parsed structured response
- mutations applied, or dry-run mutations that would have been applied
- error/fallback path

No asset should be skipped because an LLM call fails. Failures should return `workflow.continue: false` or no changes, with a log entry.

## Open Questions

- Should API keys be environment variables for the first local patch, or should we add encrypted server config first?
- Should AI suggestions be stored in existing asset descriptions/tags, or in a separate review/provenance table?
- Should first-pass vision use thumbnails/previews only, or allow original upload behind an explicit per-workflow setting?
- Do we want OpenAI and Anthropic in the first patch, or one provider first with an adapter interface prepared for the second?
- Should this ship as an external plugin in `IMMICH_PLUGINS_INSTALL_FOLDER`, or as a new built-in plugin package next to `plugin-core`?

## Proposed First Patch

Minimal production-minded prototype:

1. Add server host function `getAssetPreviewDataUrl(assetId, { maxSize, quality })`.
2. Add server-managed `LlmRepository`/`LlmService` with provider adapters and env-based API keys for local testing.
3. Add host function `analyzeAssetWithLlm(assetId, request)` returning strict structured JSON.
4. Add `packages/plugin-llm` with one method:
   - `assetSuggestDescription`
   - trigger: `AssetMetadataExtraction`
   - input: preview image plus selected EXIF metadata
   - output: description suggestion
   - default: dry run or only update empty descriptions
5. Add workflow execution tests for success, provider failure, disabled/no-key behavior, and no-skip fallback.
6. Add web UI copy only if needed by existing workflow schema rendering; otherwise use JSON-schema config first.
