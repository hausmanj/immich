#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  access,
  copyFile,
  mkdir,
  opendir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';

const mediaExtensions = new Set([
  '.3gp',
  '.ari',
  '.arw',
  '.avif',
  '.cr2',
  '.cr3',
  '.dng',
  '.gif',
  '.heic',
  '.heif',
  '.jpeg',
  '.jpg',
  '.m4v',
  '.mov',
  '.mp4',
  '.mts',
  '.nef',
  '.orf',
  '.png',
  '.raf',
  '.rw2',
  '.tif',
  '.tiff',
  '.webp',
]);
const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const command = process.argv[2];
const args = parseArgs(process.argv.slice(3));

try {
  switch (command) {
    case 'plan': {
      await plan();
      break;
    }
    case 'apply': {
      await applyPlan();
      break;
    }
    case 'undo': {
      await undoJournal();
      break;
    }
    default: {
      usage();
      process.exitCode = 1;
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function parseArgs(values) {
  const parsed = { _: [] };
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (!value.startsWith('--')) {
      parsed._.push(value);
      continue;
    }

    const rawKey = value.slice(2);
    const [key, inlineValue] = rawKey.split(/=(.*)/s, 2);
    if (inlineValue !== undefined) {
      addArg(parsed, key, inlineValue);
      continue;
    }

    const next = values[index + 1];
    if (!next || next.startsWith('--')) {
      addArg(parsed, key, true);
      continue;
    }

    addArg(parsed, key, next);
    index++;
  }

  return parsed;
}

function addArg(parsed, key, value) {
  if (parsed[key] === undefined) {
    parsed[key] = value;
    return;
  }

  parsed[key] = Array.isArray(parsed[key]) ? [...parsed[key], value] : [parsed[key], value];
}

function usage() {
  console.error(`Usage:
  node tools/photo-file-organizer.mjs plan --source PATH --dest PATH [--event-name NAME] [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--plan-file PATH] [--folder-format apple-date|year-apple-date|iso-date|year-iso-date] [--mode move|copy] [--hash]
  node tools/photo-file-organizer.mjs apply --plan-file PATH [--journal-dir PATH]
  node tools/photo-file-organizer.mjs undo --journal-file PATH

Plan is read-only. Apply writes a journal before moving/copying. Undo uses that journal.`);
}

async function plan() {
  const sources = toArray(args.source).map((value) => resolve(String(value)));
  const destRoot = args.dest ? resolve(String(args.dest)) : null;
  if (sources.length === 0 || !destRoot) {
    throw new Error('plan requires --source and --dest');
  }

  const mode = args.mode === 'copy' ? 'copy' : 'move';
  const folderFormat = String(args['folder-format'] ?? 'apple-date');
  const eventName = typeof args['event-name'] === 'string' ? args['event-name'].trim() : null;
  const startDate = args.start ? parseDateOnly(String(args.start)) : null;
  const endDate = args.end ? parseDateOnly(String(args.end), true) : null;
  const extensions = args.extensions
    ? new Set(String(args.extensions).split(',').map((item) => normalizeExtension(item.trim())).filter(Boolean))
    : mediaExtensions;
  const maxDepth = args['max-depth'] === undefined ? null : Number(args['max-depth']);
  const shouldHash = args.hash === true || args.hash === 'true';
  const generatedAt = new Date().toISOString();
  const planFile =
    typeof args['plan-file'] === 'string'
      ? resolve(args['plan-file'])
      : resolve(`photo-file-plan-${toSafeName(generatedAt)}-${randomUUID()}.json`);

  const files = [];
  for (const source of sources) {
    files.push(...(await walkFiles(source, extensions, maxDepth)));
  }

  const metadata = await readExifMetadata(files.map((file) => file.path));
  const operations = [];
  for (const file of files) {
    const meta = metadata.get(file.path);
    const capture = getCaptureDate(file.path, meta, file.mtimeMs);
    if (!capture.date) {
      operations.push(toSkippedOperation(file, mode, 'missing_capture_date', null, null, null, shouldHash));
      continue;
    }

    if ((startDate && capture.date < startDate) || (endDate && capture.date > endDate)) {
      operations.push(toSkippedOperation(file, mode, 'outside_date_range', capture.date, capture.source, null, shouldHash));
      continue;
    }

    const folder = toDateFolder(capture.date, folderFormat);
    const destinationPath = resolve(destRoot, folder, file.name);
    const destinationState = await getDestinationState(destinationPath);
    const status = destinationState.exists ? 'conflict' : 'planned';
    operations.push({
      id: randomUUID(),
      status,
      reason: status === 'conflict' ? 'destination_exists' : null,
      action: mode,
      sourcePath: file.path,
      destinationPath,
      originalFileName: file.name,
      fileExtension: extname(file.name).toLowerCase(),
      fileSizeBytes: file.size,
      sourceModifiedAt: new Date(file.mtimeMs).toISOString(),
      captureDate: toDateOnly(capture.date),
      captureDateTime: capture.date.toISOString(),
      captureDateSource: capture.source,
      destinationState,
      sha1: shouldHash ? await sha1File(file.path) : null,
    });
  }

  const summary = summarizeOperations(operations);
  const payload = {
    schema: 'photo-file-organizer-plan-v1',
    generatedAt,
    id: randomUUID(),
    sourceRoots: sources,
    destinationRoot: destRoot,
    eventName,
    mode,
    folderFormat,
    filters: {
      start: args.start ?? null,
      end: args.end ?? null,
      extensions: [...extensions].sort(),
      maxDepth,
      hash: shouldHash,
    },
    summary,
    operations,
  };

  await mkdir(dirname(planFile), { recursive: true });
  await writeFile(planFile, `${JSON.stringify(payload, null, 2)}\n`);
  printJson({
    status: 'planned',
    planFile,
    summary,
  });
}

async function applyPlan() {
  const planFile = args['plan-file'] ? resolve(String(args['plan-file'])) : null;
  if (!planFile) {
    throw new Error('apply requires --plan-file');
  }

  const planPayload = JSON.parse(await readFile(planFile, 'utf8'));
  assertPlan(planPayload);
  const strict = args['allow-partial'] !== true && args['allow-partial'] !== 'true';
  const blocking = planPayload.operations.filter((operation) => operation.status !== 'planned');
  if (strict && blocking.length > 0) {
    throw new Error(
      `Plan has ${blocking.length} non-planned operations. Re-plan or pass --allow-partial to apply only planned rows.`,
    );
  }

  const journalDirectory =
    typeof args['journal-dir'] === 'string'
      ? resolve(args['journal-dir'])
      : resolve(dirname(planFile), 'photo-file-organizer-journals');
  const startedAt = new Date().toISOString();
  const journalFile = resolve(
    journalDirectory,
    `${toSafeName(startedAt)}-photo-file-organizer-${randomUUID()}.json`,
  );
  const journal = {
    schema: 'photo-file-organizer-journal-v1',
    id: randomUUID(),
    status: 'running',
    startedAt,
    finishedAt: null,
    planFile,
    planId: planPayload.id,
    sourceRoots: planPayload.sourceRoots,
    destinationRoot: planPayload.destinationRoot,
    eventName: planPayload.eventName,
    mode: planPayload.mode,
    folderFormat: planPayload.folderFormat,
    summaryBeforeApply: planPayload.summary,
    operations: planPayload.operations.map((operation) => ({
      ...operation,
      applyStatus: operation.status === 'planned' ? 'pending' : 'not_applied',
      appliedAt: null,
      error: null,
    })),
    undo: {
      status: 'not_started',
      startedAt: null,
      finishedAt: null,
      errors: [],
    },
  };

  await mkdir(journalDirectory, { recursive: true });
  await writeJournal(journalFile, journal);

  for (const operation of journal.operations) {
    if (operation.applyStatus !== 'pending') {
      continue;
    }

    try {
      await assertSourceStillMatches(operation);
      await assertDestinationAbsent(operation.destinationPath);
      await mkdir(dirname(operation.destinationPath), { recursive: true });
      if (operation.action === 'copy') {
        await copyFile(operation.sourcePath, operation.destinationPath);
      } else {
        await moveFile(operation.sourcePath, operation.destinationPath);
      }
      operation.applyStatus = operation.action === 'copy' ? 'copied' : 'moved';
      operation.appliedAt = new Date().toISOString();
    } catch (error) {
      operation.applyStatus = 'error';
      operation.error = error instanceof Error ? error.message : String(error);
    }

    await writeJournal(journalFile, journal);
  }

  journal.status = journal.operations.some((operation) => operation.applyStatus === 'error') ? 'completed_with_errors' : 'completed';
  journal.finishedAt = new Date().toISOString();
  await writeJournal(journalFile, journal);

  printJson({
    status: journal.status,
    journalFile,
    applied: journal.operations.filter((operation) => operation.applyStatus === 'moved' || operation.applyStatus === 'copied').length,
    errors: journal.operations.filter((operation) => operation.applyStatus === 'error').length,
    notApplied: journal.operations.filter((operation) => operation.applyStatus === 'not_applied').length,
  });
}

async function undoJournal() {
  const journalFile = args['journal-file'] ? resolve(String(args['journal-file'])) : null;
  if (!journalFile) {
    throw new Error('undo requires --journal-file');
  }

  const journal = JSON.parse(await readFile(journalFile, 'utf8'));
  assertJournal(journal);
  journal.undo.status = 'running';
  journal.undo.startedAt = new Date().toISOString();
  journal.undo.errors = [];
  await writeJournal(journalFile, journal);

  for (const operation of [...journal.operations].reverse()) {
    if (operation.applyStatus !== 'moved' && operation.applyStatus !== 'copied') {
      continue;
    }

    try {
      if (operation.action === 'copy') {
        await assertCopiedDestinationMatches(operation);
        await unlink(operation.destinationPath);
        operation.undoStatus = 'deleted_copy';
      } else {
        await assertDestinationPresent(operation.destinationPath);
        await assertDestinationAbsent(operation.sourcePath);
        await mkdir(dirname(operation.sourcePath), { recursive: true });
        await moveFile(operation.destinationPath, operation.sourcePath);
        operation.undoStatus = 'moved_back';
      }
      operation.undoneAt = new Date().toISOString();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      operation.undoStatus = 'error';
      operation.undoError = message;
      journal.undo.errors.push({ operationId: operation.id, message });
    }

    await writeJournal(journalFile, journal);
  }

  journal.undo.status = journal.undo.errors.length > 0 ? 'completed_with_errors' : 'completed';
  journal.undo.finishedAt = new Date().toISOString();
  await writeJournal(journalFile, journal);

  printJson({
    status: journal.undo.status,
    journalFile,
    undone: journal.operations.filter((operation) => operation.undoStatus === 'moved_back' || operation.undoStatus === 'deleted_copy')
      .length,
    errors: journal.undo.errors.length,
  });
}

async function walkFiles(root, extensions, maxDepth) {
  const rootState = await stat(root);
  if (rootState.isFile()) {
    return toFileEntry(root, rootState, root, extensions) ? [toFileEntry(root, rootState, root, extensions)] : [];
  }

  const files = [];
  const stack = [{ path: root, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop();
    const directory = await opendir(current.path);
    for await (const entry of directory) {
      const path = join(current.path, entry.name);
      if (entry.isDirectory()) {
        if (maxDepth === null || current.depth < maxDepth) {
          stack.push({ path, depth: current.depth + 1 });
        }
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const fileState = await stat(path);
      const fileEntry = toFileEntry(path, fileState, entry.name, extensions);
      if (fileEntry) {
        files.push(fileEntry);
      }
    }
  }

  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function toFileEntry(path, fileState, name, extensions) {
  const fileName = basename(name);
  const extension = extname(fileName).toLowerCase();
  if (!extensions.has(extension)) {
    return null;
  }

  return {
    path,
    name: fileName,
    size: fileState.size,
    mtimeMs: fileState.mtimeMs,
  };
}

async function readExifMetadata(paths) {
  const result = new Map();
  if (paths.length === 0 || args['no-exif'] === true || args['no-exif'] === 'true') {
    return result;
  }

  const exiftool = spawnSync('exiftool', ['-ver'], { encoding: 'utf8' });
  if (exiftool.status !== 0) {
    return result;
  }

  for (let index = 0; index < paths.length; index += 200) {
    const batch = paths.slice(index, index + 200);
    const output = spawnSync(
      'exiftool',
      [
        '-json',
        '-DateTimeOriginal',
        '-CreateDate',
        '-MediaCreateDate',
        '-TrackCreateDate',
        '-FileModifyDate',
        ...batch,
      ],
      { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 },
    );
    if (output.status !== 0 || !output.stdout.trim()) {
      continue;
    }

    for (const item of JSON.parse(output.stdout)) {
      if (typeof item.SourceFile === 'string') {
        result.set(resolve(item.SourceFile), item);
      }
    }
  }

  return result;
}

function getCaptureDate(path, meta, mtimeMs) {
  const fields = ['DateTimeOriginal', 'CreateDate', 'MediaCreateDate', 'TrackCreateDate', 'FileModifyDate'];
  for (const field of fields) {
    const value = meta?.[field];
    const parsed = typeof value === 'string' ? parseExifDate(value) : null;
    if (parsed) {
      return { date: parsed, source: field };
    }
  }

  const filenameDate = parseFilenameDate(basename(path));
  if (filenameDate) {
    return { date: filenameDate, source: 'filename' };
  }

  return { date: new Date(mtimeMs), source: 'mtime' };
}

function parseExifDate(value) {
  const match = value.match(/^(\d{4})[:/-](\d{2})[:/-](\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?/);
  if (!match) {
    return null;
  }

  return new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4] ?? 0),
    Number(match[5] ?? 0),
    Number(match[6] ?? 0),
  );
}

function parseFilenameDate(value) {
  const match = value.match(/(19|20)\d{2}[-_]?([01]\d)[-_]?([0-3]\d)(?:[-_ ]?([0-2]\d)([0-5]\d)([0-5]\d))?/);
  if (!match) {
    return null;
  }

  const year = Number(match[0].slice(0, 4));
  return new Date(year, Number(match[2]) - 1, Number(match[3]), Number(match[4] ?? 0), Number(match[5] ?? 0), Number(match[6] ?? 0));
}

function parseDateOnly(value, endOfDay = false) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error(`Invalid date: ${value}. Expected YYYY-MM-DD.`);
  }

  return new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    endOfDay ? 23 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 999 : 0,
  );
}

