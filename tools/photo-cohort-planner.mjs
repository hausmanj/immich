#!/usr/bin/env node

import { appendFile, mkdir, open, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const command = argv.shift();
const args = parseArgs(argv);

if (command !== 'plan') {
  fail(
    'Usage: node tools/photo-cohort-planner.mjs plan --dedupe-plan PATH --plan-file PATH ' +
      '--progress-file PATH --resume-file PATH [--resume-run] [--exiftool PATH]',
  );
}

await buildPlan().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

async function buildPlan() {
  const dedupePlanPath = requiredPath('dedupe-plan');
  const planFile = requiredPath('plan-file');
  const progressFile = requiredPath('progress-file');
  const resumeFile = requiredPath('resume-file');
  const resumeRun = args['resume-run'] === true || args['resume-run'] === 'true';
  const exiftool = typeof args.exiftool === 'string' ? args.exiftool : 'exiftool';

  const dedupePlan = JSON.parse(await readFile(dedupePlanPath, 'utf8'));
  assertDedupePlan(dedupePlan);
  await initializeArtifacts({ planFile, progressFile, resumeFile, resumeRun, dedupePlanPath });

  const progress = {
    schema: 'photo-cohort-planner-progress-v1',
    runId: randomUUID(),
    command: 'plan',
    dedupePlan: dedupePlanPath,
    planFile,
    resumeFile,
    status: 'running',
    phase: 'loading_stage_2',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    totals: {
      stage2Operations: dedupePlan.operations.length,
      keeperCandidates: 0,
      metadataToRead: 0,
    },
    counters: {
      metadataRead: 0,
      metadataReused: 0,
      keepersAssigned: 0,
      stage2DecisionsAssigned: 0,
    },
    result: null,
    error: null,
  };
  await emitProgress(progressFile, progress);

  try {
    const assignments = [];
    const keepers = [];
    for (const operation of dedupePlan.operations) {
      if (operation.intent === 'stage_new_candidate') {
        keepers.push(toKeeper(operation));
      } else {
        assignments.push(toStage2Assignment(operation));
        progress.counters.stage2DecisionsAssigned++;
      }
    }
    progress.totals.keeperCandidates = keepers.length;
    progress.totals.metadataToRead = keepers.length;
    progress.phase = 'extracting_metadata';
    await emitProgress(progressFile, progress);

    const resumeIndex = await loadResumeIndex(resumeFile);
    const metadata = new Map();
    const pending = [];
    for (const keeper of keepers) {
      const cached = resumeIndex.get(keeper.sourcePath);
      if (
        cached &&
        cached.fileSizeBytes === keeper.fileSizeBytes &&
        cached.sourceModifiedAt === keeper.sourceModifiedAt
      ) {
        metadata.set(keeper.sourcePath, cached.metadata);
        progress.counters.metadataRead++;
        progress.counters.metadataReused++;
      } else {
        pending.push(keeper);
      }
    }
    await emitProgress(progressFile, progress);

    assertExecutable(exiftool);
    for (let index = 0; index < pending.length; index += 200) {
      const batch = pending.slice(index, index + 200);
      const batchMetadata = readMetadata(exiftool, batch.map((item) => item.sourcePath));
      let resumeBuffer = '';
      for (const keeper of batch) {
        const value = normalizeMetadata(batchMetadata.get(keeper.sourcePath));
        metadata.set(keeper.sourcePath, value);
        resumeBuffer +=
          JSON.stringify({
            sourcePath: keeper.sourcePath,
            fileSizeBytes: keeper.fileSizeBytes,
            sourceModifiedAt: keeper.sourceModifiedAt,
            metadata: value,
          }) + '\n';
        progress.counters.metadataRead++;
      }
      if (resumeBuffer) {
        await appendFile(resumeFile, resumeBuffer, { mode: 0o600 });
      }
      await emitProgress(progressFile, progress);
    }

    progress.phase = 'profiling_sources';
    await emitProgress(progressFile, progress);
    for (const keeper of keepers) {
      keeper.metadata = metadata.get(keeper.sourcePath) ?? normalizeMetadata(null);
      keeper.risks = keeperRisks(keeper);
    }
    await annotateCompanions(keepers);
    const directoryProfiles = buildDirectoryProfiles(keepers);

    progress.phase = 'building_event_cohorts';
    await emitProgress(progressFile, progress);
    const eventCohorts = [];
    const reviewCohorts = [];
    for (const [directoryKey, assets] of groupBy(keepers, (item) => item.directoryKey)) {
      const profile = directoryProfiles.get(directoryKey);
      if (isPreservedEventDirectory(profile)) {
        eventCohorts.push(buildCohort('event', profile.eventLabel, assets, 'source_event_folder', 'high'));
        continue;
      }

      for (const session of temporalSessions(assets)) {
        const reliable = session.filter((asset) => asset.captureDateSource !== 'mtime');
        if (session.length >= 3 && reliable.length / session.length >= 0.7) {
          eventCohorts.push(buildCohort('event', sessionLabel(session, profile), session, 'temporal_source_session', 'medium'));
        } else {
          reviewCohorts.push(
            buildCohort(
              'date_source_camera_review',
              sessionLabel(session, profile),
              session,
              'weak_or_sparse_capture_evidence',
              'review',
            ),
          );
        }
      }
    }

    const cohortByAsset = new Map();
    for (const cohort of [...eventCohorts, ...reviewCohorts]) {
      for (const asset of cohort.assets) {
        if (cohortByAsset.has(asset.sourcePath)) {
          throw new Error(`Stage 3 overlap: ${asset.sourcePath}`);
        }
        cohortByAsset.set(asset.sourcePath, cohort);
      }
    }

    progress.phase = 'building_coverage_ledger';
    await emitProgress(progressFile, progress);
    for (const keeper of keepers) {
      const cohort = cohortByAsset.get(keeper.sourcePath);
      if (!cohort) {
        throw new Error(`Stage 3 uncovered keeper: ${keeper.sourcePath}`);
      }
      assignments.push({
        stage2OperationId: keeper.stage2OperationId,
        sourcePath: keeper.sourcePath,
        sourceRoot: keeper.sourceRoot,
        fileSizeBytes: keeper.fileSizeBytes,
        captureDateTime: keeper.captureDateTime,
        captureDateSource: keeper.captureDateSource,
        coverageStatus:
          keeper.stage2Status === 'conflict'
            ? 'destination_conflict_review'
            : cohort.cohortType === 'event'
              ? 'event_cohort'
              : 'date_source_camera_review',
        cohortId: cohort.id,
        risks: keeper.risks,
        evidence: {
          camera: cameraLabel(keeper.metadata),
          gps: gpsValue(keeper.metadata),
          dimensions: dimensionsValue(keeper.metadata),
          mimeType: keeper.metadata.mimeType,
          companions: keeper.companions,
        },
      });
      progress.counters.keepersAssigned++;
    }

    const coveredOperationIds = new Set(assignments.map((item) => item.stage2OperationId));
    if (coveredOperationIds.size !== dedupePlan.operations.length) {
      throw new Error(
        `Stage 3 coverage mismatch: ${coveredOperationIds.size}/${dedupePlan.operations.length} unique operations assigned`,
      );
    }

    const cohortSummaries = [...eventCohorts, ...reviewCohorts].map(stripCohortAssets);
    const coverageSummary = countBy(assignments.map((item) => item.coverageStatus));
    const riskSummary = countBy(assignments.flatMap((item) => item.risks ?? []));
    const payload = {
      schema: 'photo-cohort-plan-v1',
      id: randomUUID(),
      generatedAt: new Date().toISOString(),
      stage: 3,
      readOnly: true,
      sourceDedupePlan: {
        path: dedupePlanPath,
        id: dedupePlan.id,
        generatedAt: dedupePlan.generatedAt,
        operationCount: dedupePlan.operations.length,
        sourceRoots: dedupePlan.sourceRoots,
        originalsRoot: dedupePlan.originalsRoot,
      },
      policy: {
        eventFirst: true,
        gpsIsAnchorNotRequirement: true,
        temporalGapHours: 48,
        maximumSessionDays: 21,
        broadFoldersDecomposed: true,
        mutationsAuthorized: false,
      },
      summary: {
        stage2Operations: dedupePlan.operations.length,
        keeperCandidates: keepers.length,
        duplicateOrDeferredDecisions: dedupePlan.operations.length - keepers.length,
        eventCohorts: eventCohorts.length,
        eventAssets: eventCohorts.reduce((total, cohort) => total + cohort.assetCount, 0),
        reviewCohorts: reviewCohorts.length,
        reviewAssets: reviewCohorts.reduce((total, cohort) => total + cohort.assetCount, 0),
        coveredOperations: coveredOperationIds.size,
        unplannedOperations: dedupePlan.operations.length - coveredOperationIds.size,
        coverageSummary,
        riskSummary,
      },
      sourceDirectoryProfiles: [...directoryProfiles.values()].map(stripProfileAssets),
      cohorts: cohortSummaries,
      coverageLedger: assignments.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath)),
    };

    progress.phase = 'writing_plan';
    await emitProgress(progressFile, progress);
    await writeImmutableJson(planFile, payload);
    progress.status = 'completed';
    progress.phase = 'completed';
    progress.result = payload.summary;
    await emitProgress(progressFile, progress);
    console.log(JSON.stringify({ status: 'planned', planFile, progressFile, summary: payload.summary }, null, 2));
  } catch (error) {
    progress.status = 'error';
    progress.phase = 'error';
    progress.error = error instanceof Error ? error.message : String(error);
    await emitProgress(progressFile, progress);
    throw error;
  }
}

