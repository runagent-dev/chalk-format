// Writes the conformance corpus (conformance/valid, conformance/invalid) and cases.json.
// The files are committed; regenerate only on purpose (pnpm --filter @chalk-format/conformance generate),
// since every reader implementation is tested against these exact bytes.
import { mkdirSync, writeFileSync } from 'node:fs';
import JSZip from 'jszip';
import { hashBytes, type Lesson, type LessonPage, type Overlay } from '@chalk-format/model';
import { packLesson, packOverlay, type AssetBundle } from '@chalk-format/container';

const ROOT = new URL('../../../conformance/', import.meta.url);
const T = '2026-01-01T00:00:00.000Z';
// 1×1 transparent PNG
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));

type Case = { file: string; kind: 'lesson' | 'overlay'; valid: boolean; covers: string };
const cases: Case[] = [];
const write = (dir: 'valid' | 'invalid', name: string, bytes: Uint8Array, c: Omit<Case, 'file' | 'valid'>) => {
  mkdirSync(new URL(`${dir}/`, ROOT), { recursive: true });
  writeFileSync(new URL(`${dir}/${name}`, ROOT), bytes);
  cases.push({ file: `${dir}/${name}`, valid: dir === 'valid', ...c });
};
const page = (id: string, extra: Partial<LessonPage> = {}): LessonPage => ({ id, title: id, background: { type: 'blank' }, objects: [], ...extra });
const lesson = (extra: Partial<Lesson> = {}): Lesson => ({
  id: 'lesson_conformance', title: 'Conformance', locale: 'bn', pages: [page('p1')], snipPages: [], createdAt: T, updatedAt: T, ...extra,
});
/** Raw ZIP from a file map, for packages the packer would refuse to write. */
async function rawZip(files: Record<string, string | Uint8Array>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [path, data] of Object.entries(files)) zip.file(path, data, { date: new Date(T) });
  return zip.generateAsync({ type: 'uint8array' });
}
const manifest = (extra: Record<string, unknown> = {}) => JSON.stringify({
  format: 'chalkbook.lesson', version: '0.1.0', formatVersion: 7, id: 'lesson_raw', title: 'Raw', locale: 'en',
  pages: [{ id: 'p1', file: 'pages/page-1.json' }], assets: [], metadata: { createdAt: T, updatedAt: T }, ...extra,
});
const blankPage = JSON.stringify(page('p1'));

const png = await hashBytes(PNG);
const assets: AssetBundle = new Map([[png, { type: 'image/png', bytes: PNG }]]);

// ── valid ────────────────────────────────────────────────────────────────
write('valid', 'minimal.chalk', await packLesson(lesson()), { kind: 'lesson', covers: 'one blank page, fat bundle, no assets' });

write('valid', 'all-features.chalk', await packLesson(lesson({
  coverAssetId: png,
  pages: [
    page('p1', {
      width: 1600, height: 900,
      background: { type: 'color', color: '#fdf6e3' },
      textLayer: [{ text: 'পরীক্ষণ ১', x: 10, y: 10, width: 120, fontSize: 24 }],
      objects: [
        { id: 'o1', type: 'rect', x: 10, y: 10, width: 100, height: 50, fill: '#fff', stroke: '#000', strokeWidth: 2 },
        { id: 'o2', type: 'ellipse', x: 200, y: 10, width: 80, height: 40, fill: 'transparent', stroke: '#c00', strokeWidth: 1 },
        { id: 'o3', type: 'ink', x: 0, y: 0, points: [0, 0, 10, 10, 20, 5], color: '#1565c0', size: 4 },
        { id: 'o4', type: 'text', x: 20, y: 100, text: 'বিজ্ঞান · Science', fontSize: 32, fill: '#222' },
        { id: 'o5', type: 'line', x: 0, y: 200, x2: 300, y2: 200, stroke: '#333', strokeWidth: 2 },
        { id: 'o6', type: 'arrow', x: 0, y: 250, x2: 300, y2: 260, stroke: '#333', strokeWidth: 2 },
        { id: 'o7', type: 'vector', x: 0, y: 0, path: 'M10 300 L60 350 Z', fill: '#0a0' },
        { id: 'o8', type: 'image', x: 400, y: 100, assetId: png, width: 64, height: 64 },
        { id: 'o9', type: 'image', x: 500, y: 100, assetId: png, width: 64, height: 64, displayMode: 'icon' },
        { id: 'o10', type: 'embed', embed: 'video', x: 600, y: 100, width: 320, height: 180, url: 'https://example.org/v.mp4', poster: png },
        { id: 'o11', type: 'embed', embed: 'model3d', x: 600, y: 300, width: 200, height: 200, assetId: 'sha256:' + 'b'.repeat(64) },
        { id: 'o12', type: 'snip', x: 900, y: 100, snipPageId: 's1' },
      ],
    }),
    page('p2', { background: { type: 'pdf_page', assetId: 'sha256:' + 'c'.repeat(64), pageNumber: 1, renderedImageAssetId: png, thumbnailAssetId: png } }),
    page('p3', { background: { type: 'image', assetId: png } }),
  ],
  snipPages: [page('s1', { background: { type: 'image', assetId: png } })],
}), assets), { kind: 'lesson', covers: 'every object type, every background type, text layer (Bengali), snip page, cover, inline + external assets' });

