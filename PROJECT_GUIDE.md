# Photo Library, Immich Agent & Dedup Ops — Project Guide

**This is the single canonical reference for the photo-organization / Immich-agent / dedup-agent /
NAS-API-bridge project.** It replaces `AGENTS.md`, `tools/immich-agent/CLAUDE.md`, and the NAS-side
copies of `CLAUDE.md` (deleted 2026-07-28).

**Maintenance rule for any future session (human or agent):** edit this file in place when goals, rules,
or architecture change. Don't spin up a new `AGENTS.md` / `CLAUDE.md` / `NOTES.md`. Raw turn-by-turn build
history belongs in `LOCAL_CHANGELOG.md`; only the durable facts get folded back in here. New status/events
go in **§6 Project Updates** at the bottom, most recent first, as one tight dated entry — not a running
transcript.

---

## 1. Purpose

John self-hosts a large personal/family photo & video archive (dated events back to 1968) on a Synology
NAS. The project exists to build safe, reversible, agent-assisted tooling that turns the messy real
source material — roughly 83,000 files / 700GB of it, buried in a much larger ~6.75TB / 5.86M-path raw
namespace that's mostly app-generated derivatives, thumbnails, and caches — into one well-organized,
byte-exact **master photo library**, with Immich as the day-to-day viewing layer for a curated subset.

## 2. Goals

- **One master library.** Merge and dedupe the three real source trees into a single curated,
  byte-exact, sensibly-named library — organized by trip, occasion, and reason, not just by month-dumped
  folders.
- **Zero data loss, full reversibility.** Every copy is byte-exact; every mutation is journaled and
  undoable; nothing is ever guessed past the point of visual confirmation.
- **An AI operations layer, not a chatbot.** A real agent (Claude Code / Codex, on John's subscription,
  never a paid API) that can investigate the archive with real tools and propose reversible plans —
  reachable from inside Immich and from a standalone dedup console.
- **Immich stays accurate and scoped.** It indexes a specific, known subset (currently ~55k assets); its
  counts are never conflated with the archive-wide census.
- **Every visual review tool becomes permanent HausPix functionality.** Montage viewers, audit
  dashboards, progress monitors — anything built to *look at* photos during this work — is a HausPix page,
  not a throwaway script on its own port. That's the entire reason HausPix exists as a project.
- **Fix known data-fidelity gaps**, notably: incorrect/missing EXIF dates on the Google Takeout export
  (audit tooling exists, integration into HausPix pending — §6), and non-original RAW/ProRAW capture from
  the iPhone (separate iOS fork effort, recon-only).

## 3. Ground rules

*(Space for John to edit/add/reprioritize — this is the current working set as of 2026-07-28.)*

**Data integrity**
1. Untouched originals only — every copy byte-exact, full-size, all EXIF. Never transcode, resize, or
   strip metadata on copy.
2. Dedup by **sha1 AND filename** across every source before placing anything — keep the single
   highest-quality copy.
3. Never send GPS coordinates to an external geocoder — reverse-geocode only from your own knowledge of
   coordinates.

**Organization & naming**
4. Trip boundaries: bracket start/end with date verification **and** visual confirmation of the edge
   photos. Don't leak into adjacent or home albums.
5. Occasions: run a real per-year calendar pass (holidays, birthdays, school events) — but metadata-only
   detection produces false positives, so **visually confirm every rename before applying it.**
6. Home photos aren't a dump — name them by reason (renovation, landscaping, baby photos, etc.). Near-home
   GPS with mountains or clearly-elsewhere visuals is *not* home.
7. Titling is precise and activity/landmark-specific ("Western Colorado Hunting," not "Hunting"), using
   region + landmark + park-proximity GPS + visual cues.
8. Engine/motorcycle photos are never auto-lumped — they may be repair/rebuild documentation, not a ride.

**Process & safety**
9. Ask clarifying questions liberally on any ambiguity — don't guess.
10. Reversibility over speed: read-only by default; typed journal + typed undo before any mutation; never
    a raw shell mutation against a protected tree.
11. Any visual/review UI or dashboard is a HausPix page, not a one-off Artifact or standalone process
    (see Goals, and §5.4).
12. Do the investigative work yourself with the tools available — don't punt research back to John.

