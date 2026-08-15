#!/usr/bin/env node
// Read-only visual review artifact. Generates thumbnails and a local HTML index from review operations.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { basename, extname, join, resolve } from 'node:path';

const args = parseArgs(process.argv.slice(2));
const plan = JSON.parse(await readFile(resolve(required('plan-file')), 'utf8'));
const outputDir = resolve(required('output-dir'));
const ffmpeg = String(args.ffmpeg || 'ffmpeg');
const limit = Math.max(1, Number(args.limit || 200));
const queue = String(args.queue || 'all');
const reason = args.reason ? String(args.reason) : null;
await mkdir(outputDir, { recursive: true });
const rows = [];
const failures = [];
const reviewOperations = plan.operations.filter((item) => item.status === 'review' && matchesQueue(item, queue) && (!reason || item.reason === reason));
for (const [index, operation] of reviewOperations.slice(0, limit).entries()) {
  const thumbnail = join(outputDir, `${String(index + 1).padStart(5, '0')}.jpg`);
  const result = spawnSync(ffmpeg, ['-y', '-loglevel', 'error', '-ss', '0', '-i', operation.sourcePath, '-frames:v', '1', '-vf', 'scale=320:-2', thumbnail], { encoding: 'utf8' });
  if (result.status !== 0) {
    failures.push({ sourcePath: operation.sourcePath, reason: result.stderr?.trim() || 'thumbnail_generation_failed' });
    continue;
  }
  rows.push({ thumbnail: basename(thumbnail), sourcePath: operation.sourcePath, reason: operation.reason, mediaKind: operation.mediaKind, captureDate: operation.captureDate, evidence: operation.duplicateEvidence || null });
}
const html = `<!doctype html><meta charset="utf-8"><title>Photo review queue</title><style>body{font:14px system-ui;background:#111;color:#eee}main{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:16px}.item{background:#222;padding:10px;border-radius:8px}.item img{width:100%;max-height:240px;object-fit:contain;background:#000}.path{word-break:break-all;color:#bbb}.reason{color:#fbbf24}</style><h1>Review queue (${rows.length})</h1><main>${rows.map((row) => `<article class="item"><img src="${escapeHtml(row.thumbnail)}"><div class="reason">${escapeHtml(row.reason || 'review')}</div><div>${escapeHtml(row.mediaKind || '')} ${escapeHtml(row.captureDate || '')}</div><div class="path">${escapeHtml(row.sourcePath)}</div></article>`).join('')}</main>`;
await writeFile(join(outputDir, 'index.html'), html, { flag: 'wx', mode: 0o600 });
await writeFile(join(outputDir, 'failures.json'), JSON.stringify(failures, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ outputDir, queue, reason, reviewed: rows.length, requested: limit, available: reviewOperations.length, failures: failures.length }, null, 2));

function required(key) { if (!args[key]) throw new Error(`--${key} is required`); return String(args[key]); }
function parseArgs(values) { const result = {}; for (let i = 0; i < values.length; i++) { const key = values[i].replace(/^--/, ''); result[key] = values[++i]; } return result; }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]); }
function matchesQueue(operation, value) {
  if (value === 'all') return true;
  if (value === 'perceptual') return operation.duplicateEvidence?.type?.startsWith('perceptual_');
  if (value === 'larger-than-original') return operation.duplicateEvidence?.largerThanOriginalMatch === true;
  if (value === 'low-confidence-date') return operation.captureDateConfidence === 'review' || !operation.captureDate;
  if (value === 'unhashable') return operation.perceptualHashStatus === 'unavailable';
  if (value === 'live-photo-pair') return Boolean(operation.livePhotoGroup?.id);
  return false;
}
