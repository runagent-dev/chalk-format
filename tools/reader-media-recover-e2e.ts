// Media that move while a library book is open (registry-api §3.1: a key adopted at two paths, the copy the reader named deleted): the
// reader recovers. Publishes a small book into a disk library whose media are adopted in place, each at two paths (two books' copies), and
// opens it in the built showcase with `?library=…&book=…`:
//   - the picture on page 1 is drawn from the copy the library names first;
//   - the video's card has resolved its URL; that copy is deleted; a tap plays it: the <video> fails on the old URL, the reader asks the
//     library again (past its cached index shard) and swaps the src once, to the other copy, which plays;
//   - the audio's copies are both deleted: a tap tries the old URL, asks once more, and stops (no loop).
//
//   npx tsx tools/reader-media-recover-e2e.ts <library-url> <author-token> <library-disk-dir> [--dist apps/reader/dist] [--shots <dir>]
//
// The library must be a disk library (STORAGE=disk) that adopts from `books/` (ADOPT_PREFIXES=books/) and reads publicly. The showcase is
// built first (`pnpm --filter @chalk-format/reader-app build`) and served to the browser from its files (no port is opened for it). Use a
// test library: this writes into it, and deletes files it wrote in its folder.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { publishStreamed } from '../packages/container/src/index.ts';
import { assetKeyAndSha256, type Lesson } from '../packages/model/src/index.ts';
import { createRegistryClient } from '../packages/store/src/index.ts';