## 4. Family reference (for occasion detection)

Birthdays: John 8/30 · Lily 11/12 · Julia 7/15 · nephew Ryan / niece Madison (Ryan older; 2013-03 = Ryan's
birth).

---

## 5. Architecture — the systems involved

### 5.1 NAS API / bridge layer (the shared brain)

Lets both the Immich agent console and the standalone dedup-agent console run a real Claude Code / Codex
agent against the NAS, on John's Mac subscription — never a paid API.

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
  - Standalone: `photo-dedup-agent` container, `http://<nas>:8095/` (source: `tools/dedup-agent/`).
- Bridge endpoints: `/claude`, `/codex`, `/command`, `/agent-stream` (SSE), `/health`.
- ChatGPT/Codex runs through the same bridge (`codex exec --json`; resume via
  `codex exec resume --json ... <sessionId> -`, no `-C` on resume).
- Voice (mic dictation + TTS) is browser-only, built into both consoles' frontend — zero added cost.
- **Known gotcha (fixed 2026-07-22, watch for recurrence):** a stale duplicate launchd job
  `com.immich.assistant-bridge` can win the port-3737 race on reboot with a broken PATH/env. It's
  `launchctl disable`d but the plist is still on disk — safe to delete outright if it reappears. Health
  check: `ssh -p 22222 hausmanj@drhaus 'curl -s http://127.0.0.1:43737/health'`. Restart the pair with
  `launchctl kickstart -k gui/$(id -u)/com.johnhausman.immich-assistant-bridge` then `...-tunnel`.

### 5.2 Immich (viewing + in-app agent)

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
  and the "is this missing?" check); `/volume1/photosync/uploads_macbookpro` → `/mnt/uploads_macbookpro`.
- Library profile (2026-07-21 read): ~55,068 active assets, dates 1974–2026, 43% GPS coverage,
  near-zero noise. Immich's own checksums are path-identity for external libraries, not real content
  hashes — genuine content dedup is the separate out-of-Immich pass in §5.3.
- Postgres is a version-locked custom build (`postgres:14-vectorchord0.4.3-pgvectors0.2.0`) — never swap
  to a generic/latest image.
- **Never `docker image prune -a`** on this host — `immichgo`'s containers reference images by ID that
  show as `<none>` but are live; both stacks also share one postgres and one valkey image by ID.
  `docker image prune` (dangling-only) and `docker builder prune` are safe.

**Assistant API surface** (reversible, journaled): `index-runs` (persisted census); `deterministicAudits
.organizationCoveragePlan` + `coverageExecutionLedger`; read-only `POST /assistant/tool` audits
(`content_hash_audit`, `sidecar_pair_audit`, `metadata_search`, `mobile_original_compare`);
`review-album`/`review-plan`; `mutation` + `undo`. `duplicate_resolution` has typed undo (soft-delete
trash/restore, never a hard delete). `folder_move` stays **apply-blocked** — physical moves go through
`tools/photo-file-organizer.mjs` instead.

### 5.3 Photo dedup agent + Master Photo Library v2 (the org effort)

Standalone, Immich-independent container (`photo-dedup-agent`, `/volume1/docker/photo-dedup-agent`, port
8095) — dedup is pure filesystem work and Immich rebuilds constantly, so this can't depend on the Immich
image.

**Core tools** (canonical source: this repo's `tools/`; NAS runs a git-ignored copy under `app/tools/` —
see §6 drift note): `photo-file-organizer.mjs` (`plan`/`reconcile-plan`/`apply`/`undo`/`status`;
`--perceptual` adds dHash + BK-tree near-dup grouping, keeps the largest file of each visual group,
matches RAW against its exported JPEG via the embedded preview; `--progress-file`+`--resume-file` for
long detached runs, artifacts under `/volume1/docker/immich/agent/`); `media-census.py` (NAS-wide
read-only SQLite census, resumable, symlink-safe); `generate-photo-review-contact-sheet.mjs` (montage
tool); `photo-cohort-planner.mjs`; `validate-photo-organizer-plan.mjs`.

