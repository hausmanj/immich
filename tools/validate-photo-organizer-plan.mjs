#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const args = parseArgs(process.argv.slice(2));
const planFile = requiredPath('plan-file');
const reportFile = requiredPath('report-file');
const expectedTotal = Number(args['expected-total']);
if (!Number.isInteger(expectedTotal) || expectedTotal < 1) {
  fail('--expected-total must be a positive integer');
}

const bytes = await readFile(planFile);
const plan = JSON.parse(bytes);
const violations = [];
const warnings = [];
let reviewManifest = null;
try {
  reviewManifest = JSON.parse(await readFile(`${planFile}.review-manifest.json`, 'utf8'));
} catch {
  violations.push('immutable review manifest is missing');
}
const protectedRoots = plan.protectedReferencePolicy?.protectedRoots ?? [];
const sourceRoots = plan.sourceRoots ?? [];
const operationIds = new Set();
const sourcePaths = new Set();
const destinationPaths = new Set();
const extensionKinds = {
  video: new Set([
    '.3g2',
    '.3gp',
    '.3gpp',
    '.asf',
    '.avi',
    '.braw',
    '.divx',
    '.dv',
    '.f4v',
    '.flv',
    '.gpr',
    '.insp',
    '.insv',
    '.lrv',
    '.m2t',
    '.m2ts',
    '.m4v',
    '.mkv',
    '.mov',
    '.mp4',
    '.mpe',
    '.mpeg',
    '.mpg',
    '.mxf',
    '.ogm',
    '.ogv',
    '.qt',
    '.rm',
    '.rmvb',
    '.ts',
    '.vob',
    '.webm',
    '.wmv',
  ]),
};
const counts = {
  operations: 0,
  keepers: 0,
  duplicateQuarantine: 0,
  planned: 0,
  review: 0,
  conflicts: 0,
  skipped: 0,
  exactDuplicates: 0,
  nearOriginal: 0,
  nearSource: 0,
  largerThanOriginal: 0,
  perceptualHashUnavailable: 0,
  videoPerceptualCandidates: 0,
  excludedPathViolations: 0,
  mediaEvidenceViolations: 0,
  perceptualMatches: 0,
  lowConfidenceDates: 0,
  companionFiles: 0,
  orphanSidecars: 0,
  livePhotoGroups: 0,
  livePhotoPairViolations: 0,
};
const bySourceRoot = {};
const byCoverageDecision = {};
const perceptualDistance = {};
const excludedComponents = new Set([
  '@eadir',
  '#recycle',
  '#snapshot',
  '.stversions',
  '.stfolder',
  'thumbs',
  'encoded-video',
]);
const livePhotoGroups = new Map();
const companionOwners = new Map();

if (plan.schema !== 'photo-file-organizer-plan-v1') violations.push(`unexpected schema: ${plan.schema}`);
if (plan.planKind !== 'reconcile-originals-and-backups-perceptual') {
  violations.push(`unexpected plan kind: ${plan.planKind}`);
}
if (plan.filters?.perceptual !== true) violations.push('perceptual mode is not enabled');
if (plan.protectedReferencePolicy?.mutationAllowedForProtectedReferences !== false) {
  violations.push('protected-reference mutation guard is absent');
}
if (!Array.isArray(plan.operations)) violations.push('operations is not an array');