const args = process.argv.slice(2);
const opt = (n: string) => { const i = args.indexOf(n); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
const DIST = path.resolve(opt('--dist') ?? path.join(import.meta.dirname, '../apps/reader/dist'));
const SHOTS = opt('--shots');
const [LIBRARY, TOKEN, DISK_DIR] = args;
if (!LIBRARY || !TOKEN || !DISK_DIR) { console.error('usage: reader-media-recover-e2e.ts <library-url> <author-token> <library-disk-dir> [--dist dir] [--shots dir]'); process.exit(2); }
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

let failed = false;
const check = (name: string, ok: boolean, detail = '') => { if (!ok) failed = true; console.log(ok ? 'ok  ' : 'FAIL', name, detail); };

// ---- the book: one page with a picture, a video and an audio. Each run its own bytes (the same bytes would be the same items, with
// the copies and tags of an earlier run): the slug is appended to each file, which every decoder ignores ----
const slug = `e2e-recover-${Date.now().toString(36)}`;
const enc = new TextEncoder();
const media = async (file: string, type: string, name: string) => {
  const bytes = new Uint8Array([...readFileSync(path.join(import.meta.dirname, '../apps/reader/showcase/media', file)), ...enc.encode(slug)]);
  const { key, sha256 } = await assetKeyAndSha256(bytes);
  // the copy adopted last is the one the library names first (newest verified first): `copies[1]`
  return { bytes, key, sha256, type, copies: [`books/${slug}-b/${name}`, `books/${slug}-a/${name}`] };
};
const pic = await media('pendulum-poster.png', 'image/png', 'pic.png');
const video = await media('pendulum.webm', 'video/webm', 'clip.webm');
const audio = await media('tuning-fork.mp3', 'audio/mpeg', 'tone.mp3');
const lesson: Lesson = {
  id: slug, title: `Media that move (${slug})`, locale: 'en', createdAt: '', updatedAt: '', snipPages: [],
  pages: [{ id: 'p0', title: 'Page 1', width: 1000, height: 1300, background: { type: 'blank' }, textLayer: [{ text: slug, x: 60, y: 50, width: 400, fontSize: 24 }], objects: [
    { id: 'img', type: 'image', x: 60, y: 80, width: 400, height: 300, assetId: pic.key },
    { id: 'vid', type: 'embed', embed: 'video', x: 500, y: 80, width: 440, height: 300, assetId: video.key, presentation: { show: 'card', open: 'inline' } },
    { id: 'aud', type: 'embed', embed: 'audio', x: 60, y: 500, width: 600, height: 80, assetId: audio.key },
  ] }],
} as Lesson;
const { index, files } = await publishStreamed(lesson, new Map([pic, video, audio].map((m) => [m.key, { type: m.type, bytes: m.bytes }])));

const lib = createRegistryClient(LIBRARY, { token: TOKEN });
const stores = (await lib.stores()).items.filter((d) => d.auth !== 'bearer');
const tags = (kind: string) => ['origin:chalkbook', `book:${slug}`, 'book-revision:1', `kind:${kind}`, 'state:current'];
const add = async (bytes: Uint8Array, type: string, t: string[]) => (await lib.add(bytes, { type, tags: t })).key;
// the media: adopted in place at two books' paths, never uploaded (so only the index knows where they are)
for (const m of [pic, video, audio]) {
  for (const p of m.copies) {
    mkdirSync(path.dirname(path.join(DISK_DIR, p)), { recursive: true });
    writeFileSync(path.join(DISK_DIR, p), m.bytes);
    await lib.adopt({ key: m.key, sha256: m.sha256, type: m.type, size: m.bytes.byteLength, path: p });
    await new Promise((r) => setTimeout(r, 30));
  }
}
const pages = await Promise.all(index.pages.map(async ({ file, ...p }) => ({ ...p, key: await add(files.get(file)!, 'application/vnd.chalk.page+json', tags('page')) })));
const textBytes = files.get(index.text!.file)!;
const textKey = await add(textBytes, 'application/vnd.chalk.text+json', tags('text'));
const { text: _text, ...rest } = index;
const book = { ...rest, pages, text: { key: textKey, bytes: textBytes.byteLength }, assets: index.assets.map(({ path: _p, ...a }) => a), assetSources: stores };
await add(enc.encode(JSON.stringify(book)), 'application/vnd.chalk.book+json', tags('book'));
console.log(`published ${slug}`);

// ---- the browser: the built showcase served from its files, the library for real (the token given, so no sign-in form) ----
// a loopback address with no server behind it: every request to it is answered from the files
const ORIGIN = 'http://127.0.0.2';
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.mjs': 'text/javascript' };
// the page's origin is not the library's: local network access checks are off (a test library on this machine)
const b = await chromium.launch({ args: ['--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await b.newContext({ viewport: { width: 1100, height: 900 } });
await ctx.route(`${ORIGIN}/**`, async (route) => {
  const u = new URL(route.request().url());
  const file = path.join(DIST, u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname));
  try { await route.fulfill({ body: readFileSync(file), contentType: TYPES[path.extname(file)] ?? 'application/octet-stream' }); }
  catch { await route.fulfill({ body: readFileSync(path.join(DIST, 'index.html')), contentType: 'text/html' }); }
});
const p = await ctx.newPage();
const errors: string[] = []; p.on('pageerror', (e) => errors.push(e.message));
p.on('console', (m) => { if (m.type() === 'error' && process.env.E2E_DEBUG) console.log('console:', m.text()); });
const asked: { url: string; status: number }[] = [];
p.on('response', (r) => { if (r.url().includes(`/books/${slug}`) || r.url().includes('/index/')) asked.push({ url: r.url(), status: r.status() }); });
const askedFor = (copy: string) => asked.filter((a) => a.url.endsWith(copy));

await p.goto(`${ORIGIN}/?${new URLSearchParams({ library: LIBRARY, book: slug, token: TOKEN })}`);
await p.waitForFunction(() => document.querySelectorAll('.chalk-page image, .chalk-page img').length > 0, null, { timeout: 30000 }).catch(() => {});
await p.waitForTimeout(1500);
const drawn = await p.evaluate(() => [...document.querySelectorAll<SVGImageElement>('.chalk-page image')].map((i) => i.href.baseVal));
check('the picture is drawn from the copy the library names first', drawn.some((u) => u.endsWith(pic.copies[1]!)) && askedFor(pic.copies[1]!).some((a) => a.status === 200), JSON.stringify(drawn));
if (SHOTS) await p.screenshot({ path: `${SHOTS}/recover-before.png` });

// ---- the video: its card has its URL; the book that owned that copy prunes it; a tap plays it from the other copy ----
check('the video was not fetched before it is played', askedFor(video.copies[1]!).length === 0 && askedFor(video.copies[0]!).length === 0);
rmSync(path.join(DISK_DIR, video.copies[1]!));
asked.length = 0;
await p.click('.chalk-card');
await p.waitForFunction((other) => { const v = document.querySelector<HTMLVideoElement>('.chalk-video video'); return !!v && v.src.endsWith(other) && v.readyState >= 1; }, video.copies[0]!, { timeout: 15000 }).catch(() => {});
await p.waitForTimeout(1000);
const v = await p.evaluate(() => { const e = document.querySelector<HTMLVideoElement>('.chalk-video video'); return e ? { src: e.src, ready: e.readyState, error: e.error?.code ?? null, playing: !e.paused } : null; });
check('the video first tried the URL it had, which is gone', askedFor(video.copies[1]!).some((a) => a.status === 404), JSON.stringify(askedFor(video.copies[1]!)));
check('the reader asked the library\'s index again', asked.some((a) => a.url.includes('/index/') && a.status === 200));
check('the video plays from the other copy (the tap still counts)', !!v && v.src.endsWith(video.copies[0]!) && v.ready >= 1 && v.error === null && v.playing && askedFor(video.copies[0]!).some((a) => a.status < 300), JSON.stringify(v));
check('the old URL was not asked again and again', askedFor(video.copies[1]!).length <= 2, String(askedFor(video.copies[1]!).length));
if (SHOTS) await p.screenshot({ path: `${SHOTS}/recover-video.png` });

// ---- the audio: every copy gone; a tap tries once more and stops ----
for (const c of audio.copies) rmSync(path.join(DISK_DIR, c));
asked.length = 0;
await p.click('.chalk-audio-play');
await p.waitForTimeout(4000);
const tries = asked.filter((a) => a.url.endsWith('/tone.mp3'));
check('with every copy gone, the audio is tried, renewed once, and left (no loop)', tries.length >= 1 && tries.length <= 3 && tries.every((a) => a.status === 404), JSON.stringify(tries));
const later = asked.length;
await p.waitForTimeout(2000);
check('…and nothing more is asked', asked.length === later, `${asked.length - later} more requests`);
check('no errors in the page', errors.length === 0, errors.join(' | '));

await b.close();
console.log(failed ? '\nSOME CHECKS FAILED' : '\nall checks passed');
process.exit(failed ? 1 : 0);
