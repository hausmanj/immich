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
const commandTargets = {
  local: {
    key: 'local',
    label: process.env.ASSISTANT_BRIDGE_LOCAL_LABEL ?? 'Mac host',
    kind: 'local',
    root: agentRoot,
    defaultCwd: agentDefaultCwd,
    logDirectory: agentLogDirectory,
    shell: process.env.ASSISTANT_BRIDGE_LOCAL_SHELL ?? '/bin/zsh',
    shellArgs: parseArgs(process.env.ASSISTANT_BRIDGE_LOCAL_SHELL_ARGS, ['-lc']),
  },
  synology: {
    key: 'synology',
    label: process.env.ASSISTANT_BRIDGE_SYNOLOGY_LABEL ?? 'Synology',
    kind: 'ssh',
    enabled: true,
    host: process.env.ASSISTANT_BRIDGE_SYNOLOGY_HOST ?? 'drhaus',
    port: process.env.ASSISTANT_BRIDGE_SYNOLOGY_PORT ?? '22222',
    user: process.env.ASSISTANT_BRIDGE_SYNOLOGY_USER ?? 'hausmanj',
    root: process.env.ASSISTANT_BRIDGE_SYNOLOGY_ROOT ?? '/volume1',
    defaultCwd: process.env.ASSISTANT_BRIDGE_SYNOLOGY_DEFAULT_CWD ?? process.env.ASSISTANT_BRIDGE_SYNOLOGY_ROOT ?? '/volume1',
    logDirectory: resolve(process.env.ASSISTANT_BRIDGE_SYNOLOGY_LOG_DIR ?? agentLogDirectory),
    sshOptions: parseArgs(process.env.ASSISTANT_BRIDGE_SYNOLOGY_SSH_OPTIONS, [
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
    ]),
  },
  immich: {
    key: 'immich',
    label: process.env.ASSISTANT_BRIDGE_IMMICH_LABEL ?? 'Immich container',
    kind: 'docker',
    enabled: true,
    container: process.env.ASSISTANT_BRIDGE_IMMICH_CONTAINER ?? 'immich_server',
    root: process.env.ASSISTANT_BRIDGE_IMMICH_ROOT ?? '/',
    defaultCwd: process.env.ASSISTANT_BRIDGE_IMMICH_DEFAULT_CWD ?? '/usr/src/app',
    logDirectory: resolve(process.env.ASSISTANT_BRIDGE_IMMICH_LOG_DIR ?? agentLogDirectory),
    shell: process.env.ASSISTANT_BRIDGE_IMMICH_SHELL ?? '/bin/bash',
  },
};

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

function runProvider(providerName, provider, input, timeoutSeconds) {
  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    const child = spawn(provider.command, provider.args, {
      env: process.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
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
      const logFilePath = await writeProviderLog({
        provider: providerName,
        command: provider.command,
        args: provider.args,
        status: 'error',
        inputBytes: Buffer.byteLength(input, 'utf8'),
        timeoutSeconds,
        exitCode: null,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        startedAt,
        finishedAt,
        durationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
      });
      resolve({
        statusCode: 500,
        payload: {
          error: `Assistant bridge provider ${providerName} failed to start. Full provider log: ${logFilePath}`,
          logFilePath,
        },
      });
    });
    child.on('close', async (code) => {
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString('utf8').trim();
      const errorOutput = Buffer.concat(stderr).toString('utf8').trim();
      const finishedAt = new Date().toISOString();
      const logFilePath = await writeProviderLog({
        provider: providerName,
        command: provider.command,
        args: provider.args,
        status: timedOut ? 'timed_out' : code === 0 ? 'completed' : 'failed',
        inputBytes: Buffer.byteLength(input, 'utf8'),
        timeoutSeconds,
        exitCode: code,
        stdout: output,
        stderr: errorOutput,
        startedAt,
        finishedAt,
        durationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
      });
      if (code !== 0) {
        resolve({
          statusCode: 500,
          payload: {
            error: timedOut
              ? `Assistant bridge provider ${providerName} timed out after ${timeoutSeconds} seconds. Full provider log: ${logFilePath}`
              : `Assistant bridge provider ${providerName} exited with ${code}. Full provider log: ${logFilePath}`,
            logFilePath,
          },
        });
        return;
      }

      resolve({ statusCode: 200, payload: { stdout: output, stderr: errorOutput, logFilePath } });
    });

    child.stdin.end(input);
  });
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(payload));
}

