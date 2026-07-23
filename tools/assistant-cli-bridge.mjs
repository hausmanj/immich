#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { dirname, join, resolve } from 'node:path';

const host = process.env.ASSISTANT_BRIDGE_HOST ?? '127.0.0.1';
const port = Number.parseInt(process.env.ASSISTANT_BRIDGE_PORT ?? '3737', 10);
const maxBodyBytes = Number.parseInt(process.env.ASSISTANT_BRIDGE_MAX_BODY_BYTES ?? String(16 * 1024 * 1024), 10);
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

const agentStream = {
  command: process.env.ASSISTANT_BRIDGE_AGENT_STREAM_COMMAND ?? 'claude',
  baseArgs: parseArgs(process.env.ASSISTANT_BRIDGE_AGENT_STREAM_ARGS, [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
  ]),
  model: process.env.ASSISTANT_BRIDGE_AGENT_STREAM_MODEL ?? '',
  defaultCwd: resolve(process.env.ASSISTANT_BRIDGE_AGENT_STREAM_CWD ?? agentDefaultCwd),
  defaultPermissionMode: process.env.ASSISTANT_BRIDGE_AGENT_STREAM_PERMISSION_MODE ?? 'default',
  timeoutSeconds: Number.parseInt(process.env.ASSISTANT_BRIDGE_AGENT_STREAM_TIMEOUT_SECONDS ?? '3600', 10),
  heartbeatMs: Number.parseInt(process.env.ASSISTANT_BRIDGE_AGENT_STREAM_HEARTBEAT_MS ?? '15000', 10),
};

const agentStreamCodex = {
  command: process.env.ASSISTANT_BRIDGE_AGENT_STREAM_CODEX_COMMAND ?? 'codex',
};

// ── Rolling context checkpoint ────────────────────────────────────────────────
// Each agent-stream turn spawns a fresh `claude --print --resume <id>`; because that is a separate
// process every turn, there is no prompt-cache carryover and the whole growing transcript is re-sent
// uncached, so cost grows ~quadratically with conversation length. To bound it, we track each session's
// context size and, once it crosses a threshold, summarize the session to a durable file and reseed a
// FRESH (small) session from that summary. This is transparent to the console, which already adopts the
// new session_id from the stream's init/result events.
const sessionStateDir = resolve(
  process.env.ASSISTANT_BRIDGE_SESSION_STATE_DIR ?? join(dirname(agentLogDirectory), 'assistant-agent-sessions'),
);
const sessionStateFile = join(sessionStateDir, 'sessions.json');
const promptArchiveDir = resolve(
  process.env.ASSISTANT_BRIDGE_PROMPT_ARCHIVE_DIR ?? join(sessionStateDir, 'prompt-archive'),
);
const checkpointTokens = Number.parseInt(process.env.ASSISTANT_BRIDGE_CHECKPOINT_TOKENS ?? '120000', 10);
const checkpointTurns = Number.parseInt(process.env.ASSISTANT_BRIDGE_CHECKPOINT_TURNS ?? '40', 10);
const checkpointSummaryTimeoutSeconds = Number.parseInt(
  process.env.ASSISTANT_BRIDGE_CHECKPOINT_SUMMARY_TIMEOUT_SECONDS ?? '180',
  10,
);
const checkpointModel = (process.env.ASSISTANT_BRIDGE_CHECKPOINT_MODEL ?? '').trim();
const checkpointEnabled = (process.env.ASSISTANT_BRIDGE_CHECKPOINT_ENABLED ?? '1') !== '0';
const summaryPrompt =
  'Produce a concise but COMPLETE handoff summary of THIS session so a brand-new session can continue ' +
  'with no other context. Include: the user goal(s); key decisions, constraints and preferences; what has ' +
  'been done so far; the current state; any open background jobs with their handles/paths (e.g. progress ' +
  'files, plan/journal files); important file paths; and the exact next steps. Use compact markdown. Do ' +
  'not ask questions and do not use tools — output only the summary text.';

// sessionId -> { engine, cwd, turnCount, contextTokens, createdAt, updatedAt, checkpointedFrom }
const sessionState = new Map();