function toKeeper(operation) {
  const captureDate = new Date(operation.captureDateTime);
  const logicalRelativeDirectory = logicalEventDirectory(operation.relativePath);
  return {
    stage2OperationId: operation.id,
    stage2Status: operation.status,
    sourcePath: operation.sourcePath,
    sourceRoot: operation.sourceRoot,
    relativePath: operation.relativePath,
    directoryKey: `${operation.sourceRoot}\0${logicalRelativeDirectory}`,
    sourceDirectory:
      logicalRelativeDirectory === '.' ? operation.sourceRoot : resolve(operation.sourceRoot, logicalRelativeDirectory),
    assetDirectory: dirname(operation.sourcePath),
    logicalRelativeDirectory,
    fileSizeBytes: operation.fileSizeBytes,
    sourceModifiedAt: operation.sourceModifiedAt,
    captureDate,
    captureDateTime: operation.captureDateTime,
    captureDateSource: operation.captureDateSource,
    fileExtension: operation.fileExtension,
    metadata: null,
    risks: [],
  };
}

function toStage2Assignment(operation) {
  const duplicateType = operation.duplicateEvidence?.type ?? null;
  let coverageStatus = 'stage2_deferred_review';
  if (operation.intent === 'duplicate_quarantine') {
    coverageStatus =
      duplicateType === 'content_sha1_matches_originals' || duplicateType === 'content_sha1_matches_planned_source'
        ? 'exact_duplicate_quarantine_candidate'
        : duplicateType === 'perceptual_near_duplicate_of_original'
          ? 'near_original_quarantine_review'
          : 'near_source_quarantine_review';
  } else if (operation.status === 'skipped') {
    coverageStatus = 'stage2_skipped_review';
  } else if (operation.status === 'conflict') {
    coverageStatus = 'destination_conflict_review';
  }
  return {
    stage2OperationId: operation.id,
    sourcePath: operation.sourcePath,
    sourceRoot: operation.sourceRoot,
    fileSizeBytes: operation.fileSizeBytes,
    captureDateTime: operation.captureDateTime,
    captureDateSource: operation.captureDateSource,
    coverageStatus,
    cohortId: null,
    risks: operation.duplicateEvidence?.largerThanOriginalMatch ? ['larger_than_protected_original_match'] : [],
    evidence: {
      stage2Reason: operation.reason,
      duplicateEvidence: operation.duplicateEvidence ?? null,
    },
  };
}

