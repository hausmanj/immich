#!/usr/bin/env node
// Standalone dedup-agent console server. Decoupled from Immich: it only serves the console UI and proxies
// the SSE agent stream to the Mac Claude/Codex bridge over the reverse tunnel. Nothing here depends on the
// Immich image, so Immich rebuilds can never affect it.
import http from 'node:http';
import { execFile } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const PORT = Number.parseInt(process.env.PORT ?? '8095', 10);
const HOST = process.env.HOST ?? '0.0.0.0';
const BRIDGE_URL = process.env.DEDUP_BRIDGE_URL ?? 'http://host.docker.internal:43737/agent-stream';
const BRIDGE_HEALTH = process.env.DEDUP_BRIDGE_HEALTH ?? 'http://host.docker.internal:43737/health';
const BRIDGE_KEEPALIVE_INTERVAL_MS = Number.parseInt(
  process.env.DEDUP_BRIDGE_KEEPALIVE_INTERVAL_MS ?? '20000',
  10,
);
const STREAM_PROXY_HEARTBEAT_MS = Number.parseInt(process.env.DEDUP_STREAM_PROXY_HEARTBEAT_MS ?? '10000', 10);
const CONSOLE_FILE = join(dirname(fileURLToPath(import.meta.url)), 'console.html');
const ORGANIZER_ROOT = '/volume1/docker/immich/agent/photo-organizer-runs';
const MEDIA_ASSESSMENT_ROOT = '/volume1/photosync/assistant-catalog/runs';
const execFileAsync = promisify(execFile);

let bridgeKeepalive = {
  enabled: Number.isFinite(BRIDGE_KEEPALIVE_INTERVAL_MS) && BRIDGE_KEEPALIVE_INTERVAL_MS > 0,
  intervalMs: BRIDGE_KEEPALIVE_INTERVAL_MS,
  lastOkAt: null,
  lastErrorAt: null,
  lastError: null,
};
let mediaAssessmentRateState = null;
let mediaAssessmentDbState = null;

function parallelRate(progressFile, runId, written) {
  const now = Date.now();
  const key = `${runId || ''}:${progressFile}`;
  if (
    !mediaAssessmentRateState ||
    mediaAssessmentRateState.key !== key ||
    written < mediaAssessmentRateState.written
  ) {
    mediaAssessmentRateState = { key, written, at: now, ratePerSecond: 0 };
    return 0;
  }
  const elapsedSeconds = Math.max(1, (now - mediaAssessmentRateState.at) / 1000);
  const delta = written - mediaAssessmentRateState.written;
  if (delta > 0) {
    const instantRate = delta / elapsedSeconds;
    mediaAssessmentRateState = {
      key,
      written,
      at: now,
      ratePerSecond: mediaAssessmentRateState.ratePerSecond > 0
        ? (mediaAssessmentRateState.ratePerSecond * 0.6) + (instantRate * 0.4)
        : instantRate,
    };
  }
  return mediaAssessmentRateState.ratePerSecond || 0;
}

async function cachedMediaAssessmentDbCounts(runDir) {
  const now = Date.now();
  if (
    mediaAssessmentDbState &&
    mediaAssessmentDbState.runDir === runDir &&
    now - mediaAssessmentDbState.at < 15000
  ) {
    return mediaAssessmentDbState.counts;
  }
  const database = join(runDir, 'media-assessment.sqlite');
  const code = [
    'import json, sqlite3, sys',
    'con = sqlite3.connect(sys.argv[1], timeout=2)',
    'con.execute("PRAGMA query_only=ON")',
    "ok = con.execute(\"SELECT COUNT(*) FROM file_assessment WHERE status = 'ok'\").fetchone()[0]",
    "file_errors = con.execute(\"SELECT COUNT(*) FROM file_assessment WHERE status = 'error'\").fetchone()[0]",
    'errors = con.execute("SELECT COUNT(*) FROM catalog_error").fetchone()[0]',
    'claims = con.execute("SELECT COUNT(*) FROM mac_assessment_claim").fetchone()[0]',
    'print(json.dumps({"assessedOk": ok, "fileErrors": file_errors, "errors": errors, "claims": claims}))',
  ].join('; ');
  try {
    const { stdout } = await execFileAsync('python3', ['-c', code, database], { timeout: 4000, maxBuffer: 1024 * 1024 });
    const counts = JSON.parse(stdout);
    mediaAssessmentDbState = { runDir, at: now, counts };
    return counts;
  } catch {
    return null;
  }
}

