#!/usr/bin/env node

import { spawn } from 'node:child_process';
import http from 'node:http';

const host = process.env.ASSISTANT_BRIDGE_HOST ?? '127.0.0.1';
const port = Number.parseInt(process.env.ASSISTANT_BRIDGE_PORT ?? '3737', 10);
const maxBodyBytes = Number.parseInt(process.env.ASSISTANT_BRIDGE_MAX_BODY_BYTES ?? String(4 * 1024 * 1024), 10);

const providers = {
  '/claude': {
    command: process.env.ASSISTANT_BRIDGE_CLAUDE_COMMAND ?? 'claude',
    args: parseArgs(process.env.ASSISTANT_BRIDGE_CLAUDE_ARGS, ['--print', '--output-format', 'json']),
    timeoutSeconds: Number.parseInt(process.env.ASSISTANT_BRIDGE_CLAUDE_TIMEOUT_SECONDS ?? '240', 10),
  },
  '/codex': {
    command: process.env.ASSISTANT_BRIDGE_CODEX_COMMAND ?? 'codex',
    args: parseArgs(process.env.ASSISTANT_BRIDGE_CODEX_ARGS, ['exec', '-']),
    timeoutSeconds: Number.parseInt(process.env.ASSISTANT_BRIDGE_CODEX_TIMEOUT_SECONDS ?? '240', 10),
  },
};

function parseArgs(value, defaults) {
  return value
    ? value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : defaults;
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    request.on('data', (chunk) => {
      size += chunk.byteLength;
      if (size > maxBodyBytes) {
        reject(Object.assign(new Error('Request body is too large'), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Request body must be JSON'), { statusCode: 400 }));
      }
    });

    request.on('error', reject);
  });
}

function runProvider(provider, input, timeoutSeconds) {
  return new Promise((resolve, reject) => {
    const child = spawn(provider.command, provider.args, {
      env: process.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Assistant bridge command timed out after ${timeoutSeconds} seconds`));
    }, timeoutSeconds * 1000);

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString('utf8').trim();
      const errorOutput = Buffer.concat(stderr).toString('utf8').trim();
      if (code !== 0) {
        reject(new Error(`Assistant bridge command exited with ${code}: ${errorOutput || output}`));
        return;
      }

      resolve({ stdout: output, stderr: errorOutput });
    });

    child.stdin.end(input);
  });
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(payload));
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    sendJson(response, 200, {
      status: 'ok',
      providers: Object.keys(providers).map((path) => path.slice(1)),
    });
    return;
  }

  const provider = providers[request.url ?? ''];
  if (request.method !== 'POST' || !provider) {
    sendJson(response, 404, { error: 'Unknown assistant bridge endpoint' });
    return;
  }

  try {
    const body = await readJson(request);
    if (!body || typeof body.input !== 'string' || body.input.trim().length === 0) {
      sendJson(response, 400, { error: 'Request body must include a non-empty input string' });
      return;
    }

    const timeoutSeconds =
      typeof body.timeoutSeconds === 'number' && Number.isFinite(body.timeoutSeconds)
        ? Math.min(Math.max(Math.trunc(body.timeoutSeconds), 1), 600)
        : provider.timeoutSeconds;
    const output = await runProvider(provider, body.input, timeoutSeconds);
    sendJson(response, 200, output);
  } catch (error) {
    sendJson(response, error.statusCode ?? 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, host, () => {
  console.log(`Assistant CLI bridge listening on http://${host}:${port}`);
});