**Synology-wide census** (completed 2026-07-23): DB `/volume1/photosync/assistant-census/media-census.sqlite`.
Raw namespace = 5.86M paths / 6.75TB, dominated by derivatives. **Real source/review cohorts ≈ 83,411
paths / 701.7GB**: `originals_clean` 29,826 · `uploads_macbookpro` 27,053 · `uploads_nextcloud` 12,514 ·
`uploads_imazing` 6,240 · `photo/archive` 5,361 · `backups` 2,060. Answer any Synology-wide "how
much/where" question from this census, not Immich Postgres.

**Protected, hard read-only, never mutate:** `/volume1/photo/originals` and
`/volume1/photosync/originals_clean` (identical ~29,826-path mirror — hash-verify before any dedup
action, never move/rename/delete/quarantine/overwrite/rewrite-metadata against either).

**Scan exclusions** (all census/organizer runs): `@eaDir`, `._*`, `#recycle`, `#snapshot`, `.stversions`,
`.stfolder`, `thumbs`, `encoded-video`, DSM top-level `@*`; rooted at `/volume1` also skip
`/volume1/{downloads,docker,JellyfinMedia,music}`.

**Master Photo Library v2** — the active build at `/volume1/photo/master photo library` (548 albums /
~56.8k files as of the v1→v2 reset on 2026-07-27). Merge order (dedup by sha1 **and** filename across all
three before placing):
1. `/volume1/photo/originals` (30,344 files/214GB, root-owned Immich external lib)
2. `/volume1/photosync/uploads_macbookpro` (27,105 media/288GB, iPhone/Mac dump)
3. `/volume1/photo/Exported ICloud Photos - DO NOT DELETE` (already fully catalogued — will duplicate 1 & 2)

Catalog DB: `.../assistant-catalog/runs/20260725T202646Z-master-media-catalog-v1-21650-14714/media-assessment.sqlite`
(`file_assessment` — sha1/quality_score/dims/camera/dates/gps; `catalog_file` — path/scope/kind/size).
Planner: `/volume1/photosync/master-lib-v2-master_reorg_planner.py` (read-only, outputs under
`/volume1/photosync/master-lib-v2/`). Visual-confirmation montage tool:
`/volume1/photosync/master-lib-v2-make_montage.sh` (no font on the host — rely on the sidecar
`legend.txt`, not burned-in labels).

**Live and unresolved:** `/volume1/photosync/master-lib-v2/QUESTIONS.md` — ~298 numbered ambiguity flags
(trip-boundary leaks, home-photos-needing-a-reason, engine/motorcycle ride-vs-repair calls) awaiting
John's visual sign-off. This is the living to-do list for the v2 pass — check its timestamp and read it
directly rather than trusting any digest of it (including this one).

**Execution location policy** (Mac-first): run heavy tools on the Mac (M4 Pro) by default when the
relevant share is mounted there; fall back to the `photo-dedup-agent` container (near-data,
node/exiftool/ffmpeg on PATH) when it isn't or the network is too slow; NAS host is the last resort and
must pass `--ffmpeg /usr/local/bin/ffmpeg7` (stock `/usr/bin/ffmpeg` is a crippled 4.1.9 without lavfi —
needed by DLNA/AudioStation, never delete it).

### 5.4 HausPix — the destination for all photo-related visual tooling

HausPix (Flask app, separate repo `/Users/johnhausman/project/hauspix`, deployed to
`/volume1/docker/hauspix`, port 8082) is not a side project — per ground rule 11, it is *the* home for
every review gallery, dashboard, or visual tool this project produces. It already hosts EXIF Editor,
Video Viewer, Theme Generator, Takeout Import, and Repair & Verify as blueprints sharing one Flask app and
one deploy path. New photo-review UIs belong here as new pages, never as a separate process on its own
port. Its own feature set and deploy mechanics live in its own memory (`project_hauspix.md`,
`project_hauspix_date_accuracy_audit.md`, `project_hauspix_theme_generator.md`) — not duplicated here.

### 5.5 Adjacent, out of scope for this doc

**Immich iOS fork** (byte-exact RAW/ProRAW originals) — recon-only, not started coding. Separate
sub-effort fixing the mobile app's upload path via `PHAssetResourceManager`. See top-level memory
`project_immich_ios_originals.md`.

---

## 6. Roadmap / open items

