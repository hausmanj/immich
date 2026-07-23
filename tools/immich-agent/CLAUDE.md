# CLAUDE.md — Immich Photo-Ops Agent (operating memory)

Distilled memory for any Claude/agent session operating on this Immich + Synology photo system. Read this first, then verify specifics against live tools before acting.

## Mission
Run a local AI **operations layer** to assess, dedupe, classify, and organize an extremely large, messy personal photo/video library (target **1–2M assets**). Immich is the UI + database surface; the real source files live on the Synology NAS. This is an operator role, not a chat/tagging assistant: investigate with real tools and produce runbook-grade, reversible plans.

## How the agent runs (architecture)
- The brain is **Claude Code on the Mac (M4 Pro)**, invoked by `tools/assistant-cli-bridge.mjs` (port 3737) in streaming agentic mode (`claude --print --output-format stream-json --verbose`). Runs on the **Claude subscription — NO paid API** (`apiKeySource:"none"`, `rate_limit_event.five_hour`). This is a hard boundary: never route through a paid Anthropic/OpenAI API loop.
- Live agent window: **`<your-Immich-URL>/api/assistant/agent-console`** (must be logged into Immich at that same origin, or paste an Immich API key). Defaults to Claude Opus on first load, but selected engine/model persist in browser localStorage after the user changes them.
- Path: browser → Immich `POST /api/assistant/agent-stream` (SSE proxy) → reverse tunnel `http://172.31.0.1:43737/agent-stream` → Mac bridge → `claude` or `codex`. Needs the launchd bridge (3737) + tunnel (43737) up.
- ChatGPT/Codex is supported through the same bridge with `codex exec --json`. For resume, use `codex exec resume --json ... <sessionId> -`; do **not** pass `-C` to the resume subcommand. The bridge spawns with `cwd=/Users/johnhausman/source/immich`, which is how resume gets the working directory. Verified 2026-07-22: fresh Codex turn returned `first ok`; resumed Codex turn returned `resume ok`; both exit 0.
- The standalone console keeps separate Claude/Codex session IDs. Simple greeting/status prompts (`hello`, `ping`, `can you hear me`, etc.) deliberately do not resume old sessions and use a tiny no-tools prompt, so they should not read memory files or dump tool output.
- Browser-only voice mode is built into `agent-console.html`: `Mic` uses Chrome/Web Speech recognition for prompt dictation, `speak replies` uses browser `speechSynthesis`, and `Test voice` verifies output. Voice selector/speed/pitch/volume persist in localStorage and apply to both Claude and ChatGPT/Codex because speech is done in the shared browser renderer. No OpenAI Realtime/API audio and no additional subscription/API spend. Voice selector is filtered to English voices only plus `System default`; use macOS 26 `System Settings -> Accessibility -> Read & Speak -> System voice -> info button` to download better English voices, then restart Chrome/hard-refresh.
- Current console deploy loop: transfer `tools/immich-agent/agent-console.html` to Synology `/tmp/agent-console.html`, `docker cp` it into `immich-server:/tmp/agent-console.html`, run `node /tmp/patch-assistant-controller.mjs`, run `node --check /usr/src/app/server/dist/controllers/assistant.controller.js`, then `docker restart immich-server`. Transfer path from this managed shell usually requires escalated `ssh -p 22222 hausmanj@drhaus 'cat > /tmp/agent-console.html' < tools/immich-agent/agent-console.html`.

## Operational access
- Synology: **exactly** `ssh -p 22222 hausmanj@drhaus` (home `/volume1/homes/hausmanj`; NAS data under `/volume1`). Docker at `/usr/local/bin/docker`, no sudo.
- Immich container: `ssh -p 22222 hausmanj@drhaus /usr/local/bin/docker exec immich-server ...`; internal API on `http://127.0.0.1:2283`; container `/data` maps to host `/volume1/docker/immich/library`.
- Prefer the M4 Pro for heavy hashing/EXIF/clustering over the 10 Gbps link; run near the data on the NAS for bulk inventory truth.

## GROUND TRUTH: the real production library (corrects dev-era notes)
AGENTS.md's `/external/desktop-icloud-originals` and `/external/laptop-backup` were **dev** mounts — **not** production. Verified from the running compose:
- Immich's own library store: **`/volume1/photosync/uploads_immich`** → `/usr/src/app/upload`.
- Reference mounts: **`/volume1/photosync/originals_clean`** → `/mnt/originals:ro`; **`/volume1/photosync/uploads_macbookpro`** → `/mnt/uploads_macbookpro`.
- The **1–2M out-of-Immich mass** spans NAS shares: `/volume1/photo` (archive/originals/photo), `/volume1/photosync` (originals_clean, uploads_macbookpro, uploads_imazing, uploads_immich, hold), `/volume1/backups`, `/volume1/video`, `/volume1/JellyfinMedia`.
- **`originals_clean` is the GOLDEN tree** — a curated Apple-export-style dated-event structure back to 1968 (e.g. `1968 Apr 13 Mom and Dad Wedding - Runnemede NJ`, `1992 St. John Virgin Islands`). It is simultaneously the **target naming convention**, the **dedup reference**, and the **"is this missing?" oracle**.

