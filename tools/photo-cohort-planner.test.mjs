import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('builds non-overlapping Stage 3 coverage from a completed Stage 2 plan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'photo-cohort-planner-'));
  const sourceRoot = join(root, 'source');
  const planPath = join(root, 'stage2.json');
  const cohortPath = join(root, 'stage3.json');
  const progressPath = join(root, 'progress.json');
  const resumePath = join(root, 'resume.jsonl');
  const fakeExiftool = join(root, 'fake-exiftool.mjs');
  await mkdir(join(sourceRoot, 'Trip'), { recursive: true });
  await mkdir(join(sourceRoot, 'Photos'), { recursive: true });
  await Promise.all(
    ['Trip/a.jpg', 'Trip/a.aae', 'Trip/a.mov', 'Trip/b.jpg', 'Trip/c.jpg', 'Photos/d.jpg', 'copy.jpg'].map(
      (path) => writeFile(join(sourceRoot, path), ''),
    ),
  );
  const operations = [
    keeper('a', join(sourceRoot, 'Trip', 'a.jpg'), 'Trip/a.jpg', '2020-01-01T10:00:00.000Z'),
    keeper('b', join(sourceRoot, 'Trip', 'b.jpg'), 'Trip/b.jpg', '2020-01-01T11:00:00.000Z'),
    keeper('c', join(sourceRoot, 'Trip', 'c.jpg'), 'Trip/c.jpg', '2020-01-02T09:00:00.000Z'),
    {
      ...keeper('d', join(sourceRoot, 'Photos', 'd.jpg'), 'Photos/d.jpg', '2021-04-03T00:00:00.000Z'),
      status: 'conflict',
      captureDateSource: 'mtime',
      reason: 'destination_exists',
    },
    {
      id: 'e',
      status: 'planned',
      reason: 'content_sha1_duplicate',
      intent: 'duplicate_quarantine',
      sourcePath: join(sourceRoot, 'copy.jpg'),
      sourceRoot,
      relativePath: 'copy.jpg',
      fileSizeBytes: 50,
      sourceModifiedAt: '2020-01-01T00:00:00.000Z',
      captureDateTime: '2020-01-01T00:00:00.000Z',
      captureDateSource: 'DateTimeOriginal',
      duplicateEvidence: { type: 'content_sha1_matches_originals' },
      destinationPath: join(root, 'quarantine', 'copy.jpg'),
    },
  ];
  await writeFile(
    planPath,
    JSON.stringify({
      schema: 'photo-file-organizer-plan-v1',
      id: 'stage2',
      generatedAt: '2026-07-24T00:00:00.000Z',
      planKind: 'reconcile-originals-and-backups-perceptual',
      sourceRoots: [sourceRoot],
      originalsRoot: '/volume1/photosync/originals_clean',
      protectedReferencePolicy: {
        protectedRoots: ['/volume1/photo/originals', '/volume1/photosync/originals_clean'],
        mutationAllowedForProtectedReferences: false,
      },
      operations,
    }),
  );
  await writeFile(
    fakeExiftool,
    `#!/usr/bin/env node
if (process.argv.includes('-ver')) {
  console.log('test');
} else {
  const paths = process.argv.slice(2).filter((value) => !value.startsWith('-'));
  console.log(JSON.stringify(paths.map((SourceFile) => ({
    SourceFile,
    Make: 'Test',
    Model: 'Camera',
    GPSLatitude: 10,
    GPSLongitude: 20,
    ImageWidth: 4000,
    ImageHeight: 3000,
    MIMEType: 'image/jpeg',
    FileType: 'JPEG'
  }))));
}
`,
  );
  await chmod(fakeExiftool, 0o755);

  execFileSync(
    process.execPath,
    [
      new URL('./photo-cohort-planner.mjs', import.meta.url).pathname,
      'plan',
      '--dedupe-plan',
      planPath,
      '--plan-file',
      cohortPath,
      '--progress-file',
      progressPath,
      '--resume-file',
      resumePath,
      '--exiftool',
      fakeExiftool,
    ],
    { encoding: 'utf8' },
  );

  const result = JSON.parse(await readFile(cohortPath, 'utf8'));
  assert.equal(result.summary.stage2Operations, 5);
  assert.equal(result.summary.coveredOperations, 5);
  assert.equal(result.summary.unplannedOperations, 0);
  assert.equal(result.summary.eventCohorts, 1);
  assert.equal(result.summary.eventAssets, 3);
  assert.equal(result.summary.reviewCohorts, 1);
  assert.equal(result.summary.reviewAssets, 1);
  assert.equal(result.summary.coverageSummary.exact_duplicate_quarantine_candidate, 1);
  assert.equal(result.summary.coverageSummary.destination_conflict_review, 1);
  assert.equal(new Set(result.coverageLedger.map((item) => item.stage2OperationId)).size, 5);
  const firstEvent = result.cohorts.find((cohort) => cohort.cohortType === 'event');
  assert.equal(firstEvent.sidecarAssets, 1);
  assert.equal(firstEvent.livePhotoPairAssets, 1);
});

function keeper(id, sourcePath, relativePath, captureDateTime) {
  return {
    id,
    status: 'planned',
    reason: null,
    intent: 'stage_new_candidate',
    sourcePath,
    sourceRoot: join(dirname(sourcePath), '..'),
    relativePath,
    fileSizeBytes: 100,
    sourceModifiedAt: '2020-01-01T00:00:00.000Z',
    captureDateTime,
    captureDateSource: 'DateTimeOriginal',
    fileExtension: '.jpg',
    destinationPath: join(tmpdir(), 'staging', `${id}.jpg`),
  };
}

function dirname(path) {
  return path.slice(0, path.lastIndexOf('/'));
}
