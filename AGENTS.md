# Agent notes — local immich fork

## Session memory lives outside this repo

Read this first; it carries the objective, what was last completed, and the
next action:

    ~/.qwen/projects/-Users-johnhausman-source-immich/codex/SESSION_MEMORY.md

There is no memory store under `~/.codex` — `memories_1.sqlite` holds only
migration/job tables, no session content. Do not spend turns searching for it.

## Local test stack

Three containers run the isolated mobile-test environment (`docker/docker-compose.mobile-test.yml`):

    immich-mobile-test-server, immich-mobile-test-postgres,
    immich-mobile-test-redis

The server publishes its container port 2283 on host `0.0.0.0:2285`, so the stack is
reachable two ways, and they are not interchangeable:

- **From this Mac (agents, curl, tests): `http://127.0.0.1:2285`**
- **From the iPhone: `http://MacBook-Pro.local:2285`**

Prefer the `.local` Bonjour name over a literal IP. This is a laptop, so its
LAN address changes with every network it joins; the Bonjour name follows it
and needs no edits. Get the current name with `scutil --get LocalHostName`.

Fall back to the raw IP (`ipconfig getifaddr en0`, `192.168.0.250` at the time
of writing) only if mDNS is unavailable — some guest and corporate networks
block Bonjour or isolate clients from each other. The iPhone must be on the
same network either way.

Verify with:

    curl -s http://127.0.0.1:2285/api/server/ping     # -> {"res":"pong"}
    curl -s http://127.0.0.1:2285/api/server/version  # -> {"major":3,...}

Two traps, both of which have already cost a session:

- `192.168.0.253` appears in older notes as the phone-facing address. It is
  stale — the Mac's LAN IP is assigned by DHCP and is now `192.168.0.250`.
  Confirm the current value with `ipconfig getifaddr en0` rather than trusting
  a hardcoded address, and re-check it after any network change.
- `/api/server-info/ping` is a legacy path and returns **404** on this server
  version (3.1.0), even though the server is healthy. The current path is
  `/api/server/ping`. A 404 here means wrong path, not a dead server — check
  `docker ps` before concluding the stack is down.

Endpoints such as `/api/server/about` and `/api/server/storage` return 401
without an API key; that is expected, not a failure.

## Working state

The source-album work (server auto-materialization, the by-source client
lookup, and the duplicate-album race fix) is **committed** on
`feat/perceptual-dedup-and-context-checkpoint` as of 2026-08-18, most recent:

    1df3c04 Fix duplicate album creation race in Sync Albums
    bba0f5a Add owner album lookup by mobile source album id
    99d2ea1 Gate source-album metadata on syncAlbums; local iOS signing config
    465d054 Materialize iPhone source albums on upload with regression tests

On-device re-validation passed 2026-08-18: the duplicate-album repro now
collapses to one album. The branch is **not pushed** — push remains John's
call. Next plan item: surface source-album reconciliation status and user
opt-in controls in the mobile and web interfaces (see top entry of
`LOCAL_CHANGELOG.md` and §4/§5 of `PROJECT_GUIDE.md`).