for (const operation of plan.operations ?? []) {
  counts.operations++;
  if (operationIds.has(operation.id)) violations.push(`duplicate operation id: ${operation.id}`);
  operationIds.add(operation.id);
  if (sourcePaths.has(operation.sourcePath)) violations.push(`source assigned more than once: ${operation.sourcePath}`);
  sourcePaths.add(operation.sourcePath);
  if (!['move', 'copy'].includes(operation.action)) violations.push(`unsupported action: ${operation.action}`);
  if (!sourceRoots.some((root) => isUnder(operation.sourcePath, root))) {
    violations.push(`source outside declared roots: ${operation.sourcePath}`);
  }
  if (protectedRoots.some((root) => isUnder(operation.sourcePath, root))) {
    violations.push(`source crosses protected root: ${operation.sourcePath}`);
  }
  if (operation.destinationPath && protectedRoots.some((root) => isUnder(operation.destinationPath, root))) {
    violations.push(`destination crosses protected root: ${operation.destinationPath}`);
  }
  for (const companion of operation.companionFiles ?? []) {
    counts.companionFiles++;
    companionOwners.set(companion.sourcePath, (companionOwners.get(companion.sourcePath) ?? 0) + 1);
    if (!isUnder(companion.sourcePath, operation.sourceRoot)) {
      violations.push(`companion outside operation source root: ${companion.sourcePath}`);
    }
    if (protectedRoots.some((root) => isUnder(companion.sourcePath, root))) {
      violations.push(`companion crosses protected root: ${companion.sourcePath}`);
    }
    if (!Number.isInteger(companion.fileSizeBytes) || companion.fileSizeBytes < 0) {
      violations.push(`companion lacks valid size evidence: ${companion.sourcePath}`);
    }
  }
  if (
    operation.destinationPath &&
    !isUnder(operation.destinationPath, plan.destinationRoot) &&
    !isUnder(operation.destinationPath, plan.duplicatesRoot)
  ) {
    violations.push(`destination outside staging/quarantine: ${operation.destinationPath}`);
  }
  if (operation.destinationPath) {
    if (destinationPaths.has(operation.destinationPath) && operation.status !== 'conflict') {
      violations.push(`duplicate planned destination not marked conflict: ${operation.destinationPath}`);
    }
    destinationPaths.add(operation.destinationPath);
  }
  if (pathHasExcludedComponent(operation.sourcePath, excludedComponents)) {
    counts.excludedPathViolations++;
    violations.push(`excluded derivative/system path entered plan: ${operation.sourcePath}`);
  }
  if (!operation.sha1 || !/^[a-f0-9]{40}$/.test(operation.sha1)) {
    violations.push(`missing/invalid content SHA1: ${operation.sourcePath}`);
  }
  const lowConfidenceDate = operation.captureDateConfidence === 'review' || !operation.captureDate;
  if (lowConfidenceDate && operation.status !== 'review') {
    violations.push(`low-confidence date is not isolated for review: ${operation.sourcePath}`);
  }
  if (lowConfidenceDate) counts.lowConfidenceDates++;
  if (operation.duplicateEvidence?.largerThanOriginalMatch && operation.intent === 'duplicate_quarantine') {
    violations.push(`larger-than-original match routed to quarantine: ${operation.sourcePath}`);
  }
  if (operation.livePhotoGroup?.id) {
    const group = livePhotoGroups.get(operation.livePhotoGroup.id) ?? [];
    group.push(operation);
    livePhotoGroups.set(operation.livePhotoGroup.id, group);
  }

  bySourceRoot[operation.sourceRoot] = (bySourceRoot[operation.sourceRoot] ?? 0) + 1;
  counts[operation.status === 'conflict' ? 'conflicts' : operation.status === 'review' ? 'review' : operation.status === 'skipped' ? 'skipped' : 'planned']++;
  if (operation.perceptualHashStatus === 'unavailable') counts.perceptualHashUnavailable++;

  if (operation.intent === 'stage_new_candidate') {
    counts.keepers++;
    increment(byCoverageDecision, operation.status === 'conflict' ? 'keeper_conflict_review' : 'keeper_stage_candidate');
    continue;
  }
  const evidence = operation.duplicateEvidence;
  if (evidence?.type?.startsWith('perceptual_')) {
    counts.perceptualMatches++;
    if (evidence.largerThanOriginalMatch) counts.largerThanOriginal++;
    if (operation.intent === 'duplicate_quarantine') {
      violations.push(`perceptual match routed to automatic quarantine: ${operation.sourcePath}`);
    }
  }
  if (operation.mediaKind === 'video' && evidence?.type?.startsWith('perceptual_')) {
    const videoEvidence = operation.videoEvidence ?? evidence.videoEvidence;
    const matchEvidence = evidence.match?.videoEvidence ?? null;
    if (!videoEvidence || !Number.isFinite(videoEvidence.durationSeconds) || !videoEvidence.width || !videoEvidence.height || !videoEvidence.codec || !videoEvidence.container || (matchEvidence && (!matchEvidence.codec || !matchEvidence.container))) {
      counts.mediaEvidenceViolations++;
      violations.push(`video perceptual match lacks duration/dimensions/codec/container evidence: ${operation.sourcePath}`);
    }
    counts.videoPerceptualCandidates++;
  }
  const distance = operation.duplicateEvidence?.perceptualDistance;
  if (Number.isFinite(distance)) {
    perceptualDistance[String(distance)] = (perceptualDistance[String(distance)] ?? 0) + 1;
    if (distance > plan.filters.phashDistance) {
      violations.push(`perceptual distance exceeds threshold: ${operation.sourcePath}`);
    }
  }
  if (operation.intent !== 'duplicate_quarantine') {
    increment(byCoverageDecision, 'other_or_deferred');
    continue;
  }

  counts.duplicateQuarantine++;
  const type = operation.duplicateEvidence?.type;
  if (type === 'content_sha1_matches_originals' || type === 'content_sha1_matches_planned_source') {
    counts.exactDuplicates++;
    increment(byCoverageDecision, 'exact_duplicate_quarantine_candidate');
  } else if (type === 'perceptual_near_duplicate_of_original') {
    counts.nearOriginal++;
    increment(byCoverageDecision, 'near_original_manual_review');
  } else if (type === 'perceptual_near_duplicate_smaller_copy') {
    counts.nearSource++;
    increment(byCoverageDecision, 'near_source_manual_review');
    const keeperSize = operation.duplicateEvidence?.keeperFileSizeBytes;
    if (!Number.isFinite(keeperSize) || keeperSize < operation.fileSizeBytes) {
      violations.push(`largest-wins invariant failed: ${operation.sourcePath}`);
    }
  } else {
    violations.push(`duplicate operation lacks typed evidence: ${operation.sourcePath}`);
  }
}

