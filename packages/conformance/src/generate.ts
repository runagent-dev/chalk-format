// Writes the conformance corpus (conformance/valid, conformance/invalid) and cases.json.
// The files are committed; regenerate only on purpose (pnpm --filter @chalk-format/conformance generate),
// since every reader implementation is tested against these exact bytes. Cases of an earlier spec version are
// frozen: written only when missing, so a later formatVersion never rewrites them (they must keep opening as
// they are). Delete a file to regenerate it.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import JSZip from 'jszip';
import { assetKey, hashBytes, type Lesson, type LessonPage, type Overlay, type StoreDescriptor } from '@chalk-format/model';
import { packLesson, packOverlay, publishStreamed, unpackLesson, type AssetBundle } from '@chalk-format/container';

const ROOT = new URL('../../../conformance/', import.meta.url);
const T = '2026-01-01T00:00:00.000Z';
// 1×1 transparent PNG
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));

type Case = { file: string; kind: 'lesson' | 'overlay'; valid: boolean; since: '1.0' | '1.1' | '1.2' | '1.3' | '1.5'; covers: string };
const cases: Case[] = [];
const CURRENT = '1.5';
const write = (dir: 'valid' | 'invalid', name: string, bytes: Uint8Array, c: Omit<Case, 'file' | 'valid' | 'since'> & { since?: Case['since'] }) => {
  const since = c.since ?? '1.0', url = new URL(`${dir}/${name}`, ROOT);
  mkdirSync(new URL(`${dir}/`, ROOT), { recursive: true });
  if (since === CURRENT || !existsSync(url)) writeFileSync(url, bytes);
  cases.push({ file: `${dir}/${name}`, valid: dir === 'valid', kind: c.kind, since, covers: c.covers });
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

// ── 1.1: labs ────────────────────────────────────────────────────────────
// The example lab as entry, a minimal GLB it may load, the PNG as poster; and a widget whose plugin no reader knows.
const PENDULUM = new Uint8Array(readFileSync(new URL('../../../examples/labs/pendulum.html', import.meta.url)));
const glbJson = new TextEncoder().encode('{"asset":{"version":"2.0"}}  ');   // padded to 4 bytes
const GLB = new Uint8Array(12 + 8 + glbJson.length);
new DataView(GLB.buffer).setUint32(0, 0x46546c67, true); new DataView(GLB.buffer).setUint32(4, 2, true); new DataView(GLB.buffer).setUint32(8, GLB.length, true);
new DataView(GLB.buffer).setUint32(12, glbJson.length, true); new DataView(GLB.buffer).setUint32(16, 0x4e4f534a, true); GLB.set(glbJson, 20);
const pendulum = await hashBytes(PENDULUM), glb = await hashBytes(GLB);
const labAssets: AssetBundle = new Map([...assets, [pendulum, { type: 'text/html', bytes: PENDULUM }], [glb, { type: 'model/gltf-binary', bytes: GLB }]]);
const labObject = {
  id: 'lab1', type: 'embed' as const, embed: 'plugin' as const, plugin: 'chalk.lab', x: 100, y: 100, width: 960, height: 540, poster: png,
  lab: { id: 'org.chalk-format.examples.pendulum', version: '1.0.0', title: 'Simple pendulum · সরল দোলক', entry: pendulum, assets: [glb],
    params: { length: 0.8, swings: 10, readings: 3 }, capabilities: ['state', 'progress', 'assets'] },
};
write('valid', 'lab.chalk', await packLesson(lesson({ pages: [page('p1', { objects: [
  labObject,
  { id: 'w1', type: 'embed', embed: 'plugin', plugin: 'org.example.unknown-widget', x: 100, y: 700, width: 320, height: 180, poster: png },
] })] }), labAssets), { kind: 'lesson', since: '1.1', covers: 'a lab (entry HTML, a GLB it may load, poster, params, capabilities) and a plugin no reader knows (must draw its poster card, spec 1.1 §2.2)' });

const labPage = (lab: Record<string, unknown>, extra: Record<string, unknown> = {}) => JSON.stringify(page('p1', { objects: [{ ...labObject, lab: { ...labObject.lab, ...lab }, ...extra } as never] }));
write('invalid', 'lab-without-descriptor.chalk', await rawZip({ 'manifest.json': manifest({ formatVersion: 8 }), 'pages/page-1.json': labPage({}, { lab: undefined }) }),
  { kind: 'lesson', since: '1.1', covers: "plugin 'chalk.lab' without a lab descriptor" });
write('invalid', 'lab-entry-not-content-addressed.chalk', await rawZip({ 'manifest.json': manifest({ formatVersion: 8 }), 'pages/page-1.json': labPage({ entry: 'pendulum.html' }) }),
  { kind: 'lesson', since: '1.1', covers: 'lab.entry is a file name, not a sha256: id (hosts could not verify what they run)' });

// ── 1.2: asset stores ────────────────────────────────────────────────────
// Every id a c1 key (spec 1.2 §3), fat: the page image, an image object, a poster and a lab's entry.
const k = { png: await assetKey(PNG), lab: await assetKey(PENDULUM), glb: await assetKey(GLB) };
const c1Assets: AssetBundle = new Map([[k.png, { type: 'image/png', bytes: PNG }], [k.lab, { type: 'text/html', bytes: PENDULUM }], [k.glb, { type: 'model/gltf-binary', bytes: GLB }]]);
write('valid', 'c1-keys.chalk', await packLesson(lesson({ coverAssetId: k.png, pages: [page('p1', {
  background: { type: 'image', assetId: k.png },
  objects: [
    { id: 'img', type: 'image', x: 10, y: 10, assetId: k.png, width: 64, height: 64 },
    { id: 'm', type: 'embed', embed: 'model3d', x: 100, y: 10, width: 200, height: 200, assetId: k.glb, poster: k.png },
    { ...labObject, poster: k.png, lab: { ...labObject.lab, entry: k.lab, assets: [k.glb] } },
  ],
})] }), c1Assets), { kind: 'lesson', since: '1.2', covers: 'every asset id a c1 key, carried in the file: page image, image object, poster, 3D model, lab entry and lab asset' });

// Thin: the media is external, with sizes, meta, renditions, and the stores the publisher suggests.
const video = 'c1:' + 'v'.repeat(25) + 'a', video360 = 'c1:' + 'w'.repeat(25) + 'a';
const sources: StoreDescriptor[] = [
  { id: 'publisher-cdn', kind: 'derived', template: 'https://media.example.org/c1/{h0}/{h1}/{h}', media: ['video/*', 'image/*'], priority: 10 },
  { id: 'publisher-archive', kind: 'indexed', base: 'https://archive.example.org/chalk/', priority: 20 },
];
write('valid', 'thin-sources.chalk', await packLesson(lesson({ pages: [page('p1', { objects: [
  { id: 'v', type: 'embed', embed: 'video', x: 10, y: 10, width: 640, height: 360, assetId: video, poster: k.png },
] })] }), new Map([[k.png, { type: 'image/png', bytes: PNG }]]), {
  mode: 'thin', alwaysInline: new Set([k.png]), assetSources: sources,
  assetInfo: new Map([[video, { type: 'video/mp4', size: 18_400_211, meta: { width: 1280, height: 720, duration: 94.5 },
    renditions: [{ id: video360, type: 'video/mp4', size: 6_100_022, meta: { width: 640, height: 360 } }] }]]),
}), { kind: 'lesson', since: '1.2', covers: 'thin book: external video with size, meta and a rendition; the poster carried inline; suggested stores (derived, indexed)' });

const badKey = 'C1:' + k.png.slice(3).toUpperCase();
write('invalid', 'c1-malformed-key.chalk', await rawZip({
  'manifest.json': manifest({ formatVersion: 9, assets: [{ id: badKey, type: 'image/png', path: 'assets/C1_X', inline: true }] }),
  'pages/page-1.json': blankPage, 'assets/C1_X': PNG,
}), { kind: 'lesson', since: '1.2', covers: 'an asset id that looks like a c1 key but is not canonical (upper case)' });
write('invalid', 'c1-bearer-source.chalk', await rawZip({
  'manifest.json': manifest({ formatVersion: 9, assetSources: [{ id: 'private', kind: 'api', base: 'https://store.example.org/', auth: 'bearer' }] }),
  'pages/page-1.json': blankPage,
}), { kind: 'lesson', since: '1.2', covers: "a book's suggested store asks for credentials (books carry none)" });

// store examples (spec 1.2 §5), validated against schema/store.schema.json and index-shard.schema.json
mkdirSync(new URL('stores/', ROOT), { recursive: true });
const shardKey = k.glb.slice(3);
const storeFiles: Record<string, unknown> = {
  'derived.json': { id: 'media-r2', kind: 'derived', template: 'https://media.example.org/c1/{h0}/{h1}/{h}', media: ['video/*', 'image/*', 'model/*', 'audio/*'], priority: 10, verify: 'first' },
  'indexed.json': { id: 'school-server', kind: 'indexed', base: 'http://192.168.1.10/chalk/', priority: 0 },
  'api.json': { id: 'registry', kind: 'api', base: 'https://store.example.org/', priority: 50, auth: 'bearer', verify: 'always' },
  [`index-${shardKey.slice(0, 2)}.json`]: { v: 1, entries: { [shardKey]: { p: 'physics/class9/screw-gauge.glb', s: GLB.length, t: 'model/gltf-binary' } } },
};
for (const [name, doc] of Object.entries(storeFiles)) writeFileSync(new URL(`stores/${name}`, ROOT), JSON.stringify(doc, null, 2) + '\n');

// ── 1.3: presentation ────────────────────────────────────────────────────
// Every field on every kind it applies to, plus values from a later version (an icon and a `show` this
// version does not know), which readers must accept and treat as defaults (spec 1.3 §1).
{
  const k = { png: await assetKey(PNG), glb: await assetKey(GLB), lab: await assetKey(PENDULUM) };
  const media: AssetBundle = new Map([[k.png, { type: 'image/png', bytes: PNG }], [k.glb, { type: 'model/gltf-binary', bytes: GLB }], [k.lab, { type: 'text/html', bytes: PENDULUM }]]);
  write('valid', 'presentation.chalk', await packLesson(lesson({ pages: [page('p1', { objects: [
    { id: 'img-popup', type: 'image', x: 10, y: 10, width: 120, height: 90, assetId: k.png, presentation: { open: 'popup', label: 'চিত্র ১' } },
    { id: 'img-icon', type: 'image', x: 150, y: 10, width: 120, height: 90, assetId: k.png, displayMode: 'icon', presentation: { open: 'fullscreen', icon: 'eye', accent: '#1F4D8F' } },
    { id: 'model-live', type: 'embed', embed: 'model3d', x: 10, y: 120, width: 400, height: 300, assetId: k.glb, poster: k.png,
      presentation: { show: 'live', autoRotate: true, label: 'স্ক্রু গজ', icon: 'ruler', accent: '#2f6f4e' } },
    { id: 'video', type: 'embed', embed: 'video', x: 420, y: 120, width: 320, height: 180, url: 'https://media.example.org/pendulum.mp4', poster: k.png,
      presentation: { show: 'live', autoplay: true, muted: true, loop: true, open: 'popup' } },
    { id: 'audio', type: 'embed', embed: 'audio', x: 420, y: 320, width: 320, height: 60, url: 'https://media.example.org/fork.mp3', presentation: { autoplay: true, loop: true, label: 'সুরশলাকা' } },
    { ...labObject, id: 'lab-full', poster: k.png, lab: { ...labObject.lab, entry: k.lab, assets: [k.glb] }, presentation: { open: 'fullscreen', icon: 'atom' } },
    { id: 'later', type: 'embed', embed: 'model3d', x: 760, y: 120, width: 200, height: 200, assetId: k.glb, displayMode: 'icon',
      presentation: { show: 'hologram', open: 'sideways', icon: 'telescope', sparkle: true } },
  ] })] }), media), { kind: 'lesson', since: '1.3', covers: 'presentation on images, models, video, audio and a lab; unknown show, open and icon values and an unknown field (accepted, defaults)' });
}

// ── 1.5: lab libraries ───────────────────────────────────────────────────
// A lab that imports three.js (a stand-in module here: the real build is 700 KB) supplied by the reader.
const THREE_STUB = new TextEncoder().encode('export const REVISION = "stub"; export class Scene {}\n');
const LAB3D = new TextEncoder().encode('<!doctype html><script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.183.2/build/three.module.js"}}</script><script type="module">import * as THREE from "three"; document.title = THREE.REVISION;</script>');
{
  const k3 = await assetKey(THREE_STUB), kl = await assetKey(LAB3D), kp = await assetKey(PNG);
  write('valid', 'lab-libraries.chalk', await packLesson(lesson({ pages: [page('p1', { objects: [
    { ...labObject, poster: kp, lab: { ...labObject.lab, id: 'org.example.three-lab', entry: kl, assets: [], libraries: [{ specifier: 'three', version: '0.183.2', asset: k3 }] } },
  ] })] }), new Map([[k3, { type: 'text/javascript', bytes: THREE_STUB }], [kl, { type: 'text/html', bytes: LAB3D }], [kp, { type: 'image/png', bytes: PNG }]])),
  { kind: 'lesson', since: '1.5', covers: 'a lab with a library the reader supplies, and its own import map for running on its own' });
}
const labWith = (libraries: unknown) => JSON.stringify(page('p1', { objects: [{ ...labObject, lab: { ...labObject.lab, libraries } } as never] }));
write('invalid', 'lab-library-not-content-addressed.chalk', await rawZip({ 'manifest.json': manifest({ formatVersion: 11 }), 'pages/page-1.json': labWith([{ specifier: 'three', version: '0.183.2', asset: 'three.js' }]) }),
  { kind: 'lesson', since: '1.5', covers: 'a library whose asset is not content-addressed' });
write('invalid', 'lab-library-duplicate.chalk', await rawZip({ 'manifest.json': manifest({ formatVersion: 11 }), 'pages/page-1.json': labWith([{ specifier: 'three', version: '1', asset: 'c1:' + 'a'.repeat(25) + 'a' }, { specifier: 'three', version: '2', asset: 'c1:' + 'b'.repeat(25) + 'a' }]) }),
  { kind: 'lesson', since: '1.5', covers: 'the same library specifier twice' });

// ── invalid ──────────────────────────────────────────────────────────────
const embedWith = (presentation: Record<string, unknown>) => JSON.stringify(page('p1', { objects: [
  { id: 'm', type: 'embed', embed: 'model3d', x: 0, y: 0, width: 100, height: 100, url: 'https://media.example.org/m.glb', presentation } as never] }));
write('invalid', 'presentation-accent.chalk', await rawZip({ 'manifest.json': manifest({ formatVersion: 10 }), 'pages/page-1.json': embedWith({ accent: 'url(https://evil.example/x)' }) }),
  { kind: 'lesson', since: '1.3', covers: 'an accent that is CSS, not a #rrggbb colour' });
write('invalid', 'presentation-label.chalk', await rawZip({ 'manifest.json': manifest({ formatVersion: 10 }), 'pages/page-1.json': embedWith({ label: '' }) }),
  { kind: 'lesson', since: '1.3', covers: 'an empty label' });
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

// ── 1.6: the floating window ─────────────────────────────────────────────
// `open: window` on an image, a video, a model, a lab and an icon; a pre-1.6 reader treats it as an unknown value (the defaults).
{
  const k = { png: await assetKey(PNG), glb: await assetKey(GLB), lab: await assetKey(PENDULUM) };
  const media: AssetBundle = new Map([[k.png, { type: 'image/png', bytes: PNG }], [k.glb, { type: 'model/gltf-binary', bytes: GLB }], [k.lab, { type: 'text/html', bytes: PENDULUM }]]);
  write('valid', 'presentation-window.chalk', await packLesson(lesson({ pages: [page('p1', { objects: [
    { id: 'img-window', type: 'image', x: 10, y: 10, width: 120, height: 90, assetId: k.png, presentation: { open: 'window', label: 'চিত্র ২' } },
    { id: 'img-icon-window', type: 'image', x: 150, y: 10, width: 120, height: 90, assetId: k.png, displayMode: 'icon', presentation: { open: 'window', icon: 'eye' } },
    { id: 'model-window', type: 'embed', embed: 'model3d', x: 10, y: 120, width: 400, height: 300, assetId: k.glb, poster: k.png, presentation: { open: 'window', label: 'স্ক্রু গজ' } },
    { id: 'video-window', type: 'embed', embed: 'video', x: 420, y: 120, width: 320, height: 180, url: 'https://media.example.org/pendulum.mp4', poster: k.png, presentation: { open: 'window' } },
    { ...labObject, id: 'lab-window', poster: k.png, lab: { ...labObject.lab, entry: k.lab, assets: [k.glb] }, presentation: { open: 'window', icon: 'atom' } },
  ] })] }), media), { kind: 'lesson', since: '1.6', covers: 'open: window (the floating window) on an image, an icon image, a model, a video and a lab' });
}

writeFileSync(new URL('cases.json', ROOT), JSON.stringify(cases, null, 2) + '\n');
console.log(`${cases.length} cases → conformance/`);

// ---- 1.4: a streamed book (spec 1.4 §8): valid/presentation.chalk as a directory ----
{
  const r = await unpackLesson(new Uint8Array(readFileSync(new URL('valid/presentation.chalk', ROOT))));
  const { files } = await publishStreamed(r.lesson, r.assets, { assetInfo: r.assetInfo });
  const dir = new URL('streamed/presentation/', ROOT);
  rmSync(dir, { recursive: true, force: true });
  for (const [p, b] of files) { const u = new URL(p, dir); mkdirSync(new URL('./', u), { recursive: true }); writeFileSync(u, b); }
}
