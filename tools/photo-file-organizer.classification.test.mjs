#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const tool = resolve(dirname(fileURLToPath(import.meta.url)), 'photo-file-organizer.mjs');
const validator = resolve(dirname(fileURLToPath(import.meta.url)), 'validate-photo-organizer-plan.mjs');
const companionManifest = resolve(dirname(fileURLToPath(import.meta.url)), 'build-photo-companion-manifest.mjs');
const sampleVerifier = resolve(dirname(fileURLToPath(import.meta.url)), 'verify-photo-plan-sample.mjs');
const contactSheet = resolve(dirname(fileURLToPath(import.meta.url)), 'generate-photo-review-contact-sheet.mjs');
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const root = await mkdtemp(join(tmpdir(), 'photo-file-organizer-classification-'));

function run(...args) {
  return spawnSync(process.execPath, [tool, ...args], { encoding: 'utf8' });
}

function makeMedia(path, video = false, color = 'red', duration = 1, variation = false) {
  const input = video ? ['-f', 'lavfi', '-i', `color=c=${color}:s=64x64:d=${duration}`, '-frames:v', String(Math.max(12, duration * 12)), '-pix_fmt', 'yuv420p'] : ['-f', 'lavfi', '-i', `color=c=${color}:s=64x64`, '-frames:v', '1'];
  const result = spawnSync(ffmpeg, ['-y', '-loglevel', 'error', ...input, ...(variation ? ['-metadata', 'comment=burst-variation'] : []), path], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

try {
  const originals = join(root, 'originals');
  const sourceA = join(root, 'source-a');
  const sourceB = join(root, 'source-b');
  const destination = join(root, 'destination');
  const duplicates = join(root, 'duplicates');
  const artifacts = join(root, 'artifacts');
  await Promise.all([mkdir(originals), mkdir(sourceA), mkdir(sourceB), mkdir(destination), mkdir(duplicates), mkdir(artifacts)]);

  makeMedia(join(originals, '20240101-reference.jpg'), false, 'red');
  makeMedia(join(sourceA, '20240101-live.jpg'), false, 'blue');
  makeMedia(join(sourceA, '20240101-live.mov'), true, 'blue');
  makeMedia(join(sourceA, '20240102-long.mov'), true, 'red', 2);
  makeMedia(join(sourceA, '20240101-collision.jpg'), false, 'green');
  makeMedia(join(sourceB, '20240101-collision.jpg'), false, 'blue');
  makeMedia(join(sourceB, '20240103-burst.jpg'), false, '0xff0001');
  makeMedia(join(sourceB, 'undated.jpg'), false, 'yellow');
  makeMedia(join(sourceB, 'XMP.jpg'), false, 'purple');
  makeMedia(join(sourceB, 'XMP.png'), false, 'orange');
  await writeFile(join(sourceA, '20240101-live.xmp'), '<xmpmeta>fixture</xmpmeta>\n');
  await writeFile(join(sourceB, 'XMP.xmp'), '<xmpmeta>shared-stem fixture</xmpmeta>\n');

  const planFile = join(artifacts, 'classification-plan.json');
  const result = run(
    'reconcile-plan', '--perceptual',
    '--source', sourceA, '--source', sourceB,
    '--originals', originals, '--dest', destination, '--duplicates', duplicates,
    '--plan-file', planFile, '--no-exif', '--ffmpeg', ffmpeg, '--phash-distance', '0',
  );
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(await readFile(planFile, 'utf8'));
  const reportFile = join(artifacts, 'classification-acceptance.json');
  const validation = spawnSync(process.execPath, [validator, '--plan-file', planFile, '--report-file', reportFile, '--expected-total', '9'], { encoding: 'utf8' });
  assert.equal(validation.status, 0, validation.stderr || validation.stdout);
  const byName = new Map(plan.operations.map((operation) => [operation.originalFileName + ':' + operation.sourcePath, operation]));
  const liveVideo = [...byName.values()].find((operation) => operation.originalFileName === '20240101-live.mov');
  assert.ok(liveVideo);
  assert.notEqual(liveVideo.reason, 'perceptual_near_duplicate_of_original', 'image/video match must not be treated as a perceptual duplicate');
  assert.equal(liveVideo.intent, 'manual_review', 'Live Photo pair remains together for review when one member has a visual match');
  assert.equal(liveVideo.reason, 'live_photo_pair_review');
  const liveImage = [...byName.values()].find((operation) => operation.originalFileName === '20240101-live.jpg');
  assert.equal(liveImage.companionFiles.length, 1, 'same-stem XMP sidecar is attached to the media operation');
  assert.equal(liveImage.companionFiles[0].fileName, '20240101-live.xmp');
  const longVideo = [...byName.values()].find((operation) => operation.originalFileName === '20240102-long.mov');
  assert.ok(longVideo);
  assert.notEqual(longVideo.reason, 'perceptual_near_duplicate_of_original', 'video duration mismatch must block perceptual duplicate classification');
  const burst = [...byName.values()].find((operation) => operation.originalFileName === '20240103-burst.jpg');
  assert.equal(burst.intent, 'manual_review', 'perceptual similarity remains review-only for expression/burst variation');
  assert.equal(burst.reason, 'perceptual_match_manual_review');

  const sharedStemRows = [...byName.values()].filter((operation) => ['XMP.jpg', 'XMP.png'].includes(operation.originalFileName));
  assert.equal(sharedStemRows.length, 2);
  assert.equal(
    sharedStemRows.reduce((count, operation) => count + (operation.companionFiles || []).filter((companion) => companion.fileName === 'XMP.xmp').length, 0),
    1,
    'same-stem sidecar shared by multiple media files must have a single operation owner',
  );
  assert.equal(
    sharedStemRows.every((operation) => (operation.companionOwnershipConflicts || []).some((conflict) => conflict.companionPath.endsWith('/XMP.xmp'))),
    true,
    'ambiguous same-stem sidecar claims are recorded on each affected operation',
  );

  const collisionRows = [...byName.values()].filter((operation) => operation.originalFileName === '20240101-collision.jpg');
  assert.equal(collisionRows.length, 2);
  assert.equal(new Set(collisionRows.map((operation) => operation.destinationPath)).size, 2, 'same-name destinations must be deterministic and unique');
  assert.equal(collisionRows.some((operation) => operation.status === 'conflict'), false);

  const undated = [...byName.values()].find((operation) => operation.originalFileName === 'undated.jpg');
  assert.equal(undated.status, 'review');
  assert.equal(undated.reason, 'filesystem_date_fallback');

  const manifestFile = join(artifacts, 'companions.json');
  const manifestResult = spawnSync(process.execPath, [companionManifest, '--source', sourceA, '--source', sourceB, '--output', manifestFile], { encoding: 'utf8' });
  assert.equal(manifestResult.status, 0, manifestResult.stderr || manifestResult.stdout);
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  assert.equal(manifest.summary.mediaWithSidecars, 4);

  const sampleFile = join(artifacts, 'sample-verification.json');
  const sampleResult = spawnSync(process.execPath, [sampleVerifier, '--plan-file', planFile, '--report-file', sampleFile, '--sample-size', '3'], { encoding: 'utf8' });
  assert.equal(sampleResult.status, 0, sampleResult.stderr || sampleResult.stdout);

  const contactDir = join(artifacts, 'contact-sheet');
  const sheetResult = spawnSync(process.execPath, [contactSheet, '--plan-file', planFile, '--output-dir', contactDir, '--limit', '3', '--ffmpeg', ffmpeg], { encoding: 'utf8' });
  assert.equal(sheetResult.status, 0, sheetResult.stderr || sheetResult.stdout);
  assert.match(await readFile(join(contactDir, 'index.html'), 'utf8'), /Review queue/);

  console.log('photo-file-organizer classification tests passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