function buildDirectoryProfiles(keepers) {
  const result = new Map();
  for (const [key, assets] of groupBy(keepers, (item) => item.directoryKey)) {
    const dates = assets.map((item) => item.captureDate).sort((a, b) => a - b);
    const relativeDirectory = assets[0].logicalRelativeDirectory;
    const label = relativeDirectory === '.' ? basename(assets[0].sourceRoot) : basename(relativeDirectory);
    result.set(key, {
      key,
      sourceRoot: assets[0].sourceRoot,
      sourceDirectory: assets[0].sourceDirectory,
      relativeDirectory,
      eventLabel: cleanLabel(label),
      genericName: isGenericName(label),
      datePrefixedName: hasDatePrefix(label),
      assetCount: assets.length,
      startDate: dates[0].toISOString(),
      endDate: dates.at(-1).toISOString(),
      spanDays: Math.max(1, Math.ceil((dates.at(-1) - dates[0]) / 86_400_000) + 1),
      activeDays: new Set(dates.map(toDateOnly)).size,
      distinctCameras: new Set(assets.map((asset) => cameraLabel(asset.metadata)).filter(Boolean)).size,
      gpsAssets: assets.filter((asset) => gpsValue(asset.metadata)).length,
      sidecarAssets: assets.filter((asset) => asset.companions.sidecars.length > 0).length,
      livePhotoPairAssets: assets.filter((asset) => asset.companions.livePhotoPair).length,
      assets,
    });
  }
  return result;
}

