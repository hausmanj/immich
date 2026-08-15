# Immich — Project Guide

**Scope note (2026-08-06): this guide used to also cover the photo-organization/dedup effort. Per John's
explicit correction — "Immich is actually TWO separate projects. The photo organization effort is not
IMMICH... We need separation. HausPix should hold the organization information" — that entire effort
(ground rules, Master Photo Library v2, the dedup-agent/organizer pipeline, Library Build) has been moved
to `/volume1/docker/hauspix/project/guide/PHOTO_ORGANIZATION_GUIDE.md`. This doc now covers only Immich
itself: the 3 viewing instances, the shared NAS agent-console bridge (physically hosted in this repo), and
the future iPhone-original-import mission.**

**Maintenance rule for any future session (human or agent):** edit this file in place when Immich's own
goals, rules, or architecture change. New status/events go in **§5 Project Updates** at the bottom, most
recent first, as one tight dated entry — not a running transcript.

---

## 1. Purpose

Immich is the day-to-day viewing/browsing layer for a curated subset of the master photo library (which
lives at `/volume1/photo/master photo library`, organized and maintained by the HausPix project — see
`PHOTO_ORGANIZATION_GUIDE.md` there, not here).

**Immich's own, separate future mission**: become the way untouched original photos/videos get off
John's and his kids' iPhones in the first place — replacing the current iCloud→Mac→NAS sync path (which
loses RAW/ProRAW fidelity) with a direct, byte-exact extraction pipeline. This is a real, separate
sub-effort (recon-only as of 2026-08-06, not started coding) — see §4.

## 2. Goals

- **Immich stays accurate and scoped.** It indexes a specific, known subset (currently ~55k assets); its
  counts are never conflated with the archive-wide census (which lives in the organization project).
  John's plan: once a decent number of albums are developed, use Immichgo (a second NAS Immich instance)
  to index the photos and verify EXIF data is being sorted properly. The Immich image itself will be
  further refined and implemented in the Immich fork (git + local Mac clone/repo).
- **An AI operations layer, not a chatbot**, reachable from inside Immich's own agent console (shares
  infrastructure with the organization project's standalone dedup console — see §3.1 — but the console
  UI embedded in Immich is this project's own surface).
- **Byte-exact original capture from iPhones** (the future mission, §1) — no lossy iCloud round-trip.

## 3. Architecture

### 3.1 NAS API / bridge layer (shared infrastructure, hosted here)

Lets both the Immich agent console and the organization project's standalone dedup-agent console run a
real Claude Code / Codex agent against the NAS, on John's Mac subscription — never a paid API. Physically
lives in this repo's `tools/`, but serves both projects.

- **Brain:** Claude Code (or Codex) on the Mac, invoked by `tools/assistant-cli-bridge.mjs` (port 3737,
  launchd job `com.johnhausman.immich-assistant-bridge`) in streaming mode
  (`claude --print --output-format stream-json`). Hard rule: subscription only (`apiKeySource:"none"`).
- **Reverse tunnel:** launchd job `com.johnhausman.immich-assistant-tunnel` exposes the bridge to the NAS
  at `172.31.0.1:43737` (from inside Immich's docker network) / `0.0.0.0:43737` (from the dedup-agent
  container or NAS host).
