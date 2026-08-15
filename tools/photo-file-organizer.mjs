#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  access,
  appendFile,
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
  '.3fr',
  '.3g2',
  '.3gp',
  '.3gpp',
  '.ari',
  '.arw',
  '.asf',
  '.avif',
  '.avi',
  '.bay',
  '.bmp',
  '.braw',
  '.cap',
  '.cr2',
  '.cr3',
  '.crw',
  '.dcr',
  '.dcs',
  '.dib',
  '.divx',
  '.dng',
  '.drf',
  '.dv',
  '.eip',
  '.eps',
  '.erf',
  '.f4v',
  '.fff',
  '.flv',
  '.gif',
  '.gpr',
  '.heic',
  '.heif',
  '.hif',
  '.ico',
  '.iiq',
  '.insp',
  '.insv',
  '.j2c',
  '.j2k',
  '.jfif',
  '.jp2',
  '.jpe',
  '.jpeg',
  '.jpg',
  '.jpf',
  '.jpm',
  '.jpx',
  '.jxl',
  '.k25',
  '.kdc',
  '.lrv',
  '.m2t',
  '.m2ts',
  '.m4v',
  '.mef',
  '.mkv',
  '.mos',
  '.mov',
  '.mp4',
  '.mpe',
  '.mpeg',
  '.mpg',
  '.mpo',
  '.mrw',
  '.mts',
  '.mxf',
  '.nef',
  '.nrw',
  '.ogm',
  '.ogv',
  '.orf',
  '.pef',
  '.png',
  '.psb',
  '.psd',
  '.ptx',
  '.pxn',
  '.qt',
  '.raf',
  '.raw',
  '.rm',
  '.rmvb',
  '.rwl',
  '.rw2',
  '.sr2',
  '.srf',
  '.srw',
  '.svg',
  '.tif',
  '.tiff',
  '.ts',
  '.vob',
  '.webp',
  '.webm',
  '.wmv',
  '.x3f',
]);
const excludedDirectoryNames = new Set(['@eadir', '#recycle', '#snapshot', '.stversions', '.stfolder', 'thumbs', 'encoded-video']);
const excludedTopLevelNames = new Set(['downloads', 'docker', 'jellyfinmedia', 'music']);
const protectedReferenceRoots = [
  resolve('/volume1/photo/originals'),
  resolve('/volume1/photosync/originals_clean'),
];
const videoExtensions = new Set(['.3g2', '.3gp', '.3gpp', '.asf', '.avi', '.divx', '.f4v', '.flv', '.m2t', '.m2ts', '.m4v', '.mkv', '.mov', '.mp4', '.mpe', '.mpeg', '.mpg', '.mts', '.mxf', '.ogm', '.ogv', '.qt', '.rm', '.rmvb', '.ts', '.vob', '.webm', '.wmv']);

function mediaKind(file) {
  return videoExtensions.has(extname(file.name).toLowerCase()) ? 'video' : 'image';
}

function isExcludedEntry(name) {
  const folded = String(name).toLowerCase();
  return folded.startsWith('._') || excludedDirectoryNames.has(folded);
}

function isExcludedTopLevelEntry(name, currentPath, sourceRoot) {
  return currentPath === sourceRoot && excludedTopLevelNames.has(String(name).toLowerCase());
}
const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// ffmpeg does not cleanly fail on these — it "succeeds" but decodes the raw sensor data to a black/garbage
// frame (an all-zero hash). So for RAW we hash the embedded JPEG preview instead of trusting a direct decode.
const rawExtensions = new Set([
  '.3fr',
  '.ari',
  '.arw',
  '.bay',
  '.cap',
  '.cr2',
  '.cr3',
  '.crw',
  '.dcr',
  '.dcs',
  '.dng',
  '.drf',
  '.eip',
  '.erf',
  '.fff',
  '.gpr',
  '.iiq',
  '.k25',
  '.kdc',
  '.mef',
  '.mos',
  '.mrw',
  '.nef',
  '.nrw',
  '.orf',
  '.pef',
  '.ptx',
  '.pxn',
  '.raf',
  '.raw',
  '.rwl',
  '.rw2',
  '.sr2',
  '.srf',
  '.srw',
  '.x3f',
]);

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
  node tools/photo-file-organizer.mjs reconcile-plan --source PATH --originals PATH --dest PATH --duplicates PATH [--plan-file PATH] [--progress-file PATH] [--resume-file PATH] [--seed-resume-file PATH] [--seed-originals-root PATH] [--resume-run] [--event-name NAME] [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--perceptual] [--phash-distance N] [--ffmpeg PATH] [--ffprobe PATH] [--image-decoder PATH]
  node tools/photo-file-organizer.mjs apply --plan-file PATH [--journal-dir PATH]
  node tools/photo-file-organizer.mjs undo --journal-file PATH
  node tools/photo-file-organizer.mjs status --progress-file PATH

Plan is read-only. Apply writes a journal before moving/copying. Undo uses that journal.

For a long (1-2M-file) reconcile-plan, pass --progress-file PATH: the scan rewrites a tiny status blob
(phase, scanned/total, heartbeat, pid) as it runs. Launch it detached and poll cheaply with the status
command, e.g.:
  nohup node tools/photo-file-organizer.mjs reconcile-plan --perceptual \
    --source S --originals O --dest D --duplicates Q --plan-file /unique/run/plan.json \
    --progress-file /unique/run/progress.json --resume-file /unique/run/resume.jsonl >>/unique/run/attempt-1.log 2>&1 &
  node tools/photo-file-organizer.mjs status --progress-file /unique/run/progress.json
status reports "stalled" if the job's pid is gone and the heartbeat is stale (died without completing).
--resume-file PATH makes the scan resumable: re-running the SAME command with --resume-run reuses
sha1/perceptual hashes for files whose size+mtime are unchanged. A completed progress or plan artifact
is immutable and cannot be overwritten. Use a unique run directory and a new append-only attempt log.
--seed-resume-file PATH reads a prior completed run's append-only hash cache without modifying it, allowing
a fresh plan to reuse compatible SHA1, dHash, and video evidence entries. When the protected reference tree
is a known mirror at a different absolute path, pair it with --seed-originals-root PATH; reuse still requires
matching file size and modification time and is limited to the protected reference phase.