for (const [groupId, group] of livePhotoGroups) {
  counts.livePhotoGroups++;
  const kinds = new Set(group.map((operation) => operation.mediaKind));
  const statuses = new Set(group.map((operation) => operation.status));
  const intents = new Set(group.map((operation) => operation.intent));
  const directories = new Set(group.map((operation) => operation.destinationPath ? dirname(operation.destinationPath) : null));
  if (kinds.has('image') && kinds.has('video') && (statuses.size > 1 || intents.size > 1 || directories.size > 1)) {
    counts.livePhotoPairViolations++;
    violations.push(`Live Photo pair is split across status, intent, or destination: ${groupId}`);
  }
}
for (const [path, owners] of companionOwners) {
  if (owners > 1) violations.push(`companion assigned to multiple operations: ${path}`);
}
const orphanSidecars = plan.companionInventory?.orphanFiles ?? [];
counts.orphanSidecars = orphanSidecars.length;
if (!plan.companionInventory) violations.push('companion inventory is missing');
if (reviewManifest) {
  const reviewIds = new Set((reviewManifest.operations ?? []).map((operation) => operation.id));
  const planReviewIds = new Set((plan.operations ?? []).filter((operation) => operation.status === 'review').map((operation) => operation.id));
  if (reviewIds.size !== (reviewManifest.operations ?? []).length) violations.push('review manifest contains duplicate operation ids');
  if (reviewIds.size !== planReviewIds.size || [...planReviewIds].some((id) => !reviewIds.has(id))) violations.push('review manifest does not exactly match plan review operations');
  if (orphanSidecars.length > 0 && !Array.isArray(reviewManifest.orphanSidecars)) violations.push('orphan sidecars are not represented in review manifest');
}

if (counts.operations !== expectedTotal) {
  violations.push(`coverage total mismatch: ${counts.operations}/${expectedTotal}`);
}
if (counts.operations !== operationIds.size || counts.operations !== sourcePaths.size) {
  violations.push('operation/source uniqueness check failed');
}
if (counts.videoPerceptualCandidates > 0) {
  warnings.push(
    `${counts.videoPerceptualCandidates} perceptual video matches require manual review because a first-frame dHash is not sufficient duplicate evidence`,
  );
}
if (counts.largerThanOriginal > 0) {
  warnings.push(`${counts.largerThanOriginal} sources are larger than their protected-original visual match`);
}
if (counts.conflicts > 0) warnings.push(`${counts.conflicts} destination conflicts require resolution before apply`);
if (counts.review > 0) warnings.push(`${counts.review} operations are isolated for manual review`);
if (counts.perceptualHashUnavailable > 0) {
  warnings.push(`${counts.perceptualHashUnavailable} files could not be perceptually hashed and were retained as unique`);
}

const structuralChecksPassed = violations.length === 0;
const report = {
  schema: 'photo-file-organizer-acceptance-v1',
  generatedAt: new Date().toISOString(),
  planFile,
  planSha256: createHash('sha256').update(bytes).digest('hex'),
  expectedTotal,
  result: {
    structurallyValid: structuralChecksPassed,
    completeCoverage: counts.operations === expectedTotal && operationIds.size === expectedTotal,
    protectedTreesExcludedFromOperations: !violations.some((item) => item.includes('protected root')),
    acceptableForReadOnlyStage3: structuralChecksPassed,
    acceptableForApply: false,
    applyRequiresExplicitReviewedApproval: true,
  },
  counts,
  bySourceRoot,
  byCoverageDecision,
  perceptualDistance,
  violations: violations.slice(0, 100),
  violationCount: violations.length,
  warnings,
  manualReviewQueues: {
    totalReviewOperations: counts.review,
    perceptualMatches: counts.perceptualMatches,
    lowConfidenceDates: counts.lowConfidenceDates,
    perceptualVideoMatches: counts.videoPerceptualCandidates,
    largerThanProtectedOriginalMatches: counts.largerThanOriginal,
    destinationConflicts: counts.conflicts,
    perceptualHashUnavailable: counts.perceptualHashUnavailable,
    orphanSidecars: counts.orphanSidecars,
    livePhotoGroups: counts.livePhotoGroups,
  },
};

const handle = await open(reportFile, 'wx', 0o600);
try {
  await handle.writeFile(JSON.stringify(report, null, 2) + '\n');
  await handle.sync();
} finally {
  await handle.close();
}
console.log(JSON.stringify(report, null, 2));
if (!structuralChecksPassed) process.exitCode = 1;

function increment(target, key) {
  target[key] = (target[key] ?? 0) + 1;
}

function isUnder(path, root) {
  return typeof path === 'string' && typeof root === 'string' && (path === root || path.startsWith(`${root}/`));
}

function pathHasExcludedComponent(path, excluded) {
  return String(path)
    .split('/')
    .some((component) => component.startsWith('._') || excluded.has(component.toLowerCase()));
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
    const value = values[index + 1];
    if (!value || value.startsWith('--')) fail(`Missing value for --${key}`);
    result[key] = value;
    index++;
  }
  return result;
}

function fail(message) {
  console.error(message);
  process.exit(2);
}