write('valid', 'thin.chalk', await packLesson(lesson({ pages: [page('p1', { background: { type: 'image', assetId: png } })] }), assets, { mode: 'thin' }),
  { kind: 'lesson', covers: 'thin bundle: sha256 asset listed with inline:false and no bytes' });

write('valid', 'legacy-no-format-version.chalk', await rawZip({
  'manifest.json': JSON.stringify({ format: 'chalkbook.lesson', version: '0.1.0', id: 'old', title: 'Old', locale: 'en',
    pages: [{ id: 'p1', file: 'pages/page-1.json' }], assets: [], metadata: { createdAt: T, updatedAt: T } }),
  'pages/page-1.json': blankPage,
}), { kind: 'lesson', covers: 'files written before formatVersion/snipPages existed are read as version 1 and migrated' });

const overlay: Overlay = { base: { id: 'lesson_conformance', version: 7 }, pages: { p1: { upsertedObjects: [
  { id: 'note', type: 'text', x: 5, y: 5, text: 'teacher note', fontSize: 18, fill: '#c00' }] } }, newPages: [], updatedAt: T };
write('valid', 'overlay.chalk', await packOverlay(overlay), { kind: 'overlay', covers: 'overlay package (kind: overlay) over a base lesson' });

// ── invalid ──────────────────────────────────────────────────────────────
write('invalid', 'no-manifest.chalk', await rawZip({ 'pages/page-1.json': blankPage }), { kind: 'lesson', covers: 'manifest.json missing' });
write('invalid', 'wrong-format-id.chalk', await rawZip({ 'manifest.json': manifest({ format: 'epub' }), 'pages/page-1.json': blankPage }),
  { kind: 'lesson', covers: 'manifest.format is not chalkbook.lesson' });
write('invalid', 'path-traversal.chalk', await rawZip({ 'manifest.json': manifest({ pages: [{ id: 'p1', file: '../../etc/page.json' }] }), 'pages/page-1.json': blankPage }),
  { kind: 'lesson', covers: 'page path escapes the package' });
write('invalid', 'missing-page-file.chalk', await rawZip({ 'manifest.json': manifest() }), { kind: 'lesson', covers: 'manifest lists a page file that is not in the ZIP' });
write('invalid', 'bad-page-json.chalk', await rawZip({ 'manifest.json': manifest(), 'pages/page-1.json': '{ not json' }), { kind: 'lesson', covers: 'page file is not JSON' });
write('invalid', 'unknown-object-type.chalk', await rawZip({ 'manifest.json': manifest(),
  'pages/page-1.json': JSON.stringify(page('p1', { objects: [{ id: 'q', type: 'quiz', x: 0, y: 0 } as never] })) }),
  { kind: 'lesson', covers: 'object type outside the 1.0 set (1.0 readers reject; see spec §Compatibility for the planned fallback rule)' });
write('invalid', 'missing-inline-asset.chalk', await rawZip({
  'manifest.json': manifest({ assets: [{ id: png, type: 'image/png', path: `assets/${png.replace(':', '_')}`, inline: true }] }), 'pages/page-1.json': blankPage }),
  { kind: 'lesson', covers: 'asset declared inline but its bytes are absent' });

writeFileSync(new URL('cases.json', ROOT), JSON.stringify(cases, null, 2) + '\n');
console.log(`${cases.length} cases → conformance/`);