reconcile-plan routes byte-identical copies (content SHA1) to the duplicates quarantine and new files to
date-prefixed event folders. Add --perceptual to group visual copies within the same media type. Video matches
also require matching dimensions, aspect ratio, and duration; missing video evidence is retained for review.
Larger-than-original matches, low-confidence dates, and existing destination collisions are review-only and are
never routed to quarantine. --phash-distance N (default 5) is the max Hamming distance between 64-bit dHashes;
--ffmpeg, --ffprobe, and --image-decoder name the decoder/probe binaries. When --originals is one of the protected reference trees,
--dest must be a separate non-protected staging tree.`);
}

async function plan() {
  const sources = toArray(args.source).map((value) => resolve(String(value)));
  const destRoot = args.dest ? resolve(String(args.dest)) : null;
  if (sources.length === 0 || !destRoot) {
    throw new Error('plan requires --source and --dest');
  }
  assertNonProtectedMutationPath(destRoot, '--dest');
  for (const source of sources) {
    assertNonProtectedMutationPath(source, '--source');
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
    files.push(...(await walkFiles(source, extensions, maxDepth, source, { excludeProtectedReferences: true })));
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
      captureDateConfidence: capture.confidence || 'unknown',
      captureDateReviewReason: capture.reason || null,
      mediaKind: mediaKind(file),
      videoEvidence: null,
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

  await writeImmutableJson(planFile, payload, 'plan');
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
  const destinationRoot = args.dest ? resolve(String(args.dest)) : originalsRoot;
  const duplicatesRoot = args.duplicates ? resolve(String(args.duplicates)) : null;
  if (sources.length === 0 || !originalsRoot || !duplicatesRoot) {
    throw new Error('reconcile-plan requires --source, --originals, and --duplicates');
  }
  assertReconcilePathSafety({ sources, originalsRoot, destinationRoot, duplicatesRoot });
  const keeperIntent = destinationRoot === originalsRoot ? 'add_to_originals' : 'stage_new_candidate';

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
      mediaKind: mediaKind(original),
    });
    originalHashIndex.set(sha1, entries);
  }

  const sourceFiles = [];
  for (const source of sources) {
    sourceFiles.push(...(await walkFiles(source, extensions, maxDepth, source, { excludeProtectedReferences: true })));
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
      : resolve(destinationRoot, inferEventFolder(file, capture.date, eventName), file.name);
    const destinationState = await getDestinationState(destinationPath);
    const hasPlanCollision = plannedDestinationPaths.has(destinationPath);
    const status = destinationState.exists || hasPlanCollision ? 'conflict' : 'planned';
    const reason = destinationState.exists ? 'destination_exists' : hasPlanCollision ? 'destination_planned_twice' : null;
    const operation = {
      id: randomUUID(),
      status,
      reason,
      intent: isDuplicate ? 'duplicate_quarantine' : keeperIntent,
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
      captureDateConfidence: capture.confidence || 'unknown',
      captureDateReviewReason: capture.reason || null,
      mediaKind: mediaKind(file),
      videoEvidence: null,
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
    destinationRoot,
    originalsRoot,
    duplicatesRoot,
    protectedReferencePolicy: buildProtectedReferencePolicy(originalsRoot, destinationRoot, duplicatesRoot),
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

  await writeImmutableJson(planFile, payload, 'plan');
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
  const destinationRoot = args.dest ? resolve(String(args.dest)) : originalsRoot;
  const duplicatesRoot = args.duplicates ? resolve(String(args.duplicates)) : null;
  if (sources.length === 0 || !originalsRoot || !duplicatesRoot) {
    throw new Error('reconcile-plan requires --source, --originals, and --duplicates');
  }
  assertReconcilePathSafety({ sources, originalsRoot, destinationRoot, duplicatesRoot });
  const keeperIntent = destinationRoot === originalsRoot ? 'add_to_originals' : 'stage_new_candidate';

  const mode = args.mode === 'copy' ? 'copy' : 'move';
  const eventName = typeof args['event-name'] === 'string' ? args['event-name'].trim() : null;
  const startDate = args.start ? parseDateOnly(String(args.start)) : null;
  const endDate = args.end ? parseDateOnly(String(args.end), true) : null;
  const extensions = args.extensions
    ? new Set(String(args.extensions).split(',').map((item) => normalizeExtension(item.trim())).filter(Boolean))
    : mediaExtensions;
  const maxDepth = args['max-depth'] === undefined ? null : Number(args['max-depth']);
  const ffmpegBin = typeof args.ffmpeg === 'string' ? args.ffmpeg : 'ffmpeg';
  const ffprobeBin = typeof args.ffprobe === 'string' ? args.ffprobe : 'ffprobe';
  const imageDecoderBin = resolveImageDecoder(args['image-decoder']);
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
  const resumeFile = typeof args['resume-file'] === 'string' ? resolve(String(args['resume-file'])) : null;
  const seedResumeFile = typeof args['seed-resume-file'] === 'string' ? resolve(String(args['seed-resume-file'])) : null;
  const seedOriginalsRoot = typeof args['seed-originals-root'] === 'string'
    ? resolve(String(args['seed-originals-root']))
    : null;
  const resumeRun = args['resume-run'] === true || args['resume-run'] === 'true';
  assertPerceptualArtifactArguments({ planFile, progressFile, resumeFile, resumeRun });
  const runId = randomUUID();
  const progress = {
    schema: 'photo-file-organizer-progress-v1',
    runId,
    organizerVersion: '2026-07-24-safety-v2',
    workerContainer: process.env.ORGANIZER_WORKER_CONTAINER || null,
    workerHost: process.env.ORGANIZER_WORKER_HOST || null,
    command: 'reconcile-plan',
    perceptual: true,
    pid: process.pid,
    planFile,
    sourceRoots: sources,
    originalsRoot,
    destinationRoot,
    duplicatesRoot,
    resumeFile,
    resumeSeedFile: seedResumeFile,
    scanConfiguration: {
      mode,
      eventName,
      start: args.start ?? null,
      end: args.end ?? null,
      extensions: [...extensions].sort(),
      maxDepth,
      phashDistance,
      ffmpeg: ffmpegBin,
      ffprobe: ffprobeBin,
      imageDecoder: imageDecoderBin,
      seedOriginalsRoot,
    },
    status: 'running',
    phase: 'starting',
    startedAt: generatedAt,
    updatedAt: generatedAt,
    totals: { originalsFiles: null, sourceFiles: null, metadataToRead: null },
    counters: { originalsHashed: 0, metadataRead: 0, sourceScanned: 0, sourcePerceptualHashed: 0, exactDuplicates: 0, videoEvidenceUnavailable: 0 },
    result: null,
    telemetry: { ratePerSecond: 0, etaSeconds: null, phaseDone: 0, phaseTotal: null },
    error: null,
  };
  await initializePerceptualArtifacts({ planFile, progressFile, resumeFile, resumeRun, progress });
  const flushEvery = 250;
  let lastProgressFlushAt = 0;
  const flushProgress = async (force = false) => {
    const now = Date.now();
    if (!force && now - lastProgressFlushAt < 2000) return;
    lastProgressFlushAt = now;
    const phaseDone = progress.phase === 'indexing_originals' ? progress.counters.originalsHashed : progress.phase === 'reading_metadata' ? progress.counters.metadataRead : progress.counters.sourceScanned;
    const phaseTotal = progress.phase === 'indexing_originals' ? progress.totals.originalsFiles : progress.phase === 'reading_metadata' ? progress.totals.metadataToRead : progress.totals.sourceFiles;
    const elapsedSeconds = Math.max(1, (Date.now() - Date.parse(progress.startedAt)) / 1000);
    progress.telemetry = { phaseDone, phaseTotal, ratePerSecond: phaseDone > 0 ? phaseDone / elapsedSeconds : 0, etaSeconds: phaseTotal && phaseDone > 0 ? Math.ceil((phaseTotal - phaseDone) / (phaseDone / elapsedSeconds)) : null };
    await emitProgress(progressFile, progress);
  };

  // Resumable hash cache (see loadResumeIndex): reuse sha1/phash for files whose size+mtime are unchanged.
  if (seedResumeFile) await access(seedResumeFile);
  const resumeIndex = await loadResumeIndex(resumeFile, seedResumeFile);
  let resumeBuffer = '';
  progress.counters.reusedFromResume = 0;
  const flushResume = async () => {
    if (!resumeFile || resumeBuffer.length === 0) return;
    const data = resumeBuffer;
    resumeBuffer = '';
    await mkdir(dirname(resumeFile), { recursive: true });
    await appendFile(resumeFile, data, { mode: 0o600 });
  };
  const recordResume = (file, fields) => {
    if (!resumeFile) return;
    const existing = resumeIndex.get(file.path);
    if (existing && existing.size === file.size && existing.mtime === file.mtimeMs) Object.assign(existing, fields);
    else resumeIndex.set(file.path, { size: file.size, mtime: file.mtimeMs, ...fields });
    resumeBuffer += JSON.stringify({ p: file.path, s: file.size, m: file.mtimeMs, ...fields }) + '\n';
  };
  const cachedEntry = (file, allowOriginalsAlias = false) => {
    const e = resumeIndex.get(file.path);
    if (e && e.size === file.size && e.mtime === file.mtimeMs) return e;
    if (!allowOriginalsAlias || !seedOriginalsRoot || !seedResumeFile) return null;
    const relativeName = relative(seedOriginalsRoot, file.path);
    if (relativeName.startsWith('..')) return null;
    const seededPath = resolve(seedOriginalsRoot, relativeName);
    const seeded = resumeIndex.get(seededPath);
    // An explicit protected-tree alias may bridge mirrored absolute roots, but
    // still requires matching size and mtime. Never guess across source files.
    return seeded && seeded.size === file.size && seeded.mtime === file.mtimeMs ? seeded : null;
  };
  const cachedSha1 = async (file, allowOriginalsAlias = false) => {
    const e = cachedEntry(file, allowOriginalsAlias);
    if (e && typeof e.sha1 === 'string') {
      progress.counters.reusedFromResume++;
      return e.sha1;
    }
    const sha1 = await sha1File(file.path);
    recordResume(file, { sha1 });
    return sha1;
  };
  const cachedPhash = (file, allowOriginalsAlias = false) => {
    const e = cachedEntry(file, allowOriginalsAlias);
    if (e && e.phash !== undefined) {
      return e.phash === null ? { phash: null, status: 'unavailable' } : { phash: phashFromHex(e.phash), status: 'ok' };
    }
    const phash = perceptualHashFile(file.path, ffmpegBin, imageDecoderBin);
    recordResume(file, { phash: phash ? phash.hex : null });
    return { phash, status: phash ? 'ok' : 'unavailable' };
  };
  const cachedVideoEvidence = (file, allowOriginalsAlias = false) => {
    if (mediaKind(file) !== 'video') return null;
    const e = cachedEntry(file, allowOriginalsAlias);
    if (e && e.videoEvidence !== undefined) return e.videoEvidence;
    const evidence = probeVideoFile(file.path, ffprobeBin);
    if (!evidence) progress.counters.videoEvidenceUnavailable++;
    recordResume(file, { videoEvidence: evidence });
    return evidence;
  };

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
    const sha1 = await cachedSha1(original, true);
    const entries = originalHashIndex.get(sha1) ?? [];
    entries.push({
      path: original.path,
      relativePath: original.relativePath,
      fileSizeBytes: original.size,
      modifiedAt: new Date(original.mtimeMs).toISOString(),
    });
    originalHashIndex.set(sha1, entries);

    const { phash } = cachedPhash(original, true);
    const videoEvidence = cachedVideoEvidence(original, true);
    if (phash) {
      originalsTree.add(phash, { path: original.path, relativePath: original.relativePath, fileSizeBytes: original.size, mediaKind: mediaKind(original), videoEvidence });
      originalPerceptualHashed++;
    }
    progress.counters.originalsHashed++;
    if (Date.now() - lastProgressFlushAt >= 2000) {
      await flushProgress();
    }
    if (progress.counters.originalsHashed % flushEvery === 0) await flushResume();
  }
  await flushResume();

  progress.phase = 'walking_sources';
  await emitProgress(progressFile, progress);
  const sourceFiles = [];
  for (const source of sources) {
    sourceFiles.push(...(await walkFiles(source, extensions, maxDepth, source, { excludeProtectedReferences: true })));
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
    const sha1 = await cachedSha1(file);
    const record = {
      id: randomUUID(),
      file,
      mediaKind: mediaKind(file),
      videoEvidence: null,
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
    if (Date.now() - lastProgressFlushAt >= 2000) {
      await flushProgress();
    }
    if (progress.counters.sourceScanned % flushEvery === 0) await flushResume();

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

    if (!capture.date || capture.confidence === 'review') {
      record.decision = 'date_review';
      record.reason = capture.reason || 'low_confidence_capture_date';
      continue;
    }
    if ((startDate && capture.date < startDate) || (endDate && capture.date > endDate)) {
      record.decision = 'skipped';
      record.reason = 'outside_date_range';
      continue;
    }

    // Eligible to reach the originals tree — compute its perceptual hash for visual grouping.
    const { phash, status } = cachedPhash(file);
    record.phash = phash;
    record.phashStatus = status;
    record.videoEvidence = cachedVideoEvidence(file);
    record.decision = 'candidate';
    if (phash) {
      progress.counters.sourcePerceptualHashed++;
    }
  }
  await flushResume();

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
      .filter((hit) => hit.payload.mediaKind === record.mediaKind && mediaEvidenceCompatible(record, hit.payload))
      .sort((a, b) => a.distance - b.distance || a.payload.path.localeCompare(b.payload.path));
    if (originalHits.length > 0) {
      const closest = originalHits[0];
      record.decision = 'near_original';
      record.perceptualDistance = closest.distance;
      record.originalMatch = closest.payload;
      record.largerThanOriginalMatch = record.file.size > (closest.payload.fileSizeBytes ?? 0);
      if (record.largerThanOriginalMatch) record.decision = 'near_original_review';
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
      .filter((hit) => hit.payload.mediaKind === record.mediaKind && mediaEvidenceCompatible(record, hit.payload))
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

  assignLivePhotoGroups(records);

  progress.phase = 'assigning_destinations';
  await emitProgress(progressFile, progress);

  // PASS 3: materialize operations in stable source order, assigning destinations and collisions.
  const operations = [];
  const plannedDestinationPaths = new Set();
  for (const record of records) {
    const { file, capture } = record;
    const effectiveCaptureDate = record.livePhotoGroup?.captureDate ?? capture.date;
    const companions = record.livePhotoGroup?.companionOwnerId === record.id
      ? await findCompanionFiles(file)
      : record.livePhotoGroup
        ? []
        : await findCompanionFiles(file);
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
      captureDate: effectiveCaptureDate ? toDateOnly(effectiveCaptureDate) : null,
      captureDateTime: effectiveCaptureDate ? effectiveCaptureDate.toISOString() : null,
      captureDateSource: capture.source,
      sha1: record.sha1,
      perceptualHash: record.phash ? record.phash.hex : null,
      perceptualHashStatus: record.phashStatus,
      captureDateConfidence: capture.confidence || 'unknown',
      captureDateReviewReason: capture.reason || null,
      mediaKind: record.mediaKind,
      videoEvidence: record.videoEvidence,
      companionFiles: companions,
      livePhotoGroup: record.livePhotoGroup ?? null,
    };

    const duplicateEvidence =
      record.decision === 'exact_duplicate'
        ? record.duplicateEvidence
        : record.decision === 'near_original' || record.decision === 'near_original_review'
          ? {
              type: 'perceptual_near_duplicate_of_original',
              perceptualDistance: record.perceptualDistance,
              largerThanOriginalMatch: record.largerThanOriginalMatch,
              match: record.originalMatch,
              videoEvidence: record.videoEvidence,
            }
          : record.decision === 'perceptual_duplicate'
            ? {
                type: 'perceptual_near_duplicate_smaller_copy',
                perceptualDistance: record.perceptualDistance,
                keeperOperationId: record.keeperRecord.id,
                keeperPath: record.keeperRecord.file.path,
                keeperFileSizeBytes: record.keeperRecord.file.size,
                videoEvidence: record.videoEvidence,
              }
            : null;

    const lowConfidenceReview = capture.confidence === 'review' || !capture.date;
    const pairReview = Boolean(record.livePhotoGroup?.forceReview);
    if (lowConfidenceReview || pairReview) {
      operations.push({
        ...base,
        status: 'review',
        reason: pairReview ? 'live_photo_pair_review' : (capture.reason || 'low_confidence_capture_date'),
        intent: 'manual_review',
        destinationPath: null,
        destinationState: null,
        duplicateEvidence,
      });
      continue;
    }

    if (record.decision === 'skipped' || record.decision === 'date_review') {
      operations.push({ ...base, status: record.decision === 'date_review' ? 'review' : 'skipped', reason: record.reason, intent: record.decision === 'date_review' ? 'manual_review' : null, destinationPath: null, destinationState: null });
      continue;
    }

    const isKeeper = record.decision === 'keeper';
    // Perceptual similarity is never an automatic quarantine decision. Family
    // bursts and facial-expression variations must remain available for review.
    const isManualReview = ['near_original', 'near_original_review', 'perceptual_duplicate'].includes(record.decision);
    let destinationPath = isManualReview ? null : isKeeper
      ? resolve(destinationRoot, inferEventFolder(file, effectiveCaptureDate, eventName), file.name)
      : resolve(duplicatesRoot, toSafePathSegment(basename(file.sourceRoot)), file.relativePath);
    let destinationState = destinationPath ? await getDestinationState(destinationPath) : null;
    const hasPlanCollision = destinationPath && plannedDestinationPaths.has(destinationPath);
    if (hasPlanCollision) {
      const originalDestinationPath = destinationPath;
      let suffix = 8;
      do {
        destinationPath = `${originalDestinationPath}--${record.sha1.slice(0, suffix)}`;
        destinationState = await getDestinationState(destinationPath);
        suffix += 2;
      } while ((plannedDestinationPaths.has(destinationPath) || destinationState.exists) && suffix <= 40);
    }
    const status = isManualReview || destinationState?.exists ? 'review' : 'planned';
    const collisionReason = record.decision === 'near_original_review'
      ? 'larger_than_original_review'
      : isManualReview
        ? 'perceptual_match_manual_review'
        : destinationState?.exists
        ? 'destination_exists_review'
        : hasPlanCollision
          ? 'destination_collision_resolved'
          : null;

    const intentReason =
      record.decision === 'exact_duplicate'
        ? 'content_sha1_duplicate'
        : record.decision === 'near_original' || record.decision === 'near_original_review'
          ? 'perceptual_near_duplicate_of_original'
          : record.decision === 'perceptual_duplicate'
            ? 'perceptual_near_duplicate_smaller_copy'
            : null;

    operations.push({
      ...base,
      status,
      reason: collisionReason ?? intentReason,
      intent: isManualReview ? 'manual_review' : isKeeper ? keeperIntent : 'duplicate_quarantine',
      destinationPath,
      destinationState,
      duplicateEvidence,
    });

    if (status === 'planned') {
      plannedDestinationPaths.add(destinationPath);
    }
  }

  enforceLivePhotoAtomicity(operations);
  enforceUniqueCompanionOwnership(operations);
  const companionInventory = await inventoryCompanions(sources, operations);

  const summary = summarizeOperations(operations);
  const payload = {
    schema: 'photo-file-organizer-plan-v1',
    generatedAt,
    id: randomUUID(),
    planKind: 'reconcile-originals-and-backups-perceptual',
    sourceRoots: sources,
    destinationRoot,
    originalsRoot,
    duplicatesRoot,
    protectedReferencePolicy: buildProtectedReferencePolicy(originalsRoot, destinationRoot, duplicatesRoot),
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
      imageDecoder: imageDecoderBin,
      resumeFile,
      seedResumeFile,
    },
    originalIndexSummary: {
      files: originals.length,
      uniqueHashes: originalHashIndex.size,
      duplicateHashesWithinOriginals: [...originalHashIndex.values()].filter((entries) => entries.length > 1).length,
      perceptualHashed: originalPerceptualHashed,
    },
    perceptualSummary: {
      keepers: operations.filter((operation) => operation.intent === keeperIntent).length,
      exactDuplicates: operations.filter((operation) => operation.reason === 'content_sha1_duplicate').length,
      nearDuplicateOfOriginal: operations.filter((operation) => operation.reason === 'perceptual_near_duplicate_of_original').length,
      nearDuplicateSmallerCopy: operations.filter((operation) => operation.reason === 'perceptual_near_duplicate_smaller_copy').length,
      largerThanOriginalForReview: operations.filter((operation) => operation.duplicateEvidence?.largerThanOriginalMatch === true).length,
      perceptualHashUnavailable: operations.filter((operation) => operation.perceptualHashStatus === 'unavailable').length,
      videoEvidenceUnavailable: progress.counters.videoEvidenceUnavailable || 0,
    },
    summary,
    companionInventory,
    operations,
  };

  await writeImmutableJson(planFile, payload, 'plan');
  const reviewManifestFile = `${planFile}.review-manifest.json`;
  await writeImmutableJson(reviewManifestFile, {
    schema: 'photo-file-organizer-review-manifest-v1',
    generatedAt,
    planFile,
    planId: payload.id,
    summary: {
      total: summary.review,
      byReason: countBy(operations.filter((operation) => operation.status === 'review').map((operation) => operation.reason).filter(Boolean)),
      byMediaKind: countBy(operations.filter((operation) => operation.status === 'review').map((operation) => operation.mediaKind).filter(Boolean)),
    },
    operations: operations.filter((operation) => operation.status === 'review'),
    companionInventory,
    orphanSidecars: companionInventory.orphanFiles,
  }, 'review manifest');

  progress.status = 'completed';
  progress.phase = 'completed';
  progress.result = { summary, perceptualSummary: payload.perceptualSummary, originalIndexSummary: payload.originalIndexSummary };
  await emitProgress(progressFile, progress);

  printJson({
    status: 'planned',
    planFile,
    reviewManifestFile,
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
    await writeProgressAtomic(progressFile, progress);
  } catch {
    // A transient status-write failure must not stop the scan; the next flush will retry.
  }
}

async function initializePerceptualArtifacts({ planFile, progressFile, resumeFile, resumeRun, progress }) {
  await assertPathAbsent(planFile, 'Completed plan artifact');
  if (!progressFile) {
    return;
  }

  const existing = await readJsonIfExists(progressFile);
  if (!existing) {
    if (resumeRun) {
      throw new Error(`--resume-run requires an existing progress artifact: ${progressFile}`);
    }
    await assertPathAbsent(resumeFile, 'Resume artifact for a new run');
    progress.attempt = 1;
    progress.initialStartedAt = progress.startedAt;
    await writeProgressAtomic(progressFile, progress);
    return;
  }

  if (!resumeRun) {
    throw new Error(
      `Progress artifact already exists: ${progressFile}. Use a unique run directory, or pass --resume-run only for an incomplete run.`,
    );
  }
  if (existing.status === 'completed') {
    throw new Error(`Completed progress artifact is immutable and cannot be resumed: ${progressFile}`);
  }
  if (existing.status === 'running' && isPidAlive(existing.pid)) {
    throw new Error(`The prior organizer attempt is still running with pid ${existing.pid}: ${progressFile}`);
  }

  assertSameRunValue(existing.sourceRoots, progress.sourceRoots, 'source roots');
  assertSameRunValue(existing.originalsRoot, progress.originalsRoot, 'originals root');
  assertSameRunValue(existing.destinationRoot, progress.destinationRoot, 'destination root');
  assertSameRunValue(existing.duplicatesRoot, progress.duplicatesRoot, 'duplicates root');
  assertSameRunValue(existing.resumeFile, progress.resumeFile, 'resume file');
  assertSameRunValue(existing.scanConfiguration, progress.scanConfiguration, 'scan configuration');

  progress.attempt = Number(existing.attempt ?? 1) + 1;
  progress.initialStartedAt = existing.initialStartedAt ?? existing.startedAt;
  progress.resumedFromRunId = existing.runId ?? null;
  await writeProgressAtomic(progressFile, progress);
}

function assertPerceptualArtifactArguments({ planFile, progressFile, resumeFile, resumeRun }) {
  if (Boolean(progressFile) !== Boolean(resumeFile)) {
    throw new Error('Long-run perceptual scans must pass both --progress-file and --resume-file');
  }
  if (resumeRun && (!progressFile || !resumeFile)) {
    throw new Error('--resume-run requires --progress-file and --resume-file');
  }
  if (progressFile) {
    const directories = new Set([dirname(planFile), dirname(progressFile), dirname(resumeFile)]);
    if (directories.size !== 1) {
      throw new Error('--plan-file, --progress-file, and --resume-file must be in the same unique run directory');
    }
  }
  const paths = [planFile, progressFile, resumeFile].filter(Boolean);
  if (new Set(paths).size !== paths.length) {
    throw new Error('Plan, progress, and resume artifacts must use distinct paths');
  }
}

async function writeProgressAtomic(progressFile, progress) {
  await mkdir(dirname(progressFile), { recursive: true });
  const temporary = `${progressFile}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(progress, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await rename(temporary, progressFile);
}