function toDateOnly(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function toDateFolder(date, format) {
  const iso = toDateOnly(date);
  const apple = `${monthNames[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
  switch (format) {
    case 'iso-date': {
      return iso;
    }
    case 'year-iso-date': {
      return join(String(date.getFullYear()), iso);
    }
    case 'year-apple-date': {
      return join(String(date.getFullYear()), apple);
    }
    case 'apple-date':
    default: {
      return apple;
    }
  }
}

async function getDestinationState(path) {
  try {
    const destination = await stat(path);
    return {
      exists: true,
      fileSizeBytes: destination.size,
      modifiedAt: new Date(destination.mtimeMs).toISOString(),
    };
  } catch {
    return {
      exists: false,
      fileSizeBytes: null,
      modifiedAt: null,
    };
  }
}

function toSkippedOperation(file, mode, reason, captureDate, captureDateSource, destinationPath, shouldHash) {
  return {
    id: randomUUID(),
    status: 'skipped',
    reason,
    action: mode,
    sourcePath: file.path,
    destinationPath,
    originalFileName: file.name,
    fileExtension: extname(file.name).toLowerCase(),
    fileSizeBytes: file.size,
    sourceModifiedAt: new Date(file.mtimeMs).toISOString(),
    captureDate: captureDate ? toDateOnly(captureDate) : null,
    captureDateTime: captureDate ? captureDate.toISOString() : null,
    captureDateSource,
    destinationState: null,
    sha1: shouldHash ? null : null,
  };
}

function summarizeOperations(operations) {
  return {
    total: operations.length,
    planned: operations.filter((operation) => operation.status === 'planned').length,
    conflicts: operations.filter((operation) => operation.status === 'conflict').length,
    skipped: operations.filter((operation) => operation.status === 'skipped').length,
    byReason: countBy(operations.map((operation) => operation.reason).filter(Boolean)),
    byDate: countBy(operations.filter((operation) => operation.captureDate).map((operation) => operation.captureDate)),
  };
}

function countBy(values) {
  return values.reduce((accumulator, value) => {
    accumulator[value] = (accumulator[value] ?? 0) + 1;
    return accumulator;
  }, {});
}

async function assertSourceStillMatches(operation) {
  const source = await stat(operation.sourcePath);
  if (source.size !== operation.fileSizeBytes) {
    throw new Error(`Source size changed for ${operation.sourcePath}`);
  }
}

async function assertDestinationAbsent(path) {
  try {
    await access(path);
    throw new Error(`Destination already exists: ${path}`);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return;
    }
    throw error;
  }
}

async function assertDestinationPresent(path) {
  await access(path);
}

async function assertCopiedDestinationMatches(operation) {
  const destination = await stat(operation.destinationPath);
  if (destination.size !== operation.fileSizeBytes) {
    throw new Error(`Copied destination size changed: ${operation.destinationPath}`);
  }
}

async function moveFile(sourcePath, destinationPath) {
  try {
    await rename(sourcePath, destinationPath);
  } catch (error) {
    if (error?.code !== 'EXDEV') {
      throw error;
    }

    await copyFile(sourcePath, destinationPath);
    await unlink(sourcePath);
  }
}

async function sha1File(path) {
  const hash = createHash('sha1');
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', rejectPromise);
    stream.on('end', resolvePromise);
  });
  return hash.digest('hex');
}

async function writeJournal(path, journal) {
  await writeFile(path, `${JSON.stringify(journal, null, 2)}\n`);
}

function assertPlan(value) {
  if (!value || value.schema !== 'photo-file-organizer-plan-v1' || !Array.isArray(value.operations)) {
    throw new Error('Invalid photo-file-organizer plan file');
  }
}

function assertJournal(value) {
  if (!value || value.schema !== 'photo-file-organizer-journal-v1' || !Array.isArray(value.operations)) {
    throw new Error('Invalid photo-file-organizer journal file');
  }
}

function toArray(value) {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function normalizeExtension(value) {
  if (!value) {
    return null;
  }
  return value.startsWith('.') ? value.toLowerCase() : `.${value.toLowerCase()}`;
}

function toSafeName(value) {
  return value.replaceAll(':', '-').replaceAll('.', '-');
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}