async function latestOrganizerSignal() {
  let entries = [];
  try { entries = await readdir(ORGANIZER_ROOT, { withFileTypes: true }); } catch { return { status: 'unknown', reason: 'organizer-root-unavailable' }; }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const progressFile = join(ORGANIZER_ROOT, entry.name, 'progress.json');
    try { candidates.push({ progressFile, mtime: (await stat(progressFile)).mtimeMs }); } catch {}
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  if (!candidates.length) return { status: 'unknown', reason: 'no-progress-artifact' };
  try {
    const progress = JSON.parse(await readFile(candidates[0].progressFile, 'utf8'));
    const ageSeconds = Math.max(0, Math.round((Date.now() - new Date(progress.updatedAt).getTime()) / 1000));
    const stale = progress.status === 'running' && ageSeconds > 60;
    const counters = progress.counters || {};
    const totals = progress.totals || {};
    const phaseDone = progress.phase === 'indexing_originals' ? (counters.originalsHashed || 0) : (counters.sourceScanned || 0);
    const phaseTotal = progress.phase === 'indexing_originals' ? (totals.originalsFiles || 0) : (totals.sourceFiles || 0);
    const elapsedSeconds = Math.max(1, (Date.now() - new Date(progress.startedAt).getTime()) / 1000);
    const ratePerSecond = phaseDone > 0 ? phaseDone / elapsedSeconds : 0;
    const etaSeconds = ratePerSecond > 0 && phaseTotal > phaseDone ? Math.ceil((phaseTotal - phaseDone) / ratePerSecond) : null;
    const runDir = dirname(candidates[0].progressFile);
    let lifecycle = '';
    try { lifecycle = (await readFile(join(runDir, 'attempt-lifecycle.log'), 'utf8')).trim().split('\n').slice(-6).join('\n'); } catch {}
    return { ...progress, status: stale ? 'stalled' : progress.status, heartbeatAgeSeconds: ageSeconds, runDir, lifecycle, signal: { phaseDone, phaseTotal, ratePerSecond, etaSeconds } };
  } catch (error) { return { status: 'unknown', reason: String(error?.message ?? error) }; }
}

