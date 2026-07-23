#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const progressPath = resolve(process.argv[2] || '');
const port = Number(process.argv[3] || 8765);
const page = await readFile(new URL('./organizer-progress-monitor.html', import.meta.url));
const server = createServer(async (req, res) => {
  if (req.url?.startsWith('/progress')) {
    try { const data = await readFile(progressPath); res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(data); }
    catch (error) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: String(error) })); }
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(page);
});
server.listen(port, '127.0.0.1', () => console.log(`progress monitor: http://127.0.0.1:${port}/`));
