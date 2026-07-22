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
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';

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
    case 'reconcile-plan': {
      await reconcilePlan();
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
    case 'status': {
      await statusCommand();
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
  node tools/photo-file-organizer.mjs reconcile-plan --source PATH --originals PATH --duplicates PATH [--plan-file PATH] [--event-name NAME] [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--perceptual] [--phash-distance N] [--ffmpeg PATH]
  node tools/photo-file-organizer.mjs apply --plan-file PATH [--journal-dir PATH]
  node tools/photo-file-organizer.mjs undo --journal-file PATH
  node tools/photo-file-organizer.mjs status --progress-file PATH

Plan is read-only. Apply writes a journal before moving/copying. Undo uses that journal.

For a long (1-2M-file) reconcile-plan, pass --progress-file PATH: the scan rewrites a tiny status blob
(phase, scanned/total, heartbeat, pid) as it runs. Launch it detached and poll cheaply with the status
command, e.g.:
  nohup node tools/photo-file-organizer.mjs reconcile-plan --perceptual \
    --source S --originals O --duplicates Q --plan-file /path/plan.json \
    --progress-file /path/progress.json >/path/run.log 2>&1 &
  node tools/photo-file-organizer.mjs status --progress-file /path/progress.json
status reports "stalled" if the job's pid is gone and the heartbeat is stale (died without completing).

reconcile-plan routes byte-identical copies (content SHA1) to the duplicates quarantine and new files to
date-prefixed event folders. Add --perceptual to also group visually-identical copies that differ in bytes
(e.g. the same photo at different resolutions): within each visual group the LARGEST file is kept and the
smaller copies are quarantined. --phash-distance N (default 5) is the max Hamming distance between 64-bit
dHashes treated as the same image; --ffmpeg names the decoder binary (default "ffmpeg"). Perceptual grouping
never modifies the --originals tree: a source that visually matches an existing original is quarantined even
when it is larger (surfaced with largerThanOriginalMatch=true for manual review).`);
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
    files.push(...(await walkFiles(source, extensions, maxDepth, source)));
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

async function reconcilePlan() {
  if (args.perceptual === true || args.perceptual === 'true') {
    return reconcilePlanPerceptual();
  }

  const sources = toArray(args.source).map((value) => resolve(String(value)));
  const originalsRoot = args.originals ? resolve(String(args.originals)) : null;
  const duplicatesRoot = args.duplicates ? resolve(String(args.duplicates)) : null;
  if (sources.length === 0 || !originalsRoot || !duplicatesRoot) {
    throw new Error('reconcile-plan requires --source, --originals, and --duplicates');
  }

  const mode = args.mode === 'copy' ? 'copy' : 'move';
  const eventName = typeof args['event-name'] === 'string' ? args['event-name'].trim() : null;
  const startDate = args.start ? parseDateOnly(String(args.start)) : null;
  const endDate = args.end ? parseDateOnly(String(args.end), true) : null;
  const extensions = args.extensions
    ? new Set(String(args.extensions).split(',').map((item) => normalizeExtension(item.trim())).filter(Boolean))
    : mediaExtensions;
  const maxDepth = args['max-depth'] === undefined ? null : Number(args['max-depth']);
  const generatedAt = new Date().toISOString();
  const planFile =
    typeof args['plan-file'] === 'string'
      ? resolve(args['plan-file'])
      : resolve(`photo-file-reconcile-plan-${toSafeName(generatedAt)}-${randomUUID()}.json`);

  const originals = await walkFiles(originalsRoot, extensions, maxDepth, originalsRoot);
  const originalHashIndex = new Map();
  for (const original of originals) {
    const sha1 = await sha1File(original.path);
    const entries = originalHashIndex.get(sha1) ?? [];
    entries.push({
      path: original.path,
      relativePath: original.relativePath,
      fileSizeBytes: original.size,
      modifiedAt: new Date(original.mtimeMs).toISOString(),
    });
    originalHashIndex.set(sha1, entries);
  }

  const sourceFiles = [];
  for (const source of sources) {
    sourceFiles.push(...(await walkFiles(source, extensions, maxDepth, source)));
  }

  const metadata = await readExifMetadata(sourceFiles.map((file) => file.path));
  const operations = [];
  const plannedDestinationPaths = new Set();
  const firstSourceOperationByHash = new Map();
  for (const file of sourceFiles) {
    const meta = metadata.get(file.path);
    const capture = getCaptureDate(file.path, meta, file.mtimeMs);
    const sha1 = await sha1File(file.path);
    const originalMatches = originalHashIndex.get(sha1) ?? [];
    const firstSourceMatch = firstSourceOperationByHash.get(sha1);
    const duplicateEvidence =
      originalMatches.length > 0
        ? { type: 'content_sha1_matches_originals', sha1, matches: originalMatches }
        : firstSourceMatch
          ? {
              type: 'content_sha1_matches_planned_source',
              sha1,
              firstOperationId: firstSourceMatch.id,
              firstSourcePath: firstSourceMatch.sourcePath,
            }
          : null;
    const isDuplicate = Boolean(duplicateEvidence);

    if (!isDuplicate && !capture.date) {
      operations.push(toSkippedOperation(file, mode, 'missing_capture_date', null, null, null, true));
      continue;
    }

    if (!isDuplicate && ((startDate && capture.date < startDate) || (endDate && capture.date > endDate))) {
      operations.push(toSkippedOperation(file, mode, 'outside_date_range', capture.date, capture.source, null, true));
      continue;
    }

    const destinationPath = isDuplicate
      ? resolve(duplicatesRoot, toSafePathSegment(basename(file.sourceRoot)), file.relativePath)
      : resolve(originalsRoot, inferEventFolder(file, capture.date, eventName), file.name);
    const destinationState = await getDestinationState(destinationPath);
    const hasPlanCollision = plannedDestinationPaths.has(destinationPath);
    const status = destinationState.exists || hasPlanCollision ? 'conflict' : 'planned';
    const reason = destinationState.exists ? 'destination_exists' : hasPlanCollision ? 'destination_planned_twice' : null;
    const operation = {
      id: randomUUID(),
      status,
      reason,
      intent: isDuplicate ? 'duplicate_quarantine' : 'add_to_originals',
      action: mode,
      sourcePath: file.path,
      sourceRoot: file.sourceRoot,
      relativePath: file.relativePath,
      destinationPath,
      originalFileName: file.name,
      fileExtension: extname(file.name).toLowerCase(),
      fileSizeBytes: file.size,
      sourceModifiedAt: new Date(file.mtimeMs).toISOString(),
      captureDate: capture.date ? toDateOnly(capture.date) : null,
      captureDateTime: capture.date ? capture.date.toISOString() : null,
      captureDateSource: capture.source,
      destinationState,
      sha1,
      duplicateEvidence,
    };
    operations.push(operation);

    if (status === 'planned') {
      plannedDestinationPaths.add(destinationPath);
      if (!isDuplicate && !firstSourceOperationByHash.has(sha1)) {
        firstSourceOperationByHash.set(sha1, operation);
      }
    }
  }

  const summary = summarizeOperations(operations);
  const payload = {
    schema: 'photo-file-organizer-plan-v1',
    generatedAt,
    id: randomUUID(),
    planKind: 'reconcile-originals-and-backups',
    sourceRoots: sources,
    destinationRoot: originalsRoot,
    originalsRoot,
    duplicatesRoot,
    eventName,
    mode,
    folderFormat: 'event-folder',
    filters: {
      start: args.start ?? null,
      end: args.end ?? null,
      extensions: [...extensions].sort(),
      maxDepth,
      duplicateMatch: 'content_sha1',
    },
    originalIndexSummary: {
      files: originals.length,
      uniqueHashes: originalHashIndex.size,
      duplicateHashesWithinOriginals: [...originalHashIndex.values()].filter((entries) => entries.length > 1).length,
    },
    summary,
    operations,
  };

  await mkdir(dirname(planFile), { recursive: true });
  await writeFile(planFile, `${JSON.stringify(payload, null, 2)}\n`);
  printJson({
    status: 'planned',
    planFile,
    originalIndexSummary: payload.originalIndexSummary,
    summary,
  });
}

async function reconcilePlanPerceptual() {
  const sources = toArray(args.source).map((value) => resolve(String(value)));
  const originalsRoot = args.originals ? resolve(String(args.originals)) : null;
  const duplicatesRoot = args.duplicates ? resolve(String(args.duplicates)) : null;
  if (sources.length === 0 || !originalsRoot || !duplicatesRoot) {
    throw new Error('reconcile-plan requires --source, --originals, and --duplicates');
  }

  const mode = args.mode === 'copy' ? 'copy' : 'move';
  const eventName = typeof args['event-name'] === 'string' ? args['event-name'].trim() : null;
  const startDate = args.start ? parseDateOnly(String(args.start)) : null;
  const endDate = args.end ? parseDateOnly(String(args.end), true) : null;
  const extensions = args.extensions
    ? new Set(String(args.extensions).split(',').map((item) => normalizeExtension(item.trim())).filter(Boolean))
    : mediaExtensions;
  const maxDepth = args['max-depth'] === undefined ? null : Number(args['max-depth']);
  const ffmpegBin = typeof args.ffmpeg === 'string' ? args.ffmpeg : 'ffmpeg';
  const phashDistance = args['phash-distance'] === undefined ? 5 : Number(args['phash-distance']);
  if (!Number.isInteger(phashDistance) || phashDistance < 0 || phashDistance > 64) {
    throw new Error('--phash-distance must be an integer between 0 and 64');
  }
  if (!ensureFfmpeg(ffmpegBin)) {
    throw new Error(
      `Perceptual grouping requires a working ffmpeg decoder. "${ffmpegBin}" was not runnable. Install ffmpeg or pass --ffmpeg PATH.`,
    );
  }

  const generatedAt = new Date().toISOString();
  const planFile =
    typeof args['plan-file'] === 'string'
      ? resolve(args['plan-file'])
      : resolve(`photo-file-reconcile-perceptual-plan-${toSafeName(generatedAt)}-${randomUUID()}.json`);

  // A lightweight, frequently-rewritten status file so the agent (or a supervisor) can cheaply poll a
  // hours-long 1-2M-file scan for progress/heartbeat/resume without ever re-reading the large plan.
  const progressFile = typeof args['progress-file'] === 'string' ? resolve(args['progress-file']) : null;
  const runId = randomUUID();
  const progress = {
    schema: 'photo-file-organizer-progress-v1',
    runId,
    command: 'reconcile-plan',
    perceptual: true,
    pid: process.pid,
    planFile,
    sourceRoots: sources,
    originalsRoot,
    duplicatesRoot,
    status: 'running',
    phase: 'starting',
    startedAt: generatedAt,
    updatedAt: generatedAt,
    totals: { originalsFiles: null, sourceFiles: null, metadataToRead: null },
    counters: { originalsHashed: 0, metadataRead: 0, sourceScanned: 0, sourcePerceptualHashed: 0, exactDuplicates: 0 },
    result: null,
    error: null,
  };
  await emitProgress(progressFile, progress);
  const flushEvery = 250;

  try {
  // Index the known-good originals tree: SHA1 (byte identity) + perceptual dHash (visual identity).
  progress.phase = 'indexing_originals';
  const originals = await walkFiles(originalsRoot, extensions, maxDepth, originalsRoot);
  progress.totals.originalsFiles = originals.length;
  await emitProgress(progressFile, progress);
  const originalHashIndex = new Map();
  const originalsTree = createBKTree();
  let originalPerceptualHashed = 0;
  for (const original of originals) {
    const sha1 = await sha1File(original.path);
    const entries = originalHashIndex.get(sha1) ?? [];
    entries.push({
      path: original.path,
      relativePath: original.relativePath,
      fileSizeBytes: original.size,
      modifiedAt: new Date(original.mtimeMs).toISOString(),
    });
    originalHashIndex.set(sha1, entries);

    const phash = perceptualHashFile(original.path, ffmpegBin);
    if (phash) {
      originalsTree.add(phash, { path: original.path, relativePath: original.relativePath, fileSizeBytes: original.size });
      originalPerceptualHashed++;
    }
    progress.counters.originalsHashed++;
    if (progress.counters.originalsHashed % flushEvery === 0) {
      await emitProgress(progressFile, progress);
    }
  }

  progress.phase = 'walking_sources';
  await emitProgress(progressFile, progress);
  const sourceFiles = [];
  for (const source of sources) {
    sourceFiles.push(...(await walkFiles(source, extensions, maxDepth, source)));
  }
  progress.totals.sourceFiles = sourceFiles.length;
  progress.phase = 'reading_metadata';
  await emitProgress(progressFile, progress);

  const metadata = await readExifMetadata(sourceFiles.map((file) => file.path), async (read, total) => {
    progress.counters.metadataRead = read;
    progress.totals.metadataToRead = total;
    await emitProgress(progressFile, progress);
  });

  progress.phase = 'scanning_sources';
  await emitProgress(progressFile, progress);

  // PASS 1: classify byte-identity, capture date / range eligibility, and compute perceptual hashes
  // only for the survivors that could actually become keepers.
  const records = [];
  const firstSourceKeeperByHash = new Map();
  for (const file of sourceFiles) {
    const meta = metadata.get(file.path);
    const capture = getCaptureDate(file.path, meta, file.mtimeMs);
    const sha1 = await sha1File(file.path);
    const record = {
      id: randomUUID(),
      file,
      capture,
      sha1,
      phash: null,
      phashStatus: 'not_computed',
      decision: null,
      reason: null,
      duplicateEvidence: null,
      keeperRecord: null,
      perceptualDistance: null,
      originalMatch: null,
      largerThanOriginalMatch: false,
    };
    records.push(record);
    progress.counters.sourceScanned++;
    if (progress.counters.sourceScanned % flushEvery === 0) {
      await emitProgress(progressFile, progress);
    }

    const originalMatches = originalHashIndex.get(sha1) ?? [];
    if (originalMatches.length > 0) {
      record.decision = 'exact_duplicate';
      record.reason = null;
      record.duplicateEvidence = { type: 'content_sha1_matches_originals', sha1, matches: originalMatches };
      progress.counters.exactDuplicates++;
      continue;
    }

    const firstSourceKeeper = firstSourceKeeperByHash.get(sha1);
    if (firstSourceKeeper) {
      record.decision = 'exact_duplicate';
      record.duplicateEvidence = {
        type: 'content_sha1_matches_planned_source',
        sha1,
        firstOperationId: firstSourceKeeper.id,
        firstSourcePath: firstSourceKeeper.file.path,
      };
      progress.counters.exactDuplicates++;
      continue;
    }

    // First time we see this byte-content among non-original sources: it is the byte-keeper candidate.
    firstSourceKeeperByHash.set(sha1, record);

    if (!capture.date) {
      record.decision = 'skipped';
      record.reason = 'missing_capture_date';
      continue;
    }
    if ((startDate && capture.date < startDate) || (endDate && capture.date > endDate)) {
      record.decision = 'skipped';
      record.reason = 'outside_date_range';
      continue;
    }

    // Eligible to reach the originals tree — compute its perceptual hash for visual grouping.
    const phash = perceptualHashFile(file.path, ffmpegBin);
    record.phash = phash;
    record.phashStatus = phash ? 'ok' : 'unavailable';
    record.decision = 'candidate';
    if (phash) {
      progress.counters.sourcePerceptualHashed++;
    }
  }

  progress.phase = 'clustering';
  await emitProgress(progressFile, progress);

  // PASS 2a: quarantine source files that visually match an existing curated original.
  const candidates = records.filter((record) => record.decision === 'candidate');
  for (const record of candidates) {
    if (!record.phash) {
      continue;
    }
    const originalHits = originalsTree
      .query(record.phash, phashDistance)
      .sort((a, b) => a.distance - b.distance || a.payload.path.localeCompare(b.payload.path));
    if (originalHits.length > 0) {
      const closest = originalHits[0];
      record.decision = 'near_original';
      record.perceptualDistance = closest.distance;
      record.originalMatch = closest.payload;
      record.largerThanOriginalMatch = record.file.size > (closest.payload.fileSizeBytes ?? 0);
    }
  }

  // PASS 2b: greedy largest-wins clustering of the remaining candidates. Processing in size-descending
  // order guarantees the biggest file in each visual neighborhood becomes the keeper.
  const clusterPool = candidates.filter((record) => record.decision === 'candidate' && record.phash);
  const keeperTree = createBKTree();
  const ordered = [...clusterPool].sort(
    (a, b) => b.file.size - a.file.size || a.file.path.localeCompare(b.file.path),
  );
  for (const record of ordered) {
    const hits = keeperTree
      .query(record.phash, phashDistance)
      .sort((a, b) => a.distance - b.distance || a.payload.file.path.localeCompare(b.payload.file.path));
    if (hits.length > 0) {
      const keeper = hits[0].payload;
      record.decision = 'perceptual_duplicate';
      record.keeperRecord = keeper;
      record.perceptualDistance = hits[0].distance;
    } else {
      record.decision = 'keeper';
      keeperTree.add(record.phash, record);
    }
  }
  // Candidates whose perceptual hash could not be computed keep as unique (never silently dropped).
  for (const record of candidates) {
    if (record.decision === 'candidate') {
      record.decision = 'keeper';
    }
  }

  progress.phase = 'assigning_destinations';
  await emitProgress(progressFile, progress);

  // PASS 3: materialize operations in stable source order, assigning destinations and collisions.
  const operations = [];
  const plannedDestinationPaths = new Set();
  for (const record of records) {
    const { file, capture } = record;
    const base = {
      id: record.id,
      action: mode,
      sourcePath: file.path,
      sourceRoot: file.sourceRoot,
      relativePath: file.relativePath,
      originalFileName: file.name,
      fileExtension: extname(file.name).toLowerCase(),
      fileSizeBytes: file.size,
      sourceModifiedAt: new Date(file.mtimeMs).toISOString(),
      captureDate: capture.date ? toDateOnly(capture.date) : null,
      captureDateTime: capture.date ? capture.date.toISOString() : null,
      captureDateSource: capture.source,
      sha1: record.sha1,
      perceptualHash: record.phash ? record.phash.hex : null,
      perceptualHashStatus: record.phashStatus,
    };

    if (record.decision === 'skipped') {
      operations.push({ ...base, status: 'skipped', reason: record.reason, intent: null, destinationPath: null, destinationState: null });
      continue;
    }

    const isKeeper = record.decision === 'keeper';
    const destinationPath = isKeeper
      ? resolve(originalsRoot, inferEventFolder(file, capture.date, eventName), file.name)
      : resolve(duplicatesRoot, toSafePathSegment(basename(file.sourceRoot)), file.relativePath);
    const destinationState = await getDestinationState(destinationPath);
    const hasPlanCollision = plannedDestinationPaths.has(destinationPath);
    const status = destinationState.exists || hasPlanCollision ? 'conflict' : 'planned';
    const collisionReason = destinationState.exists
      ? 'destination_exists'
      : hasPlanCollision
        ? 'destination_planned_twice'
        : null;

    const duplicateEvidence =
      record.decision === 'exact_duplicate'
        ? record.duplicateEvidence
        : record.decision === 'near_original'
          ? {
              type: 'perceptual_near_duplicate_of_original',
              perceptualDistance: record.perceptualDistance,
              largerThanOriginalMatch: record.largerThanOriginalMatch,
              match: record.originalMatch,
            }
          : record.decision === 'perceptual_duplicate'
            ? {
                type: 'perceptual_near_duplicate_smaller_copy',
                perceptualDistance: record.perceptualDistance,
                keeperOperationId: record.keeperRecord.id,
                keeperPath: record.keeperRecord.file.path,
                keeperFileSizeBytes: record.keeperRecord.file.size,
              }
            : null;

    const intentReason =
      record.decision === 'exact_duplicate'
        ? 'content_sha1_duplicate'
        : record.decision === 'near_original'
          ? 'perceptual_near_duplicate_of_original'
          : record.decision === 'perceptual_duplicate'
            ? 'perceptual_near_duplicate_smaller_copy'
            : null;

    operations.push({
      ...base,
      status,
      reason: collisionReason ?? intentReason,
      intent: isKeeper ? 'add_to_originals' : 'duplicate_quarantine',
      destinationPath,
      destinationState,
      duplicateEvidence,
    });

    if (status === 'planned') {
      plannedDestinationPaths.add(destinationPath);
    }
  }

  const summary = summarizeOperations(operations);
  const payload = {
    schema: 'photo-file-organizer-plan-v1',
    generatedAt,
    id: randomUUID(),
    planKind: 'reconcile-originals-and-backups-perceptual',
    sourceRoots: sources,
    destinationRoot: originalsRoot,
    originalsRoot,
    duplicatesRoot,
    eventName,
    mode,
    folderFormat: 'event-folder',
    filters: {
      start: args.start ?? null,
      end: args.end ?? null,
      extensions: [...extensions].sort(),
      maxDepth,
      duplicateMatch: 'content_sha1+perceptual_dhash',
      perceptual: true,
      phashDistance,
      ffmpeg: ffmpegBin,
    },
    originalIndexSummary: {
      files: originals.length,
      uniqueHashes: originalHashIndex.size,
      duplicateHashesWithinOriginals: [...originalHashIndex.values()].filter((entries) => entries.length > 1).length,
      perceptualHashed: originalPerceptualHashed,
    },
    perceptualSummary: {
      keepers: operations.filter((operation) => operation.intent === 'add_to_originals').length,
      exactDuplicates: operations.filter((operation) => operation.reason === 'content_sha1_duplicate').length,
      nearDuplicateOfOriginal: operations.filter((operation) => operation.reason === 'perceptual_near_duplicate_of_original').length,
      nearDuplicateSmallerCopy: operations.filter((operation) => operation.reason === 'perceptual_near_duplicate_smaller_copy').length,
      largerThanOriginalForReview: operations.filter((operation) => operation.duplicateEvidence?.largerThanOriginalMatch === true).length,
      perceptualHashUnavailable: operations.filter((operation) => operation.perceptualHashStatus === 'unavailable').length,
    },
    summary,
    operations,
  };

  await mkdir(dirname(planFile), { recursive: true });
  await writeFile(planFile, `${JSON.stringify(payload, null, 2)}\n`);

  progress.status = 'completed';
  progress.phase = 'completed';
  progress.result = { summary, perceptualSummary: payload.perceptualSummary, originalIndexSummary: payload.originalIndexSummary };
  await emitProgress(progressFile, progress);

  printJson({
    status: 'planned',
    planFile,
    progressFile,
    originalIndexSummary: payload.originalIndexSummary,
    perceptualSummary: payload.perceptualSummary,
    summary,
  });
  } catch (error) {
    progress.status = 'error';
    progress.phase = 'error';
    progress.error = error instanceof Error ? error.message : String(error);
    await emitProgress(progressFile, progress);
    throw error;
  }
}

// Best-effort atomic status write: never let a progress-file error abort the real work.
async function emitProgress(progressFile, progress) {
  if (!progressFile) {
    return;
  }
  progress.updatedAt = new Date().toISOString();
  try {
    await mkdir(dirname(progressFile), { recursive: true });
    const temporary = `${progressFile}.tmp`;
    await writeFile(temporary, `${JSON.stringify(progress, null, 2)}\n`);
    await rename(temporary, progressFile);
  } catch {
    // A transient status-write failure must not stop the scan; the next flush will retry.
  }
}

async function statusCommand() {
  const progressFile = args['progress-file'] ? resolve(String(args['progress-file'])) : null;
  if (!progressFile) {
    throw new Error('status requires --progress-file');
  }

  let raw;
  try {
    raw = await readFile(progressFile, 'utf8');
  } catch {
    printJson({ status: 'unknown', progressFile, reason: 'progress_file_not_found' });
    return;
  }

  const progress = JSON.parse(raw);
  const ageSeconds = Math.round((Date.now() - new Date(progress.updatedAt).getTime()) / 1000);
  const scanned = progress.counters?.sourceScanned ?? 0;
  const total = progress.totals?.sourceFiles ?? null;
  const running = isPidAlive(progress.pid);
  // A "running" status whose heartbeat is stale and whose pid is gone means the job died without finishing.
  const stalled = progress.status === 'running' && !running && ageSeconds > 60;
  printJson({
    status: stalled ? 'stalled' : progress.status,
    phase: progress.phase,
    runId: progress.runId,
    pid: progress.pid,
    pidAlive: running,
    heartbeatAgeSeconds: ageSeconds,
    progress: {
      sourceScanned: scanned,
      sourceFiles: total,
      percent: total ? Math.min(100, Math.round((scanned / total) * 100)) : null,
      sourcePerceptualHashed: progress.counters?.sourcePerceptualHashed ?? 0,
      exactDuplicates: progress.counters?.exactDuplicates ?? 0,
      metadataRead: progress.counters?.metadataRead ?? 0,
      originalsHashed: progress.counters?.originalsHashed ?? 0,
      originalsFiles: progress.totals?.originalsFiles ?? null,
    },
    planFile: progress.planFile,
    result: progress.result,
    error: progress.error,
  });
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function ensureFfmpeg(ffmpegBin) {
  const probe = spawnSync(ffmpegBin, ['-version'], { encoding: 'utf8' });
  return probe.status === 0;
}

// dHash: decode to a 9x8 grayscale frame and emit a 64-bit hash from left>right pixel gradients.
// Same image at different resolutions normalizes to the same 9x8 grid, so its hash is identical or near.
function perceptualHashFile(path, ffmpegBin) {
  const output = spawnSync(
    ffmpegBin,
    ['-v', 'error', '-i', path, '-frames:v', '1', '-vf', 'scale=9:8,format=gray', '-f', 'rawvideo', '-'],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  if (output.status !== 0 || !output.stdout || output.stdout.length < 72) {
    return null;
  }

  const pixels = output.stdout;
  let hi = 0;
  let lo = 0;
  let bitIndex = 0;
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const left = pixels[row * 9 + col];
      const right = pixels[row * 9 + col + 1];
      const bit = left < right ? 1 : 0;
      if (bit) {
        if (bitIndex < 32) {
          hi |= 1 << bitIndex;
        } else {
          lo |= 1 << (bitIndex - 32);
        }
      }
      bitIndex++;
    }
  }

  hi >>>= 0;
  lo >>>= 0;
  const hex = `${hi.toString(16).padStart(8, '0')}${lo.toString(16).padStart(8, '0')}`;
  return { hi, lo, hex };
}

function popcount32(value) {
  let v = value - ((value >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function hammingHash(a, b) {
  return popcount32((a.hi ^ b.hi) >>> 0) + popcount32((a.lo ^ b.lo) >>> 0);
}

// Burkhard-Keller tree over Hamming distance: sub-linear radius queries so clustering scales past 1M files.
// A hoisted factory (not a class) so it is callable from the command dispatch that runs above this line.
function createBKTree() {
  let root = null;

  function add(hash, payload) {
    const node = { hash, payload, children: new Map() };
    if (!root) {
      root = node;
      return;
    }
    let current = root;
    for (;;) {
      const distance = hammingHash(hash, current.hash);
      const next = current.children.get(distance);
      if (!next) {
        current.children.set(distance, node);
        return;
      }
      current = next;
    }
  }

  function query(hash, radius) {
    const results = [];
    if (!root) {
      return results;
    }
    const stack = [root];
    while (stack.length > 0) {
      const node = stack.pop();
      const distance = hammingHash(hash, node.hash);
      if (distance <= radius) {
        results.push({ distance, payload: node.payload });
      }
      const low = distance - radius;
      const high = distance + radius;
      for (const [childDistance, child] of node.children) {
        if (childDistance >= low && childDistance <= high) {
          stack.push(child);
        }
      }
    }
    return results;
  }

  return { add, query };
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

async function walkFiles(root, extensions, maxDepth, sourceRoot = root) {
  const rootState = await stat(root);
  if (rootState.isFile()) {
    return toFileEntry(root, rootState, root, extensions, dirname(root)) ? [toFileEntry(root, rootState, root, extensions, dirname(root))] : [];
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
      const fileEntry = toFileEntry(path, fileState, entry.name, extensions, sourceRoot);
      if (fileEntry) {
        files.push(fileEntry);
      }
    }
  }

  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function toFileEntry(path, fileState, name, extensions, sourceRoot) {
  const fileName = basename(name);
  const extension = extname(fileName).toLowerCase();
  if (!extensions.has(extension)) {
    return null;
  }

  return {
    path,
    name: fileName,
    sourceRoot,
    relativePath: toPortableRelativePath(sourceRoot, path),
    size: fileState.size,
    mtimeMs: fileState.mtimeMs,
  };
}

async function readExifMetadata(paths, onBatch = null) {
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
    if (output.status === 0 && output.stdout.trim()) {
      for (const item of JSON.parse(output.stdout)) {
        if (typeof item.SourceFile === 'string') {
          result.set(resolve(item.SourceFile), item);
        }
      }
    }

    // Heartbeat: on a million-file library the exiftool read alone runs for a long time; without this
    // the status file would look stalled while the job is actually busy.
    if (onBatch) {
      await onBatch(Math.min(index + batch.length, paths.length), paths.length);
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

  const pathDate = parseFilenameDate(path);
  if (pathDate) {
    return { date: pathDate, source: 'source_path' };
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

function inferEventFolder(file, captureDate, eventName) {
  const explicitEvent = cleanEventName(eventName);
  if (explicitEvent) {
    return `${toDateOnly(captureDate)} ${explicitEvent}`;
  }

  const sourceFolderParts = dirname(file.relativePath)
    .split(/[\\/]/)
    .filter((part) => part && part !== '.');
  for (const part of [...sourceFolderParts].reverse()) {
    const normalized = normalizeExistingEventFolderName(part);
    if (normalized) {
      return normalized;
    }
  }

  const sourceRootName = basename(file.sourceRoot);
  const normalizedRootName = normalizeExistingEventFolderName(sourceRootName);
  if (normalizedRootName) {
    return normalizedRootName;
  }

  const eventCandidate =
    [...sourceFolderParts].reverse().find((part) => !isGenericFolderName(part)) ||
    (!isGenericFolderName(sourceRootName) ? sourceRootName : null);
  const event = cleanEventName(stripDatePrefix(eventCandidate)) || 'Unsorted';
  return `${toDateOnly(captureDate)} ${event}`;
}

function normalizeExistingEventFolderName(value) {
  const clean = String(value).trim();
  const yearRange = clean.match(/^((?:19|20)\d{2})_((?:19|20)\d{2})\s+(.+)$/);
  if (yearRange) {
    return `${yearRange[1]}_${yearRange[2]} ${cleanEventName(yearRange[3])}`;
  }

  const dateEvent = clean.match(/^((?:19|20)\d{2})[-_](\d{2})(?:[-_](\d{2}))?\s+(.+)$/);
  if (dateEvent) {
    return `${dateEvent[1]}-${dateEvent[2]}${dateEvent[3] ? `-${dateEvent[3]}` : ''} ${cleanEventName(dateEvent[4])}`;
  }

  const monthEvent = clean.match(/^([A-Z][a-z]{2})\s+(\d{1,2}),\s+((?:19|20)\d{2})\s+(.+)$/);
  if (monthEvent) {
    const monthIndex = monthNames.indexOf(monthEvent[1]);
    if (monthIndex >= 0) {
      return `${monthEvent[3]}-${String(monthIndex + 1).padStart(2, '0')}-${String(Number(monthEvent[2])).padStart(2, '0')} ${cleanEventName(monthEvent[4])}`;
    }
  }

  return null;
}

function stripDatePrefix(value) {
  if (!value) {
    return null;
  }

  return String(value)
    .replace(/^((?:19|20)\d{2})[-_]\d{2}(?:[-_]\d{2})?\s+/, '')
    .replace(/^((?:19|20)\d{2})_((?:19|20)\d{2})\s+/, '')
    .replace(/^[A-Z][a-z]{2}\s+\d{1,2},\s+(?:19|20)\d{2}\s*/, '')
    .trim();
}

function cleanEventName(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const clean = value.replaceAll(/[\\/:\0]/g, '-').replaceAll(/\s+/g, ' ').trim();
  return clean || null;
}

function isGenericFolderName(value) {
  const clean = String(value).trim().toLowerCase();
  return [
    'backup',
    'camera',
    'dcim',
    'downloads',
    'images',
    'media',
    'originals',
    'photo',
    'photo library',
    'photos',
    'pictures',
    'raw photo and video files',
    'videos',
  ].includes(clean);
}

function toPortableRelativePath(root, path) {
  return relative(root, path).split(sep).join('/');
}

function toSafePathSegment(value) {
  return cleanEventName(value) ?? 'source';
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
    byIntent: countBy(operations.map((operation) => operation.intent).filter(Boolean)),
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
  if (operation.sha1) {
    const currentSha1 = await sha1File(operation.sourcePath);
    if (currentSha1 !== operation.sha1) {
      throw new Error(`Source SHA1 changed for ${operation.sourcePath}`);
    }
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
  if (operation.sha1) {
    const currentSha1 = await sha1File(operation.destinationPath);
    if (currentSha1 !== operation.sha1) {
      throw new Error(`Copied destination SHA1 changed: ${operation.destinationPath}`);
    }
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
