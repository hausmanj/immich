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
`console.html` — is **bind-mounted from `./app`**, so edits take effect on `docker restart` with **no image
rebuild**. The image is independent of Immich by construction.

## Deploy / update
`app/tools/` holds COPIES of the canonical `tools/` scripts (git-ignored to avoid drift). Sync them fresh
from canonical, then push:
```
# from the Mac repo:
cp tools/photo-file-organizer.mjs tools/media-census.py tools/dedup-agent/app/tools/
tar czf - -C tools/dedup-agent . | ssh -p 22222 hausmanj@drhaus \
  'mkdir -p /volume1/docker/photo-dedup-agent && tar xzf - -C /volume1/docker/photo-dedup-agent'
ssh -p 22222 hausmanj@drhaus 'cd /volume1/docker/photo-dedup-agent && /usr/local/bin/docker compose up -d --build'
```
The image almost never needs `--build` again — update the console/proxy/tools by re-pushing `./app/*` then
`docker restart photo-dedup-agent` (the bind-mount picks it up, no rebuild). The heavy ffmpeg image build is
a one-time ~789 MB.

## Open it
`http://<nas>:8095/` (or behind the reverse proxy / Tailscale). Requires the Mac bridge (`3737`) + tunnel
(`43737`) up. `GET /health` reports whether the bridge is reachable.
