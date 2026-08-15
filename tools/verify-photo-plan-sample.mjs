#!/usr/bin/env node
// Fresh, read-only source verification for a deterministic sample of a plan.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const args = parseArgs(process.argv.slice(2));
const plan = JSON.parse(await readFile(resolve(required('plan-file')), 'utf8'));
const output = resolve(required('report-file'));
const sampleSize = Math.max(1, Number(args['sample-size'] || 100));
const planned = plan.operations.filter((operation) => operation.status === 'planned');
const stride = Math.max(1, Math.floor(planned.length / sampleSize));
const sample = planned.filter((_, index) => index % stride === 0).slice(0, sampleSize);
const failures = [];
for (const operation of sample) {
  try {
    const actual = await sha1(operation.sourcePath);
    if (actual !== operation.sha1) failures.push({ sourcePath: operation.sourcePath, reason: 'sha1_changed', expected: operation.sha1, actual });
  } catch (error) { failures.push({ sourcePath: operation.sourcePath, reason: String(error?.message || error) }); }
}
const report = { schema: 'photo-plan-sample-verification-v1', generatedAt: new Date().toISOString(), planFile: resolve(required('plan-file')), sampleSize: sample.length, plannedTotal: planned.length, verified: sample.length - failures.length, failures, passed: failures.length === 0 };
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exitCode = 1;

async function sha1(path) { const hash = createHash('sha1'); await new Promise((resolvePromise, rejectPromise) => { const stream = createReadStream(path); stream.on('data', (chunk) => hash.update(chunk)); stream.on('error', rejectPromise); stream.on('end', resolvePromise); }); return hash.digest('hex'); }
function required(key) { if (!args[key]) throw new Error(`--${key} is required`); return String(args[key]); }
function parseArgs(values) { const result = {}; for (let i = 0; i < values.length; i++) { const key = values[i].replace(/^--/, ''); result[key] = values[++i]; } return result; }
