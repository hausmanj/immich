# Photo Dedup Agent (standalone, Immich-independent)

The **first** of the two planned agents: a dedicated home for the 1–2M-file **pre-import deduplication**
effort. Deduplication is filesystem-level and does **not** need Immich, so this agent is a separate
container with **no coupling to the Immich image** — Immich rebuilds (which happen constantly) can never
affect it. The second agent (final album organizing *inside* Immich) is deferred.

## Architecture
- The standalone console UI is kept in sync with `tools/immich-agent/agent-console.html`; update both deployment targets together when changing layout, bridge status, prompts, or execution-host guidance.
- **Brain:** Claude/Codex on the Mac (subscription, no paid API), reached over the existing bridge (`3737`)
  + reverse tunnel (`0.0.0.0:43737` on the NAS). Unchanged.
- **This container** (`photo-dedup-agent`, NAS): serves the dedup console UI and **SSE-proxies** `/agent-stream`
  to the Mac bridge. Mounts `/volume1` + `/volume2` `rw` so it is a full-server ops home.
- **Tools:** the heavy hashing/organizing (`tools/photo-file-organizer.mjs --perceptual --resume-file …`,
  `media-census.py`) runs on the Mac (M4 Pro) or NAS-side over SSH, exactly as today. The image ships
  `ffmpeg`/`exiftool`/`python3` so in-container NAS-local execution can be added later without a rebuild.

## Why a separate image at all
The image is a minimal runtime (node + ffmpeg + exiftool + python). All of *our* code — `server.mjs`,
`console.html` — is **bind-mounted from `./app`**, so the console file can be updated in place with **no container
restart**. The image is independent of Immich by construction.

## Deploy / update
`app/tools/` holds COPIES of the canonical `tools/` scripts (git-ignored to avoid drift). Sync them fresh
from canonical, then push:
```
# from the Mac repo:
cp tools/photo-file-organizer.mjs tools/photo-file-organizer-attempt.sh tools/run-photo-file-organizer-nas-worker.sh tools/media-census.py tools/run-media-census-safe.sh tools/dedup-agent/app/tools/
tar czf - -C tools/dedup-agent . | ssh -p 22222 hausmanj@drhaus \
  'mkdir -p /volume1/docker/photo-dedup-agent && tar xzf - -C /volume1/docker/photo-dedup-agent'
ssh -p 22222 hausmanj@drhaus 'cd /volume1/docker/photo-dedup-agent && /usr/local/bin/docker compose up -d --build'
```
For every census, invoke `run-media-census-safe.sh`. Never use shell `>` redirection to a durable census log: the shell truncates the target before the census process can fail safely. The wrapper creates a unique attempt log and preserves all existing database, progress, summary, and log artifacts.
The image almost never needs `--build` again. Update `console.html` in place; do not restart
`photo-dedup-agent` while a long NAS job is active because a container restart can kill detached child workers.
The heavy ffmpeg image build is a one-time ~789 MB.

Deployment safety: do not restart `photo-dedup-agent` while an organizer, census, hashing, or other long NAS job
is active. A container restart can kill detached child workers. Restart only after a process/status guard confirms
no active NAS job, or after explicit user approval to interrupt it.

Organizer workers use the Node-based `photo-dedup-agent:local` image in a separate container named
`photo-organizer-worker-*`; HausPix remains a web utility container and is not the worker owner.

## Open it
`http://<nas>:8095/` (or behind the reverse proxy / Tailscale). Requires the Mac bridge (`3737`) + tunnel
(`43737`) up. `GET /health` reports whether the bridge is reachable.
