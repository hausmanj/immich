#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const tool = resolve(dirname(fileURLToPath(import.meta.url)), 'photo-file-organizer.mjs');
const fixtureRoot = await mkdtemp(join(tmpdir(), 'photo-file-organizer-safety-'));

function run(...arguments_) {
  return spawnSync(process.execPath, [tool, ...arguments_], { encoding: 'utf8' });
}

try {
  const source = join(fixtureRoot, 'source');
  const originals = join(fixtureRoot, 'comparison-originals');
  const destination = join(fixtureRoot, 'destination');
  const duplicates = join(fixtureRoot, 'duplicates');
  const artifacts = join(fixtureRoot, 'artifacts');
  await Promise.all([
    mkdir(source),
    mkdir(originals),
    mkdir(destination),
    mkdir(duplicates),
    mkdir(artifacts),
  ]);
  const sourceFile = join(source, 'sample.jpg');
  await writeFile(sourceFile, Buffer.from('organizer safety fixture\n'));
  const sourceState = await stat(sourceFile);

  const protectedComparison = run(
    'reconcile-plan',
    '--source',
    source,
    '--originals',
    '/volume1/photosync/originals_clean',
    '--duplicates',
    duplicates,
    '--no-exif',
  );
  assert.notEqual(protectedComparison.status, 0);
  assert.match(protectedComparison.stderr, /comparison-only.*--dest/);

  const planFile = join(artifacts, 'immutable-plan.json');
  const firstPlan = run(
    'plan',
    '--source',
    source,
    '--dest',
    destination,
    '--plan-file',
    planFile,
    '--mode',
    'copy',
    '--no-exif',
  );
  assert.equal(firstPlan.status, 0, firstPlan.stderr);
  const secondPlan = run(
    'plan',
    '--source',
    source,
    '--dest',
    destination,
    '--plan-file',
    planFile,
    '--mode',
    'copy',
    '--no-exif',
  );
  assert.notEqual(secondPlan.status, 0);
  assert.match(secondPlan.stderr, /immutable/);

  const blockedPlanFile = join(artifacts, 'blocked-apply-plan.json');
  await writeFile(
    blockedPlanFile,
    `${JSON.stringify({
      schema: 'photo-file-organizer-plan-v1',
      id: 'blocked-plan',
      destinationRoot: '/volume1/photo/originals',
      mode: 'copy',
      summary: {},
      operations: [
        {
          id: 'blocked-operation',
          status: 'planned',
          action: 'copy',
          sourcePath: sourceFile,
          destinationPath: '/volume1/photo/originals/blocked.jpg',
          fileSizeBytes: sourceState.size,
          sha1: null,
        },
      ],
    })}\n`,
  );
  const blockedApply = run('apply', '--plan-file', blockedPlanFile);
  assert.notEqual(blockedApply.status, 0);
  assert.match(blockedApply.stderr, /Apply blocked by protected-reference policy/);

  const completedRun = join(artifacts, 'completed-run');
  await mkdir(completedRun);
  const completedProgress = join(completedRun, 'progress.json');
  const resumeFile = join(completedRun, 'resume.jsonl');
  await writeFile(completedProgress, `${JSON.stringify({ status: 'completed', pid: 999999 })}\n`);
  await writeFile(resumeFile, '');
  const blockedResume = run(
    'reconcile-plan',
    '--perceptual',
    '--source',
    source,
    '--originals',
    originals,
    '--dest',
    destination,
    '--duplicates',
    duplicates,
    '--plan-file',
    join(completedRun, 'plan.json'),
    '--progress-file',
    completedProgress,
    '--resume-file',
    resumeFile,
    '--resume-run',
    '--ffmpeg',
    '/usr/bin/true',
    '--no-exif',
  );
  assert.notEqual(blockedResume.status, 0);
  assert.match(blockedResume.stderr, /Completed progress artifact is immutable/);

  console.log('photo-file-organizer safety tests passed');
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}