async function latestMediaAssessmentSignal() {
  let entries = [];
  try { entries = await readdir(MEDIA_ASSESSMENT_ROOT, { withFileTypes: true }); } catch { return { status: 'unknown', reason: 'media-assessment-root-unavailable' }; }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    for (const name of ['progress.json', 'parallel-nas-progress.json', 'parallel-nas-progress-2.json']) {
      const progressFile = join(MEDIA_ASSESSMENT_ROOT, entry.name, name);
      try { candidates.push({ progressFile, mtime: (await stat(progressFile)).mtimeMs }); } catch {}
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  if (!candidates.length) return { status: 'unknown', reason: 'no-media-assessment-progress-artifact' };
  try {
    const progress = JSON.parse(await readFile(candidates[0].progressFile, 'utf8'));
    const runDir = dirname(candidates[0].progressFile);
    const progressName = basename(candidates[0].progressFile);
    const isParallel = progressName.startsWith('parallel-nas-progress');
    let baseProgress = {};
    try { baseProgress = JSON.parse(await readFile(join(runDir, 'progress.json'), 'utf8')); } catch {}
    const dbCounts = isParallel ? await cachedMediaAssessmentDbCounts(runDir) : null;
    const updatedAt = progress.updated_at || progress.updatedAt || progress.heartbeatAt || new Date(candidates[0].mtime).toISOString();
    const startedAt = progress.started_at || progress.startedAt;
    const ageSeconds = updatedAt ? Math.max(0, Math.round((Date.now() - new Date(updatedAt).getTime()) / 1000)) : null;
    const stale = progress.status === 'running' && ageSeconds !== null && ageSeconds > (isParallel ? 600 : 120);
    const baseCounts = baseProgress.counts || {};
    const initialParallelPending = Number(progress.pending || 0) + Number(progress.written || 0);
    const catalogFiles = Number(baseCounts.catalogFiles || initialParallelPending || 0);
    const assessedOk = Number(dbCounts?.assessedOk ?? NaN);
    const assessmentPending = Number.isFinite(assessedOk) && catalogFiles > 0
      ? Math.max(0, catalogFiles - assessedOk)
      : Number(progress.pending || 0);
    const counts = isParallel
      ? {
          ...baseCounts,
          catalogFiles,
          assessedOk: Number.isFinite(assessedOk)
            ? assessedOk
            : Math.max(catalogFiles - Number(progress.pending || 0), Number(progress.written || 0)),
          assessmentPending,
          catalogErrors: Number(dbCounts?.errors ?? progress.errors ?? 0),
          fileErrors: Number(dbCounts?.fileErrors ?? 0),
          activeClaims: Number(dbCounts?.claims ?? progress.inFlight ?? 0),
          parallelClaimed: Number(progress.claimed || 0),
          parallelQueued: Number(progress.queued || 0),
          parallelWritten: Number(progress.written || 0),
          parallelInFlight: Number(progress.inFlight || 0),
        }
      : (progress.counts || {});
    const rawStage = progress.stage || 'unknown';
    const stage = isParallel && rawStage.startsWith('mac_parallel_') ? 'assessing_files' : rawStage;
    const phaseDone = stage === 'assessing_files'
      ? (counts.assessedOk || progress.assessed_files || 0)
      : stage === 'completed'
        ? (counts.catalogFiles || progress.cataloged_files || 0)
        : (progress.scanned_dirs || 0);
    const phaseTotal = stage === 'assessing_files' || stage === 'completed'
      ? (counts.catalogFiles || 0)
      : 0;
    const effectiveStartedAt = startedAt || baseProgress.started_at || baseProgress.startedAt;
    let lifecycle = '';
    try { lifecycle = (await readFile(join(runDir, 'attempt-lifecycle.log'), 'utf8')).trim().split('\n').slice(-6).join('\n'); } catch {}
    if (isParallel) {
      lifecycle = [
        `Parallel NAS worker progress: ${progressName}`,
        `claimed ${Number(progress.claimed || 0).toLocaleString()} · written ${Number(progress.written || 0).toLocaleString()} · in flight ${Number(progress.inFlight || 0).toLocaleString()} · errors ${Number(progress.errors || 0).toLocaleString()}`,
        lifecycle,
      ].filter(Boolean).join('\n');
    }
    const elapsedSeconds = effectiveStartedAt ? Math.max(1, (Date.now() - new Date(effectiveStartedAt).getTime()) / 1000) : 1;
    const ratePerSecond = isParallel
      ? parallelRate(candidates[0].progressFile, progress.runId || progress.id, Number(counts.assessedOk || progress.written || 0))
      : (phaseDone > 0 ? phaseDone / elapsedSeconds : 0);
    const etaSeconds = isParallel
      ? (ratePerSecond > 0 && Number(counts.assessmentPending || progress.pending || 0) > 0 ? Math.ceil(Number(counts.assessmentPending || progress.pending || 0) / ratePerSecond) : null)
      : (ratePerSecond > 0 && phaseTotal > phaseDone ? Math.ceil((phaseTotal - phaseDone) / ratePerSecond) : null);
    return {
      ...progress,
      counts,
      jobKind: 'media_assessment_catalog',
      phase: stage,
      startedAt: effectiveStartedAt,
      updatedAt,
      status: stale ? 'stalled' : progress.status,
      heartbeatAgeSeconds: ageSeconds,
      runDir,
      progressFile: candidates[0].progressFile,
      lifecycle,
      signal: { phaseDone, phaseTotal, ratePerSecond, etaSeconds },
    };
  } catch (error) { return { status: 'unknown', reason: String(error?.message ?? error) }; }
}

async function latestActiveProcessSignal() {
  const [assessment, organizer] = await Promise.all([latestMediaAssessmentSignal(), latestOrganizerSignal()]);
  if (assessment.status === 'running' || assessment.status === 'stalled') return assessment;
  if (organizer.status === 'running' || organizer.status === 'stalled') return organizer;
  if (assessment.status !== 'unknown') return assessment;
  return organizer;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/console')) {
    try {
      const html = await readFile(CONSOLE_FILE);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('console.html not found: ' + (error?.message ?? error));
    }
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    let bridge = 'unreachable';
    try {
      const r = await fetch(BRIDGE_HEALTH, { signal: AbortSignal.timeout(4000) });
      bridge = r.ok ? 'ok' : 'status ' + r.status;
    } catch (error) {
      bridge = String(error?.message ?? error);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', bridge, bridgeUrl: BRIDGE_URL, bridgeKeepalive }));
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/organizer-status')) {
    const signal = await latestActiveProcessSignal();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(signal));
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/active-process-status')) {
    const signal = await latestActiveProcessSignal();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(signal));
    return;
  }

  if (req.method === 'POST' && req.url === '/agent-stream') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Content-Encoding': 'identity',
    });
    // Flush the headers and keepalive comments immediately so an upstream model
    // pause cannot look like an idle or buffered connection to the reverse proxy.
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    res.write(': connected\n\n');
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': proxy-ping\n\n');
    }, STREAM_PROXY_HEARTBEAT_MS);
    const ac = new AbortController();
    res.on('close', () => {
      clearInterval(heartbeat);
      ac.abort();
    });
    try {
      const upstream = await fetch(BRIDGE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: ac.signal,
      });
      if (!upstream.ok || !upstream.body) {
        res.write('event: bridge_error\ndata: ' + JSON.stringify({ error: 'bridge status ' + upstream.status }) + '\n\n');
        res.end();
        return;
      }
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) res.write(decoder.decode(value, { stream: true }));
      }
    } catch (error) {
      if (!res.writableEnded) {
        res.write('event: bridge_error\ndata: ' + JSON.stringify({ error: String(error?.message ?? error) }) + '\n\n');
      }
    } finally {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

// The NAS console is often idle for long stretches between prompts. Keep an
// application-level trickle across the NAS -> Mac reverse-tunnel path so Docker,
// proxies, or SSH forwarding do not leave the next prompt paying a cold reconnect.
async function warmBridgePath() {
  if (!bridgeKeepalive.enabled) return;
  try {
    const r = await fetch(BRIDGE_HEALTH, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error('bridge status ' + r.status);
    bridgeKeepalive = {
      ...bridgeKeepalive,
      lastOkAt: new Date().toISOString(),
      lastErrorAt: null,
      lastError: null,
    };
  } catch (error) {
    bridgeKeepalive = {
      ...bridgeKeepalive,
      lastErrorAt: new Date().toISOString(),
      lastError: String(error?.message ?? error),
    };
  }
}

server.timeout = 0;
server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 0;

if (bridgeKeepalive.enabled) {
  warmBridgePath();
  setInterval(warmBridgePath, BRIDGE_KEEPALIVE_INTERVAL_MS);
}

server.listen(PORT, HOST, () => {
  console.log(`dedup-agent console on http://${HOST}:${PORT}  ->  bridge ${BRIDGE_URL}`);
  console.log(
    `dedup-agent bridge keepalive: ${bridgeKeepalive.enabled ? `${BRIDGE_KEEPALIVE_INTERVAL_MS}ms` : 'disabled'}`,
  );
});