- **Two consoles, one bridge:**
  - Immich-embedded: `<immich-url>/api/assistant/agent-console` — served by hot-patching the running
    `immich-server` container's compiled `dist/controllers/assistant.controller.js`
    (source: `tools/immich-agent/agent-console.html` + `patch-assistant-controller.mjs`).
  - Standalone (organization project's own): `photo-dedup-agent` container, `http://<nas>:8095/`.
- Bridge endpoints: `/claude`, `/codex`, `/command`, `/agent-stream` (SSE), `/health`.
- ChatGPT/Codex runs through the same bridge (`codex exec --json`; resume via
  `codex exec resume --json ... <sessionId> -`, no `-C` on resume).
- Voice (mic dictation + TTS) is browser-only, built into both consoles' frontend — zero added cost.
- **Known gotcha (fixed 2026-07-22, watch for recurrence):** a stale duplicate launchd job
  `com.immich.assistant-bridge` can win the port-3737 race on reboot with a broken PATH/env. It's
  `launchctl disable`d but the plist is still on disk — safe to delete outright if it reappears. Health
  check: `ssh -p 22222 hausmanj@drhaus 'curl -s http://127.0.0.1:43737/health'`. Restart the pair with
  `launchctl kickstart -k gui/$(id -u)/com.johnhausman.immich-assistant-bridge` then `...-tunnel`.

### 3.2 Immich (viewing + in-app agent)

**Three separate Immich instances exist — never mix their counts or scopes:**

| Instance | Location | Purpose |
|---|---|---|
| `immich-server` | `/volume1/docker/immich` (Synology) | Assistant-enabled; newest iPhone→iCloud→Mac→NAS pipeline; recent imports only |
| `immichgo` | `/volume1/docker/immichgo` (Synology) | Own Postgres/ML stack; indexes the laptop-backup collection |
| Mac-local Immich | this Mac (not NAS) | Viewer/index for Google Photos on an external hard drive |

Production ground truth for `immich-server` (verified from the live compose):

- Library store: `/volume1/photosync/uploads_immich` → container `/usr/src/app/upload`.
- Reference mounts: `/volume1/photosync/originals_clean` → `/mnt/originals:ro` (the **golden tree** —
  curated, dated-event structure back to 1968; doubles as the target naming convention, the dedup oracle,
  and the "is this missing?" check — same tree the organization project's dedup pass treats as
  protected/read-only); `/volume1/photosync/uploads_macbookpro` → `/mnt/uploads_macbookpro`.
- Library profile (2026-07-21 read): ~55,068 active assets, dates 1974–2026, 43% GPS coverage,
  near-zero noise. Immich's own checksums are path-identity for external libraries, not real content
  hashes — genuine content dedup is a separate pass, owned by the organization project.
- Postgres is a version-locked custom build (`postgres:14-vectorchord0.4.3-pgvectors0.2.0`) — never swap
  to a generic/latest image.
- **Never `docker image prune -a`** on this host — `immichgo`'s containers reference images by ID that
  show as `<none>` but are live; both stacks also share one postgres and one valkey image by ID.
  `docker image prune` (dangling-only) and `docker builder prune` are safe.

**Assistant API surface** (reversible, journaled): `index-runs` (persisted census); `deterministicAudits
.organizationCoveragePlan` + `coverageExecutionLedger`; read-only `POST /assistant/tool` audits
(`content_hash_audit`, `sidecar_pair_audit`, `metadata_search`, `mobile_original_compare`);
`review-album`/`review-plan`; `mutation` + `undo`. `duplicate_resolution` has typed undo (soft-delete
trash/restore, never a hard delete). `folder_move` stays **apply-blocked** — physical moves for the
organization project go through its own tooling instead, not through Immich.

## 4. Immich iOS fork — byte-exact original capture (the future mission)

Recon-only as of 2026-08-06, not started coding. A separate sub-effort fixing the mobile app's upload
path via `PHAssetResourceManager` to extract unmodified RAW/ProRAW originals directly from the iPhone,
instead of relying on the current iCloud-sync-to-Mac-then-NAS-then-Immich method that loses fidelity
along the way. See top-level memory `project_immich_ios_originals.md` for detail. This is genuinely
Immich's own project, distinct from the organization effort even though both eventually feed the same
master library.

Codex/codexlocal simulator access: use `tools/ios-simulator-control.mjs` from this repo for repeatable
terminal control of CoreSimulator. It supports `list`, `boot`, `screenshot`, `install`, `launch`,
`open-url`, and `logs`; default simulator is `IOS_SIM_DEVICE` or `iPhone 16 Pro`. Mobile builds should
run from `mobile/` because `mobile/mise.toml` owns Flutter (`aqua:flutter/flutter` 3.44.9); the root
`mise.toml` does not provide Flutter.

## 5. Project history (dated log, most recent first)

### 2026-08-06 — Scope split from the organization project
Per John's explicit correction, split this guide: everything about the organization effort (ground
rules, Master Photo Library v2, the dedup-agent/organizer pipeline, Library Build, dated history of that
work) moved wholesale to `/volume1/docker/hauspix/project/guide/PHOTO_ORGANIZATION_GUIDE.md`. This guide
keeps only what's genuinely Immich's own: the 3-instance architecture, the shared agent-console bridge,
and the iPhone-original-import mission. No content was lost — see the new HausPix doc for the full
carried-over history.

### 2026-07-28
Consolidated `AGENTS.md`, `tools/immich-agent/CLAUDE.md`, and two stale NAS `CLAUDE.md` copies into a
single guide (predecessor to this one, before the 2026-08-06 split above). Restructured into a spec-style
layout. Clarified home-vs-away connectivity (Tailscale MagicDNS works everywhere; prefer the local LAN IP
and SMB mounts only when physically home) and NAS batch-job worker-count guidance (~50 workers,
multi-core) — general infrastructure facts, kept here since they apply to Immich work too, also
documented in HausPix's own `AGENTS.md`.

## 6. Operational access

Same NAS/SSH/Docker facts as the rest of this infrastructure:
- SSH: `ssh -p 22222 hausmanj@drhaus` (Tailscale MagicDNS, works everywhere). At home, prefer the local
  LAN IP for SSH/bulk transfer. SMB mounts (`/Volumes/docker`) are a home-only convenience.
- `scp` needs `-O`, or pipe via `ssh ... 'cat > /remote/path' < localfile`.
- Docker on the NAS: `/usr/local/bin/docker`, no sudo needed. `sudo` needs a password — root-only actions
  (`tailscale serve`/`funnel`) are John's to run.
- Immich container: `ssh -p 22222 hausmanj@drhaus /usr/local/bin/docker exec immich-server ...`; internal
  API `http://127.0.0.1:2283`; container `/data` maps to host `/volume1/docker/immich/library`.