async function loadSessionState() {
  try {
    const raw = await readFile(sessionStateFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.sessions) {
      for (const [id, value] of Object.entries(parsed.sessions)) sessionState.set(id, value);
    }
  } catch {
    // No prior state (first run) or unreadable — start empty.
  }
}

async function saveSessionState() {
  try {
    await mkdir(sessionStateDir, { recursive: true });
    const sessions = Object.fromEntries(sessionState);
    const tmp = `${sessionStateFile}.tmp`;
    await writeFile(tmp, JSON.stringify({ updatedAt: new Date().toISOString(), sessions }, null, 2));
    const { rename } = await import('node:fs/promises');
    await rename(tmp, sessionStateFile);
  } catch {
    // Persistence is best-effort; in-memory state still governs this bridge lifetime.
  }
}

function needsCheckpoint(state) {
  if (!checkpointEnabled || !state) return false;
  if (checkpointTokens > 0 && typeof state.contextTokens === 'number' && state.contextTokens >= checkpointTokens) {
    return true;
  }
  if (checkpointTurns > 0 && typeof state.turnCount === 'number' && state.turnCount >= checkpointTurns) {
    return true;
  }
  return false;
}

function checkpointReason(state) {
  if (checkpointTokens > 0 && typeof state.contextTokens === 'number' && state.contextTokens >= checkpointTokens) {
    return 'tokens';
  }
  return 'turns';
}