function isPreservedEventDirectory(profile) {
  if (profile.genericName) return false;
  if (profile.datePrefixedName && profile.spanDays <= 120) return true;
  return profile.assetCount <= 500 && profile.spanDays <= 31 && profile.activeDays <= 21;
}

function temporalSessions(assets) {
  const sorted = [...assets].sort(
    (a, b) => a.captureDate - b.captureDate || a.sourcePath.localeCompare(b.sourcePath),
  );
  const sessions = [];
  let current = [];
  for (const asset of sorted) {
    const previous = current.at(-1);
    const gapHours = previous ? (asset.captureDate - previous.captureDate) / 3_600_000 : 0;
    const spanDays = current.length > 0 ? (asset.captureDate - current[0].captureDate) / 86_400_000 : 0;
    if (current.length > 0 && (gapHours > 48 || spanDays > 21)) {
      sessions.push(current);
      current = [];
    }
    current.push(asset);
  }
  if (current.length > 0) sessions.push(current);
  return sessions;
}

function buildCohort(cohortType, name, assets, reason, confidence) {
  const sorted = [...assets].sort(
    (a, b) => a.captureDate - b.captureDate || a.sourcePath.localeCompare(b.sourcePath),
  );
  const gps = sorted.map((asset) => gpsValue(asset.metadata)).filter(Boolean);
  return {
    id: randomUUID(),
    cohortType,
    name,
    reason,
    confidence,
    assetCount: sorted.length,
    startDate: sorted[0].captureDate.toISOString(),
    endDate: sorted.at(-1).captureDate.toISOString(),
    sourceRoots: [...new Set(sorted.map((asset) => asset.sourceRoot))].sort(),
    sourceDirectories: [...new Set(sorted.map((asset) => asset.sourceDirectory))].sort(),
    cameras: countBy(sorted.map((asset) => cameraLabel(asset.metadata)).filter(Boolean)),
    gpsAssetCount: gps.length,
    gpsCentroid: gps.length
      ? {
          latitude: round(gps.reduce((sum, value) => sum + value.latitude, 0) / gps.length, 5),
          longitude: round(gps.reduce((sum, value) => sum + value.longitude, 0) / gps.length, 5),
        }
      : null,
    riskSummary: countBy(sorted.flatMap((asset) => asset.risks)),
    sidecarAssets: sorted.filter((asset) => asset.companions.sidecars.length > 0).length,
    livePhotoPairAssets: sorted.filter((asset) => asset.companions.livePhotoPair).length,
    assets: sorted,
  };
}

function sessionLabel(session, profile) {
  const start = toDateOnly(session[0].captureDate);
  const end = toDateOnly(session.at(-1).captureDate);
  const date = start === end ? start : `${start} to ${end}`;
  const gps = session.map((asset) => gpsValue(asset.metadata)).find(Boolean);
  const location = gps ? ` GPS ${round(gps.latitude, 2)},${round(gps.longitude, 2)}` : '';
  const source = profile.genericName ? basename(profile.sourceRoot) : profile.eventLabel;
  return `${date} ${source}${location}`.trim();
}

function keeperRisks(keeper) {
  const risks = [];
  if (keeper.captureDateSource === 'mtime') risks.push('mtime_only_capture_date');
  if (!cameraLabel(keeper.metadata)) risks.push('camera_unknown');
  if (!gpsValue(keeper.metadata)) risks.push('gps_absent');
  if (!dimensionsValue(keeper.metadata)) risks.push('dimensions_unknown');
  if (keeper.stage2Status === 'conflict') risks.push('stage2_destination_conflict');
  return risks;
}