async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function assertSameRunValue(previous, current, label) {
  if (JSON.stringify(previous ?? null) !== JSON.stringify(current ?? null)) {
    throw new Error(`Cannot resume: ${label} differ from the prior attempt`);
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

function resolveImageDecoder(requested) {
  const candidates = requested ? [String(requested)] : ['magick', 'convert'];
  return candidates.find((candidate) => {
    const probe = spawnSync(candidate, ['-version'], { encoding: 'utf8' });
    return probe.status === 0;
  }) ?? null;
}

function ffmpegGrayFrame(ffmpegBin, { path, input }) {
  const args = ['-v', 'error', '-i', path ?? '-', '-frames:v', '1', '-vf', 'scale=9:8,format=gray', '-f', 'rawvideo', '-'];
  const options = { maxBuffer: 8 * 1024 * 1024 };
  if (input) options.input = input;
  const output = spawnSync(ffmpegBin, args, options);
  return output.status === 0 && output.stdout && output.stdout.length >= 72 ? output.stdout : null;
}

function imageDecoderGrayFrame(imageDecoderBin, path) {
  if (!imageDecoderBin) return null;
  const output = spawnSync(imageDecoderBin, [path, '-resize', '9x8!', '-colorspace', 'Gray', '-depth', '8', 'gray:-'], { maxBuffer: 8 * 1024 * 1024 });
  return output.status === 0 && output.stdout && output.stdout.length >= 72 ? output.stdout : null;
}

// RAW files (NEF/CR2/DNG/ARW/…) are not reliably decodable by ffmpeg; extract the largest embedded JPEG
// preview via exiftool instead. Because a RAW and its exported JPEG share the same embedded render, this
// makes them hash alike so largest-wins keeps the RAW. JpgFromRaw (full-size) is preferred over the smaller
// PreviewImage/ThumbnailImage.
function extractEmbeddedPreview(path) {
  for (const tag of ['-JpgFromRaw', '-PreviewImage', '-ThumbnailImage']) {
    const output = spawnSync('exiftool', ['-b', tag, path], { maxBuffer: 64 * 1024 * 1024 });
    if (output.status === 0 && output.stdout && output.stdout.length > 0) {
      return output.stdout;
    }
  }
  return null;
}

function dHashFromGrayFrame(pixels) {
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

function probeVideoFile(path, ffprobeBin) {
  const output = spawnSync(ffprobeBin, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'format=duration,format_name:stream=codec_name,width,height,duration', '-of', 'json', path], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  if (output.status !== 0 || !output.stdout) return null;
  try {
    const payload = JSON.parse(output.stdout);
    const stream = payload.streams?.[0];
    const duration = Number(stream?.duration ?? payload.format?.duration);
    if (!stream || !Number.isFinite(duration) || duration <= 0 || !stream.width || !stream.height) return null;
    return { durationSeconds: Math.round(duration * 1000) / 1000, width: Number(stream.width), height: Number(stream.height), codec: stream.codec_name || null, container: payload.format?.format_name || null };
  } catch {
    return null;
  }
}

function mediaEvidenceCompatible(left, right) {
  if (left.mediaKind !== right.mediaKind) return false;
  if (left.mediaKind !== 'video') return true;
  const a = left.videoEvidence;
  const b = right.videoEvidence;
  if (!a || !b) return false;
  // A matching first frame is insufficient for video. Codec equality is a
  // conservative guard; mismatches remain manual-review candidates.
  if (!a.codec || !b.codec || a.codec !== b.codec) return false;
  const durationTolerance = Math.min(1, Math.max(0.25, Math.max(a.durationSeconds, b.durationSeconds) * 0.01));
  const aspectA = a.width / a.height;
  const aspectB = b.width / b.height;
  return Math.abs(a.durationSeconds - b.durationSeconds) <= durationTolerance && Math.abs(aspectA - aspectB) <= 0.02 && a.width === b.width && a.height === b.height;
}

// dHash: decode to a 9x8 grayscale frame and emit a 64-bit hash from left>right pixel gradients.
// Same image at different resolutions normalizes to the same 9x8 grid, so its hash is identical or near.
function perceptualHashFile(path, ffmpegBin, imageDecoderBin) {
  const isRaw = rawExtensions.has(extname(path).toLowerCase());
  let pixels = null;
  if (isRaw) {
    // RAW: hash the embedded JPEG preview (a RAW and its exported JPEG share this render, so they hash alike
    // and largest-wins keeps the RAW). Direct ffmpeg decode is only a last resort here.
    const preview = extractEmbeddedPreview(path);
    if (preview) pixels = ffmpegGrayFrame(ffmpegBin, { input: preview });
    if (!pixels) pixels = ffmpegGrayFrame(ffmpegBin, { path });
  } else {
    // JPEG/PNG/HEIC/TIFF decode directly; fall back to an embedded preview for anything ffmpeg can't decode.
    pixels = ffmpegGrayFrame(ffmpegBin, { path });
    if (!pixels) {
      const preview = extractEmbeddedPreview(path);
      if (preview) pixels = ffmpegGrayFrame(ffmpegBin, { input: preview });
    }
    if (!pixels) pixels = imageDecoderGrayFrame(imageDecoderBin, path);
  }
  return pixels ? dHashFromGrayFrame(pixels) : null;
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
  assertPlanMutationSafety(planPayload);
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
  const claimedCompanions = new Set();

  for (const operation of journal.operations) {
    if (operation.applyStatus !== 'pending') {
      continue;
    }

    try {
      await assertSourceStillMatches(operation);
      await assertDestinationAbsent(operation.destinationPath);
      const companionDestinations = [];
      for (const companion of operation.companionFiles || []) {
        if (claimedCompanions.has(companion.sourcePath)) continue;
        const current = await stat(companion.sourcePath);
        if (current.size !== companion.fileSizeBytes) {
          throw new Error(`Companion size changed for ${companion.sourcePath}`);
        }
        const companionDestination = resolve(dirname(operation.destinationPath), companion.fileName);
        await assertDestinationAbsent(companionDestination);
        companionDestinations.push({ companion, companionDestination });
      }
      await mkdir(dirname(operation.destinationPath), { recursive: true });
      if (operation.action === 'copy') {
        await copyFile(operation.sourcePath, operation.destinationPath);
      } else {
        await moveFile(operation.sourcePath, operation.destinationPath);
      }
      operation.companionResults = [];
      for (const { companion, companionDestination } of companionDestinations) {
        if (claimedCompanions.has(companion.sourcePath)) {
          operation.companionResults.push({ ...companion, status: 'shared_with_prior_operation' });
          continue;
        }
        claimedCompanions.add(companion.sourcePath);
        if (operation.action === 'copy') await copyFile(companion.sourcePath, companionDestination);
        else await moveFile(companion.sourcePath, companionDestination);
        const companionState = await stat(companionDestination);
        if (companionState.size !== companion.fileSizeBytes) {
          throw new Error(`Companion destination size mismatch: ${companionDestination}`);
        }
        operation.companionResults.push({ ...companion, destinationPath: companionDestination, status: operation.action === 'copy' ? 'copied' : 'moved' });
      }
      operation.applyStatus = operation.action === 'copy' ? 'copied' : 'moved';
      operation.appliedAt = new Date().toISOString();
    } catch (error) {
      // A companion failure must not leave a partially applied primary file.
      // Best-effort rollback is journaled as part of the failed operation.
      try {
        for (const companion of [...(operation.companionResults || [])].reverse()) {
          if (companion.status !== 'copied' && companion.status !== 'moved') continue;
          if (operation.action === 'copy') {
            await unlink(companion.destinationPath);
          } else {
            await assertDestinationAbsent(companion.sourcePath);
            await moveFile(companion.destinationPath, companion.sourcePath);
          }
          companion.rollbackStatus = 'rolled_back';
        }
        if (await pathExists(operation.destinationPath)) {
          if (operation.action === 'copy') await unlink(operation.destinationPath);
          else {
            await assertDestinationAbsent(operation.sourcePath);
            await moveFile(operation.destinationPath, operation.sourcePath);
          }
        }
        operation.rollbackStatus = 'rolled_back';
      } catch (rollbackError) {
        operation.rollbackStatus = 'rollback_error';
        operation.rollbackError = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      }
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
  assertJournalMutationSafety(journal);
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
      for (const companion of [...(operation.companionResults || [])].reverse()) {
        if (companion.status !== 'copied' && companion.status !== 'moved') continue;
        if (operation.action === 'copy') {
          await unlink(companion.destinationPath);
          companion.undoStatus = 'deleted_copy';
        } else {
          await assertDestinationPresent(companion.destinationPath);
          await assertDestinationAbsent(companion.sourcePath);
          await moveFile(companion.destinationPath, companion.sourcePath);
          companion.undoStatus = 'moved_back';
        }
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

async function walkFiles(root, extensions, maxDepth, sourceRoot = root, { excludeProtectedReferences = false } = {}) {
  if (excludeProtectedReferences && matchingProtectedReferenceRoot(root)) {
    return [];
  }
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
      if (isExcludedEntry(entry.name) || isExcludedTopLevelEntry(entry.name, current.path, sourceRoot)) {
        continue;
      }
      const path = join(current.path, entry.name);
      if (excludeProtectedReferences && matchingProtectedReferenceRoot(path)) {
        continue;
      }
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
      if (parsed.getFullYear() < 1900) return { date: parsed, source: field, confidence: 'review', reason: 'placeholder_capture_date' };
      if (field === 'FileModifyDate') return { date: parsed, source: field, confidence: 'review', reason: 'filesystem_date_fallback' };
      if (path.toLowerCase().includes('imazing') && parsed.getFullYear() === 2025 && parsed.getMonth() === 6 && parsed.getDate() === 13) {
        return { date: parsed, source: field, confidence: 'review', reason: 'suspicious_imazing_import_date' };
      }
      return { date: parsed, source: field, confidence: 'high' };
    }
  }

  const filenameDate = parseFilenameDate(basename(path));
  if (filenameDate) {
    return { date: filenameDate, source: 'filename', confidence: 'medium' };
  }

  const pathDate = parseFilenameDate(path);
  if (pathDate) {
    return { date: pathDate, source: 'source_path', confidence: 'medium' };
  }

  return { date: new Date(mtimeMs), source: 'mtime', confidence: 'review', reason: 'filesystem_date_fallback' };
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

async function findCompanionFiles(file) {
  const directory = dirname(file.path);
  const stem = join(directory, basename(file.name, extname(file.name)));
  const candidates = new Set();
  // Preserve both ordinary sidecars (IMG_1234.xmp) and sidecars that retain
  // the media extension in their name (IMG_1234.JPG.xmp).
  for (const extension of ['.aae', '.xmp', '.dop', '.pp3', '.thm', '.json']) {
    candidates.add(`${stem}${extension}`);
    candidates.add(`${file.path}${extension}`);
  }
  // Apple Photos exports name adjustment sidecars IMG_O1234.aae while the
  // corresponding media is IMG_1234.*.
  const appleImage = /^IMG_(\d+)(\.[^.]+)?$/i.exec(file.name);
  if (appleImage) candidates.add(join(directory, `IMG_O${appleImage[1]}.aae`));

  const companions = [];
  for (const path of candidates) {
    try {
      const state = await stat(path);
      if (state.isFile()) companions.push({ sourcePath: path, fileName: basename(path), fileSizeBytes: state.size, sourceModifiedAt: new Date(state.mtimeMs).toISOString() });
    } catch {}
  }
  return companions.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
}

function assignLivePhotoGroups(records) {
  const groups = new Map();
  for (const record of records) {
    const key = join(dirname(record.file.path), basename(record.file.name, extname(record.file.name)).toLowerCase());
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    if (group.length < 2 || !group.some((record) => record.mediaKind === 'image') || !group.some((record) => record.mediaKind === 'video')) continue;
    const still = group.find((record) => record.mediaKind === 'image') ?? group[0];
    const dated = [still, ...group.filter((record) => record !== still)].find((record) => record.capture.date && record.capture.confidence !== 'review');
    const captureDate = dated?.capture.date ?? null;
    const decisionMismatch = new Set(group.map((record) => record.decision)).size > 1;
    const lowConfidence = group.some((record) => record.capture.confidence === 'review' || !record.capture.date);
    const groupId = createHash('sha1').update(group.map((record) => record.file.path).sort().join('\0')).digest('hex');
    const forceReview = decisionMismatch || lowConfidence;
    for (const record of group) {
      record.livePhotoGroup = {
        id: groupId,
        memberPaths: group.map((member) => member.file.path).sort(),
        anchorPath: still.file.path,
        companionOwnerId: still.id,
        captureDate,
        forceReview,
      };
    }
  }
}

function enforceLivePhotoAtomicity(operations) {
  const groups = new Map();
  for (const operation of operations) {
    const id = operation.livePhotoGroup?.id;
    if (!id) continue;
    const group = groups.get(id) ?? [];
    group.push(operation);
    groups.set(id, group);
  }
  for (const group of groups.values()) {
    const intents = new Set(group.map((operation) => operation.intent));
    const statuses = new Set(group.map((operation) => operation.status));
    const directories = new Set(group.map((operation) => operation.destinationPath ? dirname(operation.destinationPath) : null));
    const split = intents.size > 1 || statuses.size > 1 || directories.size > 1;
    if (!split) continue;
    for (const operation of group) {
      operation.status = 'review';
      operation.reason = 'live_photo_pair_review';
      operation.intent = 'manual_review';
      operation.destinationPath = null;
      operation.destinationState = null;
    }
  }
}

function enforceUniqueCompanionOwnership(operations) {
  const claimsByPath = new Map();
  for (const operation of operations) {
    for (const companion of operation.companionFiles || []) {
      const claims = claimsByPath.get(companion.sourcePath) ?? [];
      claims.push({ operation, companion });
      claimsByPath.set(companion.sourcePath, claims);
    }
  }

  for (const [companionPath, claims] of claimsByPath) {
    if (claims.length <= 1) continue;
    claims.sort(compareCompanionClaims);
    const owner = claims[0];
    const affected = new Set(claims.map((claim) => claim.operation));

    for (const claim of claims.slice(1)) {
      claim.operation.companionFiles = (claim.operation.companionFiles || []).filter(
        (companion) => companion.sourcePath !== companionPath,
      );
    }

    for (const operation of affected) {
      const conflicts = operation.companionOwnershipConflicts ?? [];
      operation.companionOwnershipConflicts = [
        ...conflicts,
        {
          companionPath,
          ownerOperationId: owner.operation.id,
          competingOperationIds: claims.map((claim) => claim.operation.id),
        },
      ];
      if (operation.status === 'planned') {
        operation.status = 'review';
        operation.reason = 'ambiguous_companion_sidecar_review';
        operation.intent = 'manual_review';
        operation.destinationPath = null;
        operation.destinationState = null;
      }
    }
  }
}

function compareCompanionClaims(left, right) {
  const leftScore = companionClaimScore(left.operation, left.companion);
  const rightScore = companionClaimScore(right.operation, right.companion);
  for (let index = 0; index < leftScore.length; index++) {
    if (leftScore[index] !== rightScore[index]) return leftScore[index] - rightScore[index];
  }
  return left.operation.sourcePath.localeCompare(right.operation.sourcePath);
}

function companionClaimScore(operation, companion) {
  return [
    companionSpecificity(operation, companion),
    operation.status === 'planned' ? 0 : operation.status === 'review' ? 1 : operation.status === 'conflict' ? 2 : 3,
    operation.intent === 'add_to_originals' || operation.intent === 'stage_new_candidate'
      ? 0
      : operation.intent === 'duplicate_quarantine'
        ? 1
        : 2,
    operation.mediaKind === 'image' ? 0 : 1,
  ];
}

function companionSpecificity(operation, companion) {
  const companionExtension = extname(companion.sourcePath).toLowerCase();
  if (companion.sourcePath === `${operation.sourcePath}${companionExtension}`) return 0;
  const operationStem = join(dirname(operation.sourcePath), basename(operation.originalFileName, extname(operation.originalFileName)));
  if (companion.sourcePath === `${operationStem}${companionExtension}`) return 1;
  return 2;
}

async function inventoryCompanions(sources, operations) {
  const extensions = new Set(['.aae', '.xmp', '.dop', '.pp3', '.thm', '.json']);
  const linked = new Set();
  const assignmentCounts = new Map();
  for (const operation of operations) {
    for (const companion of operation.companionFiles || []) {
      linked.add(companion.sourcePath);
      assignmentCounts.set(companion.sourcePath, (assignmentCounts.get(companion.sourcePath) ?? 0) + 1);
    }
  }
  const all = [];
  const stack = [...sources];
  while (stack.length) {
    const current = stack.pop();
    let directory;
    try {
      directory = await opendir(current);
    } catch {
      continue;
    }
    for await (const entry of directory) {
      if (isExcludedEntry(entry.name) || entry.name.startsWith('._')) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile() && extensions.has(extname(entry.name).toLowerCase())) all.push(path);
    }
  }
  const orphan = all.filter((path) => !linked.has(path)).sort();
  return {
    totalFiles: all.length,
    linkedFiles: linked.size,
    assignmentCount: [...assignmentCounts.values()].reduce((sum, count) => sum + count, 0),
    duplicateAssignments: [...assignmentCounts.values()].filter((count) => count > 1).length,
    orphanFiles: orphan,
    byExtension: countBy(all.map((path) => extname(path).toLowerCase())),
    orphanByExtension: countBy(orphan.map((path) => extname(path).toLowerCase())),
  };
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
    review: operations.filter((operation) => operation.status === 'review').length,
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

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
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

function phashFromHex(hex) {
  return { hi: Number.parseInt(hex.slice(0, 8), 16) >>> 0, lo: Number.parseInt(hex.slice(8, 16), 16) >>> 0, hex };
}

// Append-only resume index: one JSONL record per computed sha1/phash, keyed by path+size+mtime. A killed
// scan re-run with the same --resume-file replays this log and skips files already hashed, so a multi-hour
// 1-2M-file pass continues instead of restarting. Append is O(1); no whole-file rewrite at scale.
async function loadResumeIndex(...resumeFiles) {
  const index = new Map();
  for (const resumeFile of resumeFiles.filter(Boolean)) {
    let raw;
    try {
      raw = await readFile(resumeFile, 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // tolerate a torn final line from a crash
    }
    if (typeof record.p !== 'string') continue;
    const existing = index.get(record.p);
    if (existing && existing.size === record.s && existing.mtime === record.m) {
      if (record.sha1 !== undefined) existing.sha1 = record.sha1;
      if (record.phash !== undefined) existing.phash = record.phash;
      if (record.videoEvidence !== undefined) existing.videoEvidence = record.videoEvidence;
    } else {
      const entry = { size: record.s, mtime: record.m };
      if (record.sha1 !== undefined) entry.sha1 = record.sha1;
      if (record.phash !== undefined) entry.phash = record.phash;
      if (record.videoEvidence !== undefined) entry.videoEvidence = record.videoEvidence;
      index.set(record.p, entry);
    }
    }
  }
  return index;
}

function matchingProtectedReferenceRoot(path) {
  if (!path) {
    return null;
  }
  const candidate = resolve(path);
  return protectedReferenceRoots.find((root) => isSamePathOrDescendant(candidate, root)) ?? null;
}

function isSamePathOrDescendant(candidate, root) {
  const relationship = relative(root, candidate);
  return relationship === '' || (relationship !== '..' && !relationship.startsWith(`..${sep}`));
}

function assertNonProtectedMutationPath(path, label) {
  const protectedRoot = matchingProtectedReferenceRoot(path);
  if (protectedRoot) {
    throw new Error(`${label} must not target protected reference tree ${protectedRoot}: ${path}`);
  }
}

function assertReconcilePathSafety({ sources, originalsRoot, destinationRoot, duplicatesRoot }) {
  if (!destinationRoot) {
    throw new Error('reconcile-plan requires --dest when no writable destination can be inferred');
  }
  const protectedOriginalsRoot = matchingProtectedReferenceRoot(originalsRoot);
  if (protectedOriginalsRoot && destinationRoot === originalsRoot) {
    throw new Error(
      `--originals is comparison-only for protected reference tree ${protectedOriginalsRoot}; pass a separate non-protected --dest staging root`,
    );
  }
  assertNonProtectedMutationPath(destinationRoot, '--dest');
  assertNonProtectedMutationPath(duplicatesRoot, '--duplicates');
  if (destinationRoot === duplicatesRoot) {
    throw new Error('--dest and --duplicates must be separate roots');
  }
  for (const source of sources) {
    assertNonProtectedMutationPath(source, '--source');
  }
}

function buildProtectedReferencePolicy(originalsRoot, destinationRoot, duplicatesRoot) {
  return {
    protectedRoots: protectedReferenceRoots,
    originalsComparisonOnly: Boolean(matchingProtectedReferenceRoot(originalsRoot)),
    destinationIsNonProtected: !matchingProtectedReferenceRoot(destinationRoot),
    duplicatesIsNonProtected: !matchingProtectedReferenceRoot(duplicatesRoot),
    mutationAllowedForProtectedReferences: false,
  };
}

function assertPlanMutationSafety(plan) {
  const violations = [];
  for (const operation of plan.operations) {
    const sourceProtected = matchingProtectedReferenceRoot(operation.sourcePath);
    const destinationProtected = matchingProtectedReferenceRoot(operation.destinationPath);
    if (sourceProtected) {
      violations.push(`source ${operation.sourcePath} is within ${sourceProtected}`);
    }
    if (destinationProtected) {
      violations.push(`destination ${operation.destinationPath} is within ${destinationProtected}`);
    }
    if (violations.length >= 10) {
      break;
    }
  }
  if (violations.length > 0) {
    throw new Error(`Apply blocked by protected-reference policy: ${violations.join('; ')}`);
  }
}

function assertJournalMutationSafety(journal) {
  const planShape = { operations: journal.operations };
  assertPlanMutationSafety(planShape);
}

async function assertPathAbsent(path, label) {
  if (!path) {
    return;
  }
  try {
    await access(path);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return;
    }
    throw error;
  }
  throw new Error(`${label} already exists and will not be overwritten: ${path}`);
}

async function writeImmutableJson(path, payload, label) {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(`${label} artifact already exists and is immutable: ${path}`);
    }
    throw error;
  }
}

async function writeJournal(path, journal) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
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