function toCommandTargetSummary(target) {
  return {
    key: target.key,
    label: target.label,
    kind: target.kind,
    enabled: target.kind === 'local' ? true : target.enabled,
    root: target.root,
    defaultCwd: target.defaultCwd,
    container: target.kind === 'docker' ? target.container : undefined,
  };
}

function isPathInside(path, root) {
  if (root === '/') {
    return path.startsWith('/');
  }

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

async function writeAgentCommandLog(payload, logDirectory = agentLogDirectory) {
  await mkdir(logDirectory, { recursive: true });
  const startedAt = typeof payload.startedAt === 'string' ? payload.startedAt : new Date().toISOString();
  const logFilePath = join(logDirectory, `${toSafeLogName(startedAt)}-agent-command-${randomUUID()}.json`);
  await mkdir(dirname(logFilePath), { recursive: true });
  await writeFile(logFilePath, JSON.stringify({ ...payload, hostLogFilePath: logFilePath }, null, 2));
  return logFilePath;
}

async function writeProviderLog(payload) {
  await mkdir(agentLogDirectory, { recursive: true });
  const startedAt = typeof payload.startedAt === 'string' ? payload.startedAt : new Date().toISOString();
  const logFilePath = join(agentLogDirectory, `${toSafeLogName(startedAt)}-provider-${randomUUID()}.json`);
  await mkdir(dirname(logFilePath), { recursive: true });
  await writeFile(logFilePath, JSON.stringify({ ...payload, hostLogFilePath: logFilePath }, null, 2));
  return logFilePath;
}

function toCommandTarget(value) {
  const key = typeof value === 'string' && value.trim() ? value.trim() : 'local';
  return commandTargets[key] ?? null;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function toSpawnPlan(target, cwd, command) {
  if (target.kind === 'local') {
    return {
      command: target.shell,
      args: [...target.shellArgs, command],
      cwd,
    };
  }

  if (target.kind === 'docker') {
    return {
      command: 'docker',
      args: ['exec', '-w', cwd, target.container, target.shell, '-lc', command],
      cwd: process.cwd(),
    };
  }

  const remote = target.user ? `${target.user}@${target.host}` : target.host;
  return {
    command: 'ssh',
    args: [
      ...target.sshOptions,
      '-p',
      String(target.port),
      remote,
      `cd ${shellQuote(cwd)} && ${command}`,
    ],
    cwd: process.cwd(),
  };
}

function runAgentCommand(body) {
  return new Promise((resolveCommand) => {
    const command = typeof body.command === 'string' ? body.command.trim() : '';
    if (!command) {
      resolveCommand({ statusCode: 400, payload: { error: 'Request body must include a non-empty command string' } });
      return;
    }

    const target = toCommandTarget(body.target);
    if (!target) {
      resolveCommand({ statusCode: 400, payload: { error: `Unknown command target: ${body.target}` } });
      return;
    }

    if (target.kind !== 'local' && !target.enabled) {
      resolveCommand({
        statusCode: 400,
        payload: {
          error: `Command target ${target.key} is disabled. Check bridge target configuration and connectivity.`,
        },
      });
      return;
    }

    const cwd =
      target.kind === 'local'
        ? resolve(typeof body.cwd === 'string' && body.cwd.trim() ? body.cwd.trim() : target.defaultCwd)
        : typeof body.cwd === 'string' && body.cwd.trim()
          ? body.cwd.trim()
          : target.defaultCwd;
    if (!isPathInside(cwd, target.root)) {
      resolveCommand({
        statusCode: 403,
        payload: { error: `Command cwd must be inside ${target.root} for target ${target.key}` },
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
    const spawnPlan = toSpawnPlan(target, cwd, command);
    const child = spawn(spawnPlan.command, spawnPlan.args, {
      cwd: spawnPlan.cwd,
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
        target: target.key,
        targetKind: target.kind,
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
      const hostLogFilePath = await writeAgentCommandLog(payload, target.logDirectory);
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
        target: target.key,
        targetKind: target.kind,
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
      }, target.logDirectory);
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
      commandTargets: Object.values(commandTargets).map(toCommandTargetSummary),
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
    const providerName = request.url.slice(1);
    const { statusCode, payload } = await runProvider(providerName, provider, body.input, timeoutSeconds);
    sendJson(response, statusCode, payload);
  } catch (error) {
    sendJson(response, error.statusCode ?? 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(port, host, () => {
  console.log(`Assistant CLI bridge listening on http://${host}:${port}`);
});
