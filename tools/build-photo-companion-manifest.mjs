#!/usr/bin/env node
// Read-only inventory of sidecars and companion media that must travel with a photo/video.
import { access, mkdir, opendir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';

const args = parseArgs(process.argv.slice(2));
const sources = toArray(args.source).map((value) => resolve(String(value)));
const output = args.output ? resolve(String(args.output)) : null;
if (!sources.length || !output) throw new Error('usage: --source PATH [--source PATH] --output PATH');
const sidecarExtensions = new Set(['.aae', '.json', '.xmp', '.thm', '.dop', '.pp3']);
const mediaExtensions = new Set(['.3g2', '.3gp', '.avi', '.heic', '.heif', '.jpeg', '.jpg', '.mov', '.mp4', '.png', '.raw', '.tif', '.tiff', '.webp']);
const excluded = new Set(['@eadir', '#recycle', '#snapshot', '.stversions', '.stfolder', 'thumbs', 'encoded-video']);

async function walk(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    const directory = await opendir(current);
    for await (const entry of directory) {
      if (excluded.has(entry.name.toLowerCase()) || entry.name.startsWith('._')) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile() && (mediaExtensions.has(extname(entry.name).toLowerCase()) || sidecarExtensions.has(extname(entry.name).toLowerCase()))) out.push(path);
    }
  }
  return out.sort();
}

const files = (await Promise.all(sources.map(walk))).flat();
const byStem = new Map();
for (const path of files) {
  const key = join(dirname(path), basename(path, extname(path)).toLowerCase());
  const list = byStem.get(key) || []; list.push(path); byStem.set(key, list);
}
const records = [];
const consumedSidecars = new Set();
for (const path of files) {
  const extension = extname(path).toLowerCase();
  if (!mediaExtensions.has(extension)) continue;
  const key = join(dirname(path), basename(path, extname(path)).toLowerCase());
  const siblings = byStem.get(key) || [];
  const sidecars = siblings.filter((item) => sidecarExtensions.has(extname(item).toLowerCase()));
  const mediaCompanions = siblings.filter((item) => item !== path && mediaExtensions.has(extname(item).toLowerCase()));
  sidecars.forEach((item) => consumedSidecars.add(item));
  records.push({ mediaPath: path, sidecars, mediaCompanions, livePhotoCompanion: mediaCompanions.some((item) => ['.mov', '.jpg', '.jpeg', '.heic', '.heif'].includes(extname(item).toLowerCase())) });
}
const orphanSidecars = files.filter((path) => sidecarExtensions.has(extname(path).toLowerCase()) && !consumedSidecars.has(path));
const report = { schema: 'photo-companion-manifest-v1', generatedAt: new Date().toISOString(), sources, summary: { mediaFiles: records.length, mediaWithSidecars: records.filter((record) => record.sidecars.length).length, mediaWithCompanions: records.filter((record) => record.mediaCompanions.length).length, orphanSidecars: orphanSidecars.length }, records, orphanSidecars };
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify(report.summary, null, 2));

function toArray(value) { return value === undefined ? [] : Array.isArray(value) ? value : [value]; }
function parseArgs(values) { const result = {}; for (let i = 0; i < values.length; i++) { const token = values[i]; if (!token.startsWith('--')) continue; const key = token.slice(2); const next = values[i + 1]; const value = next && !next.startsWith('--') ? next : true; if (value !== true) i++; result[key] = result[key] === undefined ? value : Array.isArray(result[key]) ? [...result[key], value] : [result[key], value]; } return result; }
