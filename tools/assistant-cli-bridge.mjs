#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { dirname, join, resolve } from 'node:path';

const host = process.env.ASSISTANT_BRIDGE_HOST ?? '127.0.0.1';
const port = Number.parseInt(process.env.ASSISTANT_BRIDGE_PORT ?? '3737', 10);
const maxBodyBytes = Number.parseInt(process.env.ASSISTANT_BRIDGE_MAX_BODY_BYTES ?? String(4 * 1024 * 1024), 10);
const agentRoot = resolve(process.env.ASSISTANT_BRIDGE_AGENT_ROOT ?? '/Users/johnhausman');
const agentDefaultCwd = resolve(process.env.ASSISTANT_BRIDGE_AGENT_DEFAULT_CWD ?? process.cwd());
const agentLogDirectory = resolve(
  process.env.ASSISTANT_BRIDGE_AGENT_LOG_DIR ?? join(process.cwd(), 'assistant-agent-logs'),
);
const agentMaxOutputBytes = Number.parseInt(
  process.env.ASSISTANT_BRIDGE_AGENT_MAX_OUTPUT_BYTES ?? String(512 * 1024),
  10,
);
const agentMaxTimeoutSeconds = Number.parseInt(process.env.ASSISTANT_BRIDGE_AGENT_MAX_TIMEOUT_SECONDS ?? '3600', 10);

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

function isPathInside(path, root) {
  return path === root || path.startsWith(`${root}/`);
}

function truncateUtf8(buffer, maxBytes) {
  if (buffer.byteLength <= maxBytes) {
    return { text: buffer.toString('utf8'), truncated: false };
  }

  return {
    text: buffer.subarray(0, maxBytes).toString('utf8'),
    truncated: true,
  };
}

function toSafeLogName(value) {
  return value.replaceAll(':', '-').replaceAll('.', '-');
}

async function writeAgentCommandLog(payload) {
  await mkdir(agentLogDirectory, { recursive: true });
  const startedAt = typeof payload.startedAt === 'string' ? payload.startedAt : new Date().toISOString();
  const logFilePath = join(agentLogDirectory, `${toSafeLogName(startedAt)}-agent-command-${randomUUID()}.json`);
  await mkdir(dirname(logFilePath), { recursive: true });
  await writeFile(logFilePath, JSON.stringify({ ...payload, hostLogFilePath: logFilePath }, null, 2));
  return logFilePath;
}

function runAgentCommand(body) {
  return new Promise((resolveCommand) => {
    const command = typeof body.command === 'string' ? body.command.trim() : '';
    if (!command) {
      resolveCommand({ statusCode: 400, payload: { error: 'Request body must include a non-empty command string' } });
      return;
    }

    const cwd = resolve(typeof body.cwd === 'string' && body.cwd.trim() ? body.cwd.trim() : agentDefaultCwd);
    if (!isPathInside(cwd, agentRoot)) {
      resolveCommand({
        statusCode: 403,
        payload: { error: `Command cwd must be inside ${agentRoot}` },
      });
      return;
    }

    const timeoutSeconds =
      typeof body.timeoutSeconds === 'number' && Number.isFinite(body.timeoutSeconds)
        ? Math.min(Math.max(Math.trunc(body.timeoutSeconds), 1), agentMaxTimeoutSeconds)
        : Math.min(600, agentMaxTimeoutSeconds);
    const maxOutputBytes =
      typeof body.maxOutputBytes === 'number' && Number.isFinite(body.maxOutputBytes)
        ? Math.min(Math.max(Math.trunc(body.maxOutputBytes), 1024), agentMaxOutputBytes)
        : agentMaxOutputBytes;
    const startedAt = new Date().toISOString();
    const child = spawn('/bin/zsh', ['-lc', command], {
      cwd,
      env: process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutSeconds * 1000);

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', async (error) => {
      clearTimeout(timer);
      const finishedAt = new Date().toISOString();
      const payload = {
        status: 'error',
        command,
        cwd,
        exitCode: null,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        stdoutTruncated: false,
        stderrTruncated: false,
        startedAt,
        finishedAt,
        durationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
      };
      const hostLogFilePath = await writeAgentCommandLog(payload);
      resolveCommand({ statusCode: 200, payload: { ...payload, hostLogFilePath } });
    });
    child.on('close', async (code) => {
      clearTimeout(timer);
      const finishedAt = new Date().toISOString();
      const stdoutBuffer = Buffer.concat(stdout);
      const stderrBuffer = Buffer.concat(stderr);
      const stdoutText = truncateUtf8(stdoutBuffer, maxOutputBytes);
      const stderrText = truncateUtf8(stderrBuffer, maxOutputBytes);
      const payload = {
        status: timedOut ? 'timed_out' : code === 0 ? 'completed' : 'failed',
        command,
        cwd,
        exitCode: code,
        stdout: stdoutText.text,
        stderr: stderrText.text,
        stdoutTruncated: stdoutText.truncated,
        stderrTruncated: stderrText.truncated,
        startedAt,
        finishedAt,
        durationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
        outputBytes: {
          stdout: stdoutBuffer.byteLength,
          stderr: stderrBuffer.byteLength,
        },
      };
      const hostLogFilePath = await writeAgentCommandLog({
        ...payload,
        stdout: stdoutBuffer.toString('utf8'),
        stderr: stderrBuffer.toString('utf8'),
      });
      resolveCommand({ statusCode: 200, payload: { ...payload, hostLogFilePath } });
    });
  });
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    sendJson(response, 200, {
      status: 'ok',
      providers: Object.keys(providers).map((path) => path.slice(1)),
      agentCommand: true,
      agentRoot,
      agentDefaultCwd,
      agentLogDirectory,
    });
    return;
  }

  if (request.method === 'POST' && request.url === '/command') {
    try {
      const body = await readJson(request);
      const { statusCode, payload } = await runAgentCommand(body);
      sendJson(response, statusCode, payload);
    } catch (error) {
      sendJson(response, error.statusCode ?? 500, { error: error instanceof Error ? error.message : String(error) });
    }
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