1. **Master Photo Library v2 album-building** — **ACTIVE RIGHT NOW, owned by a separate concurrent Mac
   Claude session (as of 2026-07-28).** That session is building actual albums from the montage + EXIF
   assessments (working through `QUESTIONS.md`'s ~298 items) and has added a **review UI on HausPix** for
   checking its album placements — correctly following ground rule 11. **Do not duplicate this work or
   touch `QUESTIONS.md`, the montage tool, album folders under `/volume1/photo/master photo library`, or
   that new HausPix review UI from a different session** until it's done — check its live state (this
   repo's own memory dir, `~/.claude/projects/-Users-johnhausman-source-immich/memory/`, and HausPix's own
   memory) before picking anything up here.
2. **Google Takeout EXIF-audit dashboard → HausPix** — goal, not started. The audit tool
   (`~/hauspix-next-phase-tools`, standalone node process on `:8788`) needs to become a HausPix page per
   ground rule 11. **Do this as its own dedicated session** — don't run it concurrently with other work
   touching HausPix (see item 1). Current tool state lives in memory
   `project_hauspix_date_accuracy_audit.md`; don't re-derive its spec here.
3. **Organizer/census progress monitor → HausPix** — goal, not started, no one currently assigned. The
   monitor (`tools/organizer-progress-monitor-server.mjs` on `:8765` + a Swift menu-bar app) still needs
   to become a HausPix page per ground rule 11.
4. **Doc drift:** `tools/dedup-agent/README.md` (local) vs. the deployed NAS copy at
   `/volume1/docker/photo-dedup-agent/README.md` — deploy-mechanics wording has diverged; reconcile next
   time either is touched. Also: `app/tools/` on the NAS holds git-ignored copies of canonical `tools/*` —
   re-sync before trusting NAS-side tool behavior matches source.

## 7. Operational access

- SSH: `ssh -p 22222 hausmanj@drhaus` (passwordless key auth). `scp` needs `-O` (legacy protocol) or pipe
  via `ssh -p 22222 hausmanj@drhaus 'cat > /remote/path' < localfile`.
- Docker on the NAS: `/usr/local/bin/docker`, no sudo needed (not on default PATH).
- `sudo` needs a password — anything needing root (`tailscale serve`/`funnel`) must be run by John.
- Immich container: `ssh -p 22222 hausmanj@drhaus /usr/local/bin/docker exec immich-server ...`; internal
  API `http://127.0.0.1:2283`; container `/data` maps to host `/volume1/docker/immich/library`.

## 8. Where the live/detailed history actually lives

- `LOCAL_CHANGELOG.md` (this repo) — full chronological build history + verification logs.
- `/volume1/photosync/master-lib-v2/QUESTIONS.md` — live open-question queue for the v2 pass.
- `/volume1/photosync/assistant-census/media-census.sqlite` — the NAS-wide census.
- Claude auto-memory on this Mac (point-in-time notes, verify before trusting): top-level
  `project_master_photo_library.md`, `project_immich_streaming_agent.md`, `project_hauspix*.md`; this
  repo's own memory dir — `immich-assistant-library-profile.md`, `immich-predup-staging-rules.md`,
  `immich-library-org-scope.md`.

---

## 9. Project Updates (dated log — most recent first)

Append one tight entry per session here. This is where session-by-session progress belongs — keep §1–5
(purpose, goals, rules, architecture) as the stable spec and put anything that changes often here instead.

### 2026-07-28
- Consolidated `AGENTS.md`, `tools/immich-agent/CLAUDE.md`, and the two stale NAS `CLAUDE.md` copies into
  this single guide (all four deleted; deletions staged in git, not committed).
- Restructured the guide itself into a spec-style layout (goals/rules up front, architecture reference,
  dated updates log at the bottom) instead of a raw memory dump.
- Codified ground rule 11 (HausPix is the destination for all review UIs/dashboards) and identified two
  items not yet compliant with it — see §6.2 and §6.3.
- Noted: a separate concurrent Mac Claude Code session is actively building Master Photo Library v2
  albums from montage + EXIF assessments, and added a new review UI for them on HausPix (correctly
  following ground rule 11). Left that area — `QUESTIONS.md`, the montage tool, album folders, and
  HausPix — untouched this session to avoid two sessions editing related work at once.
