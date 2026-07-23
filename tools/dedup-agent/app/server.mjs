#!/usr/bin/env node
// Standalone dedup-agent console server. Decoupled from Immich: it only serves the console UI and proxies
// the SSE agent stream to the Mac Claude/Codex bridge over the reverse tunnel. Nothing here depends on the
// Immich image, so Immich rebuilds can never affect it.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number.parseInt(process.env.PORT ?? '8095', 10);
const HOST = process.env.HOST ?? '0.0.0.0';
const BRIDGE_URL = process.env.DEDUP_BRIDGE_URL ?? 'http://host.docker.internal:43737/agent-stream';
const BRIDGE_HEALTH = process.env.DEDUP_BRIDGE_HEALTH ?? 'http://host.docker.internal:43737/health';
const CONSOLE_FILE = join(dirname(fileURLToPath(import.meta.url)), 'console.html');

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
    res.end(JSON.stringify({ status: 'ok', bridge, bridgeUrl: BRIDGE_URL }));
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
    });
    const ac = new AbortController();
    res.on('close', () => ac.abort());
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
      if (!res.writableEnded) res.end();
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, HOST, () => {
  console.log(`dedup-agent console on http://${HOST}:${PORT}  ->  bridge ${BRIDGE_URL}`);
});