async function annotateCompanions(keepers) {
  for (const [, assets] of groupBy(keepers, (item) => item.assetDirectory)) {
    let names = [];
    try {
      names = await readdir(assets[0].assetDirectory);
    } catch (error) {
      for (const asset of assets) {
        asset.companions = {
          sidecars: [],
          livePhotoPair: null,
          directoryReadError: error instanceof Error ? error.message : String(error),
        };
        asset.risks.push('companion_directory_unreadable');
      }
      continue;
    }
    const actualByLower = new Map(names.map((name) => [name.toLowerCase(), name]));
    for (const asset of assets) {
      const fileName = basename(asset.sourcePath);
      const extension = extname(fileName);
      const stem = fileName.slice(0, -extension.length);
      const sidecarNames = new Set();
      for (const candidate of [
        `${stem}.aae`,
        `${stem}.xmp`,
        `${fileName}.xmp`,
        `${stem}.json`,
        `${fileName}.json`,
      ]) {
        const actual = actualByLower.get(candidate.toLowerCase());
        if (actual && actual.toLowerCase() !== fileName.toLowerCase()) {
          sidecarNames.add(resolve(asset.assetDirectory, actual));
        }
      }
      let livePhotoPair = null;
      if (isImageExtension(extension)) {
        const actual = actualByLower.get(`${stem}.mov`.toLowerCase());
        if (actual) livePhotoPair = resolve(asset.assetDirectory, actual);
      } else if (extension.toLowerCase() === '.mov') {
        for (const imageExtension of ['.heic', '.heif', '.jpg', '.jpeg']) {
          const actual = actualByLower.get(`${stem}${imageExtension}`.toLowerCase());
          if (actual) {
            livePhotoPair = resolve(asset.assetDirectory, actual);
            break;
          }
        }
      }
      asset.companions = {
        sidecars: [...sidecarNames].sort(),
        livePhotoPair,
        directoryReadError: null,
      };
    }
  }
}

function isImageExtension(extension) {
  return ['.avif', '.dng', '.heic', '.heif', '.jpeg', '.jpg', '.png', '.tif', '.tiff'].includes(
    extension.toLowerCase(),
  );
}

function logicalEventDirectory(relativePath) {
  const parts = dirname(relativePath)
    .split(/[\\/]/)
    .filter((part) => part && part !== '.');
  if (parts.length === 0) return '.';

  const datedIndex = parts.findIndex((part) => hasDatePrefix(part));
  if (datedIndex >= 0) return parts.slice(0, datedIndex + 1).join('/');

  while (parts.length > 0 && isCameraSubfolder(parts.at(-1))) parts.pop();
  return parts.length > 0 ? parts.join('/') : '.';
}

function isCameraSubfolder(value) {
  return /^(?:camera|camcorder|canon(?: camera)?|gopro(?: camera)?|iphone(?: camera)?|nikon(?: camera)?|olympus(?: camera)?|panasonic(?: camera)?|sony(?: camera)?|videos?)$/i.test(
    String(value).trim(),
  );
}