// Parse a completed turn's stream-json transcript for the resulting session id and its context size.
function parseTurnResult(engine, transcript) {
  let sessionId = null;
  let contextTokens = null;
  for (let i = transcript.length - 1; i >= 0; i--) {
    let event;
    try {
      event = JSON.parse(transcript[i]);
    } catch {
      continue;
    }
    if (engine === 'codex') {
      if (!sessionId && event.type === 'thread.started' && event.thread_id) sessionId = event.thread_id;
      if (contextTokens === null && event.usage && typeof event.usage.input_tokens === 'number') {
        contextTokens = event.usage.input_tokens + (event.usage.cached_input_tokens ?? 0);
      }
    } else {
      if (event.type === 'result') {
        if (event.session_id) sessionId = event.session_id;
        const u = event.usage ?? {};
        contextTokens =
          (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      } else if (!sessionId && event.type === 'system' && event.subtype === 'init' && event.session_id) {
        sessionId = event.session_id;
      }
    }
    if (sessionId && contextTokens !== null) break;
  }
  return { sessionId, contextTokens };
}

// Capture the full stdout of a one-shot child (used for the summarization pre-step).
function spawnCapture(command, args, { cwd, input, timeoutSeconds }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, env: process.env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, Math.max(1, timeoutSeconds) * 1000);
    child.stdout.on('data', (c) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c) => (stderr += c.toString('utf8')));
    child.on('error', (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) rejectPromise(new Error('summarization timed out'));
      else resolvePromise({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

// Ask the engine to summarize the session we are about to abandon, returning plain text.
async function summarizeSession(engine, sessionId, cwd) {
  if (engine === 'codex') {
    const args = ['exec', 'resume', '--skip-git-repo-check', sessionId, '-'];
    const { stdout } = await spawnCapture(agentStreamCodex.command, args, {
      cwd,
      input: summaryPrompt,
      timeoutSeconds: checkpointSummaryTimeoutSeconds,
    });
    return stdout.trim();
  }
  const args = ['--print', '--output-format', 'text', '--resume', sessionId];
  if (checkpointModel) args.push('--model', checkpointModel);
  const { stdout } = await spawnCapture(agentStream.command, args, {
    cwd,
    input: summaryPrompt,
    timeoutSeconds: checkpointSummaryTimeoutSeconds,
  });
  return stdout.trim();
}

async function writeCheckpointFile(sessionId, summary, engine) {
  await mkdir(sessionStateDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(sessionStateDir, `session-${engine}-${sessionId.slice(0, 8)}-${stamp}.md`);
  const header = `# Session checkpoint\n\n- engine: ${engine}\n- priorSessionId: ${sessionId}\n- checkpointedAt: ${new Date().toISOString()}\n\n`;
  await writeFile(file, header + summary + '\n');
  return file;
}

function buildReseedPreamble(summary, priorSessionId, checkpointFile) {
  return (
    '[Session continuity] You are continuing a longer conversation that was automatically checkpointed to ' +
    'keep context small and token-efficient. The full prior transcript is intentionally NOT loaded; the ' +
    'authoritative handoff summary below (also saved at ' +
    checkpointFile +
    ') captures everything so far. Continue seamlessly and treat it as the source of truth for what has ' +
    'already happened. Prior session id: ' +
    priorSessionId +
    '.\n\n===== HANDOFF SUMMARY =====\n' +
    summary +
    '\n===== END HANDOFF SUMMARY =====\n'
  );
}

function promptRequestDetails(body) {
  return {
    model: typeof body.model === 'string' ? body.model : null,
    codexModel: typeof body.codexModel === 'string' ? body.codexModel : null,
    codexEffort: typeof body.codexEffort === 'string' ? body.codexEffort : null,
    permissionMode: typeof body.permissionMode === 'string' ? body.permissionMode : null,
    allowedTools: Array.isArray(body.allowedTools) ? body.allowedTools.map(String) : [],
    disallowedTools: Array.isArray(body.disallowedTools) ? body.disallowedTools.map(String) : [],
    addDirs: Array.isArray(body.addDirs) ? body.addDirs.map(String) : [],
    mcpConfig: typeof body.mcpConfig === 'string' ? body.mcpConfig : null,
    strictMcpConfig: body.strictMcpConfig === true,
    dangerouslySkipPermissions: body.dangerouslySkipPermissions === true,
  };
}

async function archivePromptAccepted({ body, cwd, engine, receivedAt, runId, timeoutSeconds }) {
  await mkdir(promptArchiveDir, { recursive: true });
  const stamp = toSafeLogName(receivedAt);
  const archiveFilePath = join(promptArchiveDir, `prompt-${engine}-${stamp}-${runId}.md`);
  const archiveIndexPath = join(promptArchiveDir, `${receivedAt.slice(0, 10)}.jsonl`);
  const requestedSessionId = typeof body.sessionId === 'string' && body.sessionId.trim() ? body.sessionId.trim() : null;
  const appendSystemPrompt =
    typeof body.appendSystemPrompt === 'string' && body.appendSystemPrompt.trim() ? body.appendSystemPrompt : null;
  const requestDetails = promptRequestDetails(body);
  const accepted = {
    schemaVersion: 1,
    event: 'accepted',
    promptId: runId,
    runId,
    receivedAt,
    engine,
    requestedSessionId,
    cwd,
    timeoutSeconds,
    inputBytes: Buffer.byteLength(body.input, 'utf8'),
    input: body.input,
    appendSystemPrompt,
    requestDetails,
    archiveFilePath,
  };
  const markdown =
    '# Archived agent prompt\n\n' +
    `- promptId: ${runId}\n` +
    `- receivedAt: ${receivedAt}\n` +
    `- engine: ${engine}\n` +
    `- requestedSessionId: ${requestedSessionId ?? 'new'}\n` +
    `- cwd: ${cwd}\n` +
    `- timeoutSeconds: ${timeoutSeconds}\n` +
    `- dailyIndex: ${archiveIndexPath}\n\n` +
    '## Request details\n\n' +
    '```json\n' +
    JSON.stringify(requestDetails, null, 2) +
    '\n```\n\n' +
    '## User prompt\n\n' +
    body.input +
    '\n\n' +
    '## Console/system prompt\n\n' +
    (appendSystemPrompt ?? '(none)') +
    '\n';

  // The prompt file is written first and exclusively. If this fails, the model is not started: no prompt
  // should execute without its durable memory record already existing.
  await writeFile(archiveFilePath, markdown, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  await appendFile(archiveIndexPath, JSON.stringify(accepted) + '\n', { encoding: 'utf8', mode: 0o600 });
  return { archiveFilePath, archiveIndexPath };
}

async function archivePromptEvent(archive, event) {
  const recordedAt = new Date().toISOString();
  const record = { schemaVersion: 1, promptId: event.runId, recordedAt, ...event };
  await appendFile(archive.archiveIndexPath, JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 });
  await appendFile(
    archive.archiveFilePath,
    '\n## ' +
      event.event.replaceAll('_', ' ') +
      '\n\n```json\n' +
      JSON.stringify({ recordedAt, ...event }, null, 2) +
      '\n```\n',
    { encoding: 'utf8' },
  );
}

async function tryArchivePromptEvent(archive, event) {
  try {
    await archivePromptEvent(archive, event);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

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

async function writeAgentStreamLog(payload) {
  await mkdir(agentLogDirectory, { recursive: true });
  const startedAt = typeof payload.startedAt === 'string' ? payload.startedAt : new Date().toISOString();
  const logFilePath = join(agentLogDirectory, `${toSafeLogName(startedAt)}-agent-stream-${payload.runId ?? randomUUID()}.json`);
  await mkdir(dirname(logFilePath), { recursive: true });
  await writeFile(logFilePath, JSON.stringify({ ...payload, hostLogFilePath: logFilePath }, null, 2));
  return logFilePath;
}

function buildAgentStreamArgs(body) {
  const args = [...agentStream.baseArgs];
  const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : agentStream.model;
  if (model) args.push('--model', model);
  const permissionMode =
    typeof body.permissionMode === 'string' && body.permissionMode.trim()
      ? body.permissionMode.trim()
      : agentStream.defaultPermissionMode;
  if (permissionMode) args.push('--permission-mode', permissionMode);
  if (typeof body.sessionId === 'string' && body.sessionId.trim()) args.push('--resume', body.sessionId.trim());
  if (Array.isArray(body.allowedTools) && body.allowedTools.length) {
    args.push('--allowedTools', ...body.allowedTools.map(String));
  }
  if (Array.isArray(body.disallowedTools) && body.disallowedTools.length) {
    args.push('--disallowedTools', ...body.disallowedTools.map(String));
  }
  if (typeof body.appendSystemPrompt === 'string' && body.appendSystemPrompt.trim()) {
    args.push('--append-system-prompt', body.appendSystemPrompt);
  }
  if (Array.isArray(body.addDirs)) {
    for (const dir of body.addDirs) {
      if (typeof dir === 'string' && dir.trim()) args.push('--add-dir', dir.trim());
    }
  }
  if (typeof body.mcpConfig === 'string' && body.mcpConfig.trim()) args.push('--mcp-config', body.mcpConfig.trim());
  if (body.strictMcpConfig === true) args.push('--strict-mcp-config');
  if (body.dangerouslySkipPermissions === true) args.push('--dangerously-skip-permissions');
  return args;
}

function buildCodexArgs(body, cwd, imageFiles = []) {
  // Older assistant used `codex exec -` (stdin); streaming uses `codex exec --json`.
  const args = ['exec'];
  const resumeSessionId = typeof body.sessionId === 'string' && body.sessionId.trim() ? body.sessionId.trim() : '';
  if (resumeSessionId) args.push('resume');
  args.push('--json', '--skip-git-repo-check');
  if (!resumeSessionId) args.push('-C', cwd);
  const bypass =
    body.dangerouslySkipPermissions === true ||
    (typeof body.permissionMode === 'string' && body.permissionMode.toLowerCase().indexOf('bypass') >= 0);
  if (bypass) args.push('--dangerously-bypass-approvals-and-sandbox');
  const codexModel =
    typeof body.codexModel === 'string' && body.codexModel.trim()
      ? body.codexModel.trim()
      : (process.env.ASSISTANT_BRIDGE_AGENT_STREAM_CODEX_MODEL ?? 'gpt-5.6-sol');
  if (codexModel) args.push('-m', codexModel);
  for (const imageFile of imageFiles) args.push('--image', imageFile);
  const effort = typeof body.codexEffort === 'string' && body.codexEffort.trim() ? body.codexEffort.trim() : 'high';
  args.push('-c', 'model_reasoning_effort="' + effort + '"');
  if (resumeSessionId) args.push(resumeSessionId, '-');
  return args;
}

async function materializeImages(body) {
  const images = Array.isArray(body.images) ? body.images : [];
  if (images.length > 5) throw new Error('At most 5 pasted images can be attached to one prompt');
  const files = [];
  for (const [index, image] of images.entries()) {
    const dataUrl = typeof image === 'string' ? image : image?.dataUrl;
    if (typeof dataUrl !== 'string' || !/^data:image\/(png|jpe?g|gif|webp|heic);base64,/i.test(dataUrl)) {
      throw new Error(`Invalid pasted image ${index + 1}`);
    }
    const match = dataUrl.match(/^data:image\/(png|jpe?g|gif|webp|heic);base64,(.+)$/i);
    const data = Buffer.from(match[2], 'base64');
    if (!data.length || data.length > 12 * 1024 * 1024) throw new Error(`Pasted image ${index + 1} exceeds 12 MB`);
    const extension = match[1].toLowerCase().replace('jpeg', 'jpg');
    const path = `/private/tmp/immich-agent-image-${randomUUID()}.${extension}`;
    await writeFile(path, data, { mode: 0o600 });
    files.push(path);
  }
  return files;
}

async function runAgentStream(response, body) {
  const requestedCwd = typeof body.cwd === 'string' && body.cwd.trim() ? resolve(body.cwd.trim()) : agentStream.defaultCwd;
  const cwd = isPathInside(requestedCwd, agentRoot) ? requestedCwd : agentStream.defaultCwd;
  const timeoutSeconds =
    typeof body.timeoutSeconds === 'number' && Number.isFinite(body.timeoutSeconds)
      ? Math.min(Math.max(Math.trunc(body.timeoutSeconds), 1), agentMaxTimeoutSeconds)
      : agentStream.timeoutSeconds;
  const engine = body.engine === 'codex' ? 'codex' : 'claude';
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const promptArchive = await archivePromptAccepted({ body, cwd, engine, receivedAt: startedAt, runId, timeoutSeconds });
  const imageFiles = await materializeImages(body);

  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const sse = (event, data) => {
    if (response.writableEnded) return;
    if (event) response.write(`event: ${event}\n`);
    response.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
  };

  // ── Rolling checkpoint pre-step: if the session we are about to resume has grown past the threshold,
  // summarize it to a durable file and reseed a fresh session from that summary instead of resuming.
  const priorSessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
  let didCheckpoint = false;
  if (priorSessionId) {
    const priorState = sessionState.get(priorSessionId);
    if (needsCheckpoint(priorState)) {
      sse('bridge_checkpoint', {
        status: 'summarizing',
        priorSessionId,
        reason: checkpointReason(priorState),
        contextTokens: priorState.contextTokens ?? null,
        turnCount: priorState.turnCount ?? null,
      });
      try {
        const summary = await summarizeSession(engine, priorSessionId, cwd);
        if (summary && summary.length > 0) {
          const checkpointFile = await writeCheckpointFile(priorSessionId, summary, engine);
          const preamble = buildReseedPreamble(summary, priorSessionId, checkpointFile);
          const existingAppend =
            typeof body.appendSystemPrompt === 'string' && body.appendSystemPrompt.trim()
              ? '\n\n' + body.appendSystemPrompt
              : '';
          body = { ...body, sessionId: '', appendSystemPrompt: preamble + existingAppend };
          didCheckpoint = true;
          sse('bridge_checkpoint', { status: 'reseeded', priorSessionId, checkpointFile, summaryChars: summary.length });
        } else {
          sse('bridge_checkpoint', { status: 'summary_empty', priorSessionId });
        }
      } catch (error) {
        // Fail safe: if summarization fails, keep resuming the old session rather than lose context.
        sse('bridge_checkpoint', { status: 'summary_failed', priorSessionId, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  const command = engine === 'codex' ? agentStreamCodex.command : agentStream.command;
  const args = engine === 'codex' ? buildCodexArgs(body, cwd, imageFiles) : buildAgentStreamArgs(body);
  const stdinInput =
    engine === 'codex' && typeof body.appendSystemPrompt === 'string' && body.appendSystemPrompt.trim()
      ? body.appendSystemPrompt + '\n\n==== USER REQUEST ====\n\n' + body.input + (engine === 'claude' && imageFiles.length ? `\n\n[Pasted image file(s): ${imageFiles.join(', ')}]` : '')
      : body.input + (engine === 'claude' && imageFiles.length ? `\n\n[Pasted image file(s): ${imageFiles.join(', ')}]` : '');

  const dispatchArchiveError = await tryArchivePromptEvent(promptArchive, {
    event: 'dispatched',
    runId,
    engine,
    effectiveSessionId: typeof body.sessionId === 'string' && body.sessionId.trim() ? body.sessionId.trim() : null,
    checkpointed: didCheckpoint,
    effectiveAppendSystemPrompt:
      typeof body.appendSystemPrompt === 'string' && body.appendSystemPrompt.trim() ? body.appendSystemPrompt : null,
    command,
    args,
  });

  sse('bridge_start', {
    runId,
    startedAt,
    engine,
    command,
    args,
    cwd,
    timeoutSeconds,
    checkpointed: didCheckpoint,
    promptArchiveFilePath: promptArchive.archiveFilePath,
    promptArchiveIndexPath: promptArchive.archiveIndexPath,
    promptArchiveError: dispatchArchiveError,
  });

  const child = spawn(command, args, { cwd, env: process.env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  const transcript = [];
  let stdoutBuf = '';
  let stderrText = '';
  let timedOut = false;

  const heartbeat = setInterval(() => {
    if (!response.writableEnded) response.write(': ping\n\n');
  }, agentStream.heartbeatMs);
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
  }, timeoutSeconds * 1000);

  response.on('close', () => {
    if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
  });

  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString('utf8');
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      transcript.push(line);
      sse(null, line);
    }
  });
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    stderrText += text;
    sse('stderr', { text });
  });
  child.on('error', async (error) => {
    clearInterval(heartbeat);
    clearTimeout(timer);
    const message = error instanceof Error ? error.message : String(error);
    await Promise.all(imageFiles.map((file) => rm(file, { force: true }).catch(() => {})));
    const finishedAt = new Date().toISOString();
    const logFilePath = await writeAgentStreamLog({
      runId,
      command,
      args,
      cwd,
      startedAt,
      finishedAt,
      status: 'error',
      exitCode: null,
      stderr: message,
      transcript,
      promptArchiveFilePath: promptArchive.archiveFilePath,
    });
    const promptArchiveError = await tryArchivePromptEvent(promptArchive, {
      event: 'start_failed',
      runId,
      finishedAt,
      error: message,
      logFilePath,
    });
    sse('bridge_error', { runId, error: message, logFilePath, promptArchiveFilePath: promptArchive.archiveFilePath, promptArchiveError });
    response.end();
  });
  child.on('close', async (code) => {
    clearInterval(heartbeat);
    clearTimeout(timer);
    const rest = stdoutBuf.trim();
    if (rest) {
      transcript.push(rest);
      sse(null, rest);
    }
    const finishedAt = new Date().toISOString();
    await Promise.all(imageFiles.map((file) => rm(file, { force: true }).catch(() => {})));
    const logFilePath = await writeAgentStreamLog({
      runId,
      command,
      args,
      cwd,
      startedAt,
      finishedAt,
      status: timedOut ? 'timed_out' : code === 0 ? 'completed' : 'failed',
      exitCode: code,
      timedOut,
      stderr: stderrText,
      transcript,
      promptArchiveFilePath: promptArchive.archiveFilePath,
    });
    // Record the resulting session's size so the NEXT turn can decide whether to checkpoint.
    let sessionInfo = null;
    if (!timedOut && code === 0) {
      const parsed = parseTurnResult(engine, transcript);
      if (parsed.sessionId) {
        const prior = priorSessionId ? sessionState.get(priorSessionId) : null;
        const turnCount = didCheckpoint ? 1 : (prior?.turnCount ?? 0) + 1;
        const existing = sessionState.get(parsed.sessionId);
        sessionState.set(parsed.sessionId, {
          engine,
          cwd,
          turnCount,
          contextTokens: parsed.contextTokens ?? prior?.contextTokens ?? null,
          createdAt: existing?.createdAt ?? startedAt,
          updatedAt: finishedAt,
          checkpointedFrom: didCheckpoint ? priorSessionId : prior?.checkpointedFrom ?? null,
        });
        // The old lineage is abandoned after a reseed (or when the id forks) — drop it so it can't retrigger.
        if (priorSessionId && priorSessionId !== parsed.sessionId) sessionState.delete(priorSessionId);
        await saveSessionState();
        const st = sessionState.get(parsed.sessionId);
        sessionInfo = {
          sessionId: parsed.sessionId,
          turnCount: st.turnCount,
          contextTokens: st.contextTokens,
          willCheckpointNextTurn: needsCheckpoint(st),
        };
      }
    }

    const promptArchiveError = await tryArchivePromptEvent(promptArchive, {
      event: 'finished',
      runId,
      finishedAt,
      status: timedOut ? 'timed_out' : code === 0 ? 'completed' : 'failed',
      exitCode: code,
      timedOut,
      eventCount: transcript.length,
      resultingSession: sessionInfo,
      logFilePath,
    });

    sse('bridge_done', {
      runId,
      exitCode: code,
      timedOut,
      finishedAt,
      logFilePath,
      eventCount: transcript.length,
      session: sessionInfo,
      promptArchiveFilePath: promptArchive.archiveFilePath,
      promptArchiveIndexPath: promptArchive.archiveIndexPath,
      promptArchiveError,
    });
    response.end();
  });

  child.stdin.end(stdinInput);
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    sendJson(response, 200, {
      status: 'ok',
      providers: Object.keys(providers).map((path) => path.slice(1)),
      agentCommand: true,
      agentStream: { enabled: true, command: agentStream.command, model: agentStream.model || null },
      agentRoot,
      agentDefaultCwd,
      agentLogDirectory,
      commandTargets: Object.values(commandTargets).map(toCommandTargetSummary),
      checkpoint: {
        enabled: checkpointEnabled,
        thresholdTokens: checkpointTokens,
        thresholdTurns: checkpointTurns,
        stateDir: sessionStateDir,
        trackedSessions: sessionState.size,
      },
      promptArchive: {
        enabled: true,
        mode: 'fail-closed-before-dispatch',
        directory: promptArchiveDir,
      },
    });
    return;
  }

  if (request.method === 'POST' && request.url === '/agent-stream') {
    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      sendJson(response, error.statusCode ?? 500, { error: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (!body || typeof body.input !== 'string' || body.input.trim().length === 0) {
      sendJson(response, 400, { error: 'Request body must include a non-empty input string' });
      return;
    }
    runAgentStream(response, body).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!response.writableEnded) {
        if (!response.headersSent) {
          sendJson(response, 500, { error: `Prompt archive failed; agent was not started: ${message}` });
          return;
        }
        try {
          response.write(`event: bridge_error\ndata: ${JSON.stringify({ error: message })}\n\n`);
        } catch {
          // response already torn down
        }
        response.end();
      }
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
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    const promptArchive = await archivePromptAccepted({
      body,
      cwd: process.cwd(),
      engine: providerName,
      receivedAt: startedAt,
      runId,
      timeoutSeconds,
    });
    const { statusCode, payload } = await runProvider(providerName, provider, body.input, timeoutSeconds);
    const finishedAt = new Date().toISOString();
    const promptArchiveError = await tryArchivePromptEvent(promptArchive, {
      event: 'finished',
      runId,
      finishedAt,
      status: statusCode === 200 ? 'completed' : 'failed',
      statusCode,
      logFilePath: payload.logFilePath ?? null,
    });
    sendJson(response, statusCode, {
      ...payload,
      promptArchiveFilePath: promptArchive.archiveFilePath,
      promptArchiveIndexPath: promptArchive.archiveIndexPath,
      promptArchiveError,
    });
  } catch (error) {
    sendJson(response, error.statusCode ?? 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

await loadSessionState();
server.listen(port, host, () => {
  console.log(`Assistant CLI bridge listening on http://${host}:${port}`);
  console.log(
    `Rolling checkpoint: ${checkpointEnabled ? 'on' : 'off'} (>=${checkpointTokens} ctx tokens or >=${checkpointTurns} turns) state=${sessionStateDir}`,
  );
});