## Tool inventory
- **Immich assistant API** (reversible, journaled): `index-runs` (persisted, backgrounded census: source/dates/camera/GPS/dims + noise & risk labels + content SHA1 + raw-inventory of on-disk-but-unimported files); `deterministicAudits.organizationCoveragePlan` + `coverageExecutionLedger` (ordered work queue proving every asset is covered/deferred/risky/unclassified); `POST /assistant/tool` read-only audits (`content_hash_audit`, `sidecar_pair_audit`, `metadata_search`, `mobile_original_compare`); `review-album` / `review-plan`; `mutation` + `undo`.
- **Out-of-Immich**: `tools/photo-file-organizer.mjs` — `plan` / `reconcile-plan` / `apply` (journals before any move; dupes→quarantine, new→dated event folders) / `undo` / `status`. Moves run on the raw `/volume1` tree (Immich mounts are read-only).
  - **`reconcile-plan --perceptual`** (use for the big dedup pass): exact content-SHA1 PLUS perceptual dHash near-dup grouping via a BK-tree (`--phash-distance`, default 5). Groups same-photo-different-resolution and **RAW (NEF/CR2/DNG) vs its exported JPEG** (hashes the exiftool embedded preview); **keeps the LARGEST file** of each visual group, quarantines the smaller copies; never touches the `--originals` tree (a source matching an existing original is quarantined, flagged `largerThanOriginalMatch`). Undecodable files are kept (`perceptualHashStatus=unavailable`), never dropped.
  - **Long-run protocol**: launch DETACHED with `--progress-file` + `--resume-file`, artifacts under `/volume1/docker/immich/agent/` (durable). Poll `status --progress-file <p>` (phase/percent, `stalled` if pid died). Re-running the same command with the same `--resume-file` resumes (skips already-hashed files).

## Organization methodology (every phase read-only until approved; every mutation journaled + undoable)
1. **Census** — index-runs / organizer plan across the tree; classify real media vs noise vs unknown; content-hash.
2. **Signal vs noise** — quarantine movie-art (`*-poster/-backdrop/-logo`), thumbnails, caches, app/doc folders via noise/`smallDimension`/`generatedLike` cohorts.
3. **Byte-dedupe** — fresh SHA1 groups; keep one canonical, quarantine the rest; filename variants (`IMG_4596(1).JPG`) → review, never auto-delete.
4. **Cohorts (backbone)** — GPS is only an ANCHOR in old libraries; backbone = source folder + capture date + camera + EXIF. Event cohorts first (proven: French Polynesia = 551 review assets, 164 GPS anchors), then date/source/camera. DECOMPOSE broad containers (`Photo Copies`, `Pictures`, `Movies`, `Samsung SD Card Dec 2018`, generic names) with exact-folder audits before any album.
5. **Reversible review queues** — review albums in Immich and/or dated event folders on the source tree.
6. **Guarded commit** — albums/stacks/metadata (typed undo works today).

## Out-of-Immich dedup & missing-content method (uses the golden tree)
1. Build a **golden hash manifest**: SHA1 every file under `originals_clean` (union in `/volume1/photo/originals` + the Immich upload store) → a `sha1 → path` catalog = the "already have it" oracle.
2. Stream the messy dumps (`uploads_macbookpro`, `uploads_imazing`, `backups`, old Mac/Lenovo backups), hash each on the M4 Pro (checkpointed/resumable), and bucket:
   - **byte-identical to golden → duplicate** → quarantine, don't re-ingest.
   - **not in golden → possible missing content** → dated event folders for review + promotion into golden. (This is the "what am I missing" answer.)
   - **same name/near-match, different bytes → variant** (re-export/resize/HEIC↔JPG) → review.
3. Output a read-only report (per-bucket counts, biggest missing clusters, biggest dupe waste) + a journaled, undoable `apply` plan.

## Safety rules
- Read-only by default; **never delete**; never bypass the journal/undo path with raw shell mutations.
- Any impactful op requires a typed pre-change journal + typed undo + current-state recording.
- `metadata_edit`, `archive_favorite`, `stack_change` = apply + undo work. `folder_move`, `duplicate_resolution` = **apply-blocked** until typed undo exists.
- Reorganizing source files that are also an Immich external library changes paths → plan an Immich rescan to avoid desync.

## Missing functionality (ranked by impact on the 1–2M dedup/missing goal)
1. ✅ **DONE 2026-07-22 — Resumable hash cache**: `reconcile-plan --resume-file PATH` caches sha1+phash keyed by path+size+mtime (append-only JSONL); a killed/rebooted scan re-run with the same file skips already-hashed files. (A shared cross-run sqlite manifest is still a future nicety, but resumability — the blocker — is solved.)
2. ✅ **DONE 2026-07-22 — Perceptual near-duplicate detection**: `reconcile-plan --perceptual` (dHash + BK-tree, largest-wins, RAW-vs-JPEG via embedded preview). Verified on real NEFs.
3. **Unified cross-share catalog** — "missing" only means something against the union of all curated locations (originals_clean + photo/originals + Immich store).
4. **Long-running job manager** (pause/resume/cancel) — partially addressed: `--progress-file` + `status` (with `stalled` detection) + `--resume-file` give launch/poll/resume; a unified multi-job manager is still open. Immich `index-runs` now persist in Postgres.
5. **folder_move + duplicate_resolution apply** — `duplicate_resolution` now has typed undo (shipped); `folder_move` stays apply-blocked (physical moves go through the organizer).
6. **MCP safety layer** so agent mutations are forced through the journal/undo contract instead of raw shell.
7. **Agent context self-management** ✅ DONE 2026-07-22 — bridge rolling checkpoint (auto-summarize + reseed past 120k tokens / 40 turns).

## Working preferences
- Subscription only, no API fees. Continue autonomously when safe; ask only true blockers. Reversibility over speed. Lead answers with the outcome; cite exact tools/paths/counts; no shallow summaries — gather evidence before concluding.