function readMetadata(exiftool, paths) {
  const result = spawnSync(
    exiftool,
    [
      '-json',
      '-n',
      '-Make',
      '-Model',
      '-GPSLatitude',
      '-GPSLongitude',
      '-ImageWidth',
      '-ImageHeight',
      '-Duration',
      '-MIMEType',
      '-FileType',
      ...paths,
    ],
    { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(`ExifTool metadata batch failed: ${String(result.stderr).slice(0, 2000)}`);
  }
  const map = new Map();
  for (const item of JSON.parse(result.stdout || '[]')) {
    if (typeof item.SourceFile === 'string') map.set(resolve(item.SourceFile), item);
  }
  return map;
}

function normalizeMetadata(value) {
  return {
    make: text(value?.Make),
    model: text(value?.Model),
    latitude: finite(value?.GPSLatitude),
    longitude: finite(value?.GPSLongitude),
    width: positiveInteger(value?.ImageWidth),
    height: positiveInteger(value?.ImageHeight),
    durationSeconds: finite(value?.Duration),
    mimeType: text(value?.MIMEType),
    fileType: text(value?.FileType),
  };
}

function cameraLabel(metadata) {
  return [metadata?.make, metadata?.model].filter(Boolean).join(' ').trim() || null;
}

function gpsValue(metadata) {
  return Number.isFinite(metadata?.latitude) && Number.isFinite(metadata?.longitude)
    ? { latitude: metadata.latitude, longitude: metadata.longitude }
    : null;
}

function dimensionsValue(metadata) {
  return metadata?.width && metadata?.height ? { width: metadata.width, height: metadata.height } : null;
}

function stripCohortAssets(cohort) {
  const { assets, ...summary } = cohort;
  return {
    ...summary,
    examples: assets.slice(0, 5).map((asset) => asset.sourcePath),
  };
}

function stripProfileAssets(profile) {
  const { assets, ...summary } = profile;
  return summary;
}

function assertDedupePlan(plan) {
  if (plan?.schema !== 'photo-file-organizer-plan-v1' || !Array.isArray(plan.operations)) {
    throw new Error('Stage 3 requires a completed photo-file-organizer Stage 2 plan');
  }
  if (plan.planKind !== 'reconcile-originals-and-backups-perceptual') {
    throw new Error(`Unexpected Stage 2 plan kind: ${plan.planKind}`);
  }
  if (plan.protectedReferencePolicy?.mutationAllowedForProtectedReferences !== false) {
    throw new Error('Stage 2 plan does not contain the protected-originals mutation guard');
  }
  const protectedRoots = plan.protectedReferencePolicy.protectedRoots ?? [];
  const protectedOperation = plan.operations.find((operation) =>
    protectedRoots.some(
      (root) =>
        operation.sourcePath === root ||
        operation.sourcePath?.startsWith(`${root}/`) ||
        operation.destinationPath === root ||
        operation.destinationPath?.startsWith(`${root}/`),
    ),
  );
  if (protectedOperation) {
    throw new Error(`Stage 2 operation crosses a protected tree: ${protectedOperation.sourcePath}`);
  }
}

async function initializeArtifacts({ planFile, progressFile, resumeFile, resumeRun, dedupePlanPath }) {
  if (await exists(planFile)) throw new Error(`Cohort plan is immutable and already exists: ${planFile}`);
  if (!resumeRun && ((await exists(progressFile)) || (await exists(resumeFile)))) {
    throw new Error('Existing progress/resume artifacts require --resume-run');
  }
  if (resumeRun && (await exists(progressFile))) {
    const existing = JSON.parse(await readFile(progressFile, 'utf8'));
    if (existing.status === 'completed') throw new Error('Completed Stage 3 progress is immutable');
    if (existing.dedupePlan !== dedupePlanPath) throw new Error('Resume artifact belongs to another Stage 2 plan');
  }
  await mkdir(dirname(planFile), { recursive: true, mode: 0o700 });
  await mkdir(dirname(progressFile), { recursive: true, mode: 0o700 });
  await mkdir(dirname(resumeFile), { recursive: true, mode: 0o700 });
  if (!(await exists(resumeFile))) await writeFile(resumeFile, '', { flag: 'wx', mode: 0o600 });
}

async function loadResumeIndex(path) {
  const result = new Map();
  const content = await readFile(path, 'utf8');
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    const item = JSON.parse(line);
    if (typeof item.sourcePath === 'string') result.set(item.sourcePath, item);
  }
  return result;
}

async function emitProgress(path, progress) {
  progress.updatedAt = new Date().toISOString();
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, JSON.stringify(progress, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, path);
}

async function writeImmutableJson(path, value) {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function assertExecutable(command) {
  const result = spawnSync(command, ['-ver'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`ExifTool is not runnable: ${command}`);
}

function groupBy(values, keyOf) {
  const result = new Map();
  for (const value of values) {
    const key = keyOf(value);
    const group = result.get(key) ?? [];
    group.push(value);
    result.set(key, group);
  }
  return result;
}

function countBy(values) {
  const result = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}

function cleanLabel(value) {
  return String(value || 'Unsorted')
    .replaceAll(/[\\/:\0]/g, '-')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

function isGenericName(value) {
  return /^(aa?photos|archive|backup|camera|dcim|downloads|hold|images|media|originals|photo|photos|pictures|raw photo and video files|uploads?)$/i.test(
    String(value).trim(),
  );
}

function hasDatePrefix(value) {
  return /^(?:19|20)\d{2}(?:[-_]\d{2})?(?:[-_]\d{2})?(?:\s|$)|^[A-Z][a-z]{2}\s+\d{1,2},\s+(?:19|20)\d{2}/.test(
    String(value).trim(),
  );
}

function toDateOnly(value) {
  const date = value instanceof Date ? value : new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function requiredPath(name) {
  if (typeof args[name] !== 'string') fail(`Missing --${name}`);
  return resolve(args[name]);
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index++) {
    const token = values[index];
    if (!token.startsWith('--')) fail(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (values[index + 1] && !values[index + 1].startsWith('--')) {
      result[key] = values[++index];
    } else {
      result[key] = true;
    }
  }
  return result;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function fail(message) {
  console.error(message);
  process.exit(2);
}
