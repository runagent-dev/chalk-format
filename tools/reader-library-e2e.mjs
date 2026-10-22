// Libraries in a real browser (author tools in English): add media through the gallery, upload into "This device",
// find it again by search and after a reload, save a self-contained book that carries it, and open a book whose
// media no connected library has.
//
//   npx tsx tools/reader-library-e2e.mjs [url] [shots-dir]   (default http://localhost:5190/; the showcase must be running)
import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { unpackLesson } from '../packages/container/src/index.ts';

const URL = process.argv[2] ?? 'http://localhost:5190/';
const SHOTS = process.argv[3];
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = async (p, n) => { if (SHOTS) await p.screenshot({ path: `${SHOTS}/${n}.png` }); };
const media = (f) => new globalThis.URL(`../apps/reader/showcase/media/${f}`, import.meta.url).pathname;
const conformance = (f) => new globalThis.URL(`../conformance/${f}`, import.meta.url).pathname;
let failed = false;
const check = (name, ok, detail = '') => { if (!ok) failed = true; console.log(ok ? 'ok  ' : 'FAIL', name, detail); };

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
const p = await ctx.newPage();
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
const head = () => p.textContent('.chalk-sidebar-head h2');
const add = async (kind) => { await p.click('.chalk-rail .is-add'); await p.click(`.chalk-rail-item:has-text("${kind}")`); await p.waitForSelector('.chalk-gallery'); };
const tiles = () => p.$$eval('.chalk-gallery-grid .chalk-tile', (els) => els.map((e) => e.querySelector('.chalk-tile-name')?.textContent));

await p.goto(URL); await p.waitForSelector('.chalk-dock-page');
await p.click('.app-mode button:has-text("Author")');
await p.waitForSelector('.chalk-rail');

// an empty library: the gallery says so, and offers an upload
await add('Video');
check('+ › Video opens the gallery', (await head()).includes('Video') && !!(await p.$('.chalk-gallery')));
await p.waitForTimeout(400);
check('an empty library says so', (await p.textContent('.chalk-gallery')).includes('Nothing here yet'));
await shot(p, 'lib-empty');

// upload a video into This device: it is placed, with a poster from its frames
const before = await p.$$eval('[data-chalk-id^="video"]', (e) => e.length);
await p.setInputFiles('.chalk-gallery-upload input[type="file"]', media('pendulum.webm'));
await p.waitForFunction((n) => document.querySelectorAll('[data-chalk-id^="video"]').length > n, before, { timeout: 15000 }).catch(() => {});
check('an uploaded video is placed and selected', (await head()).includes('Video') && (await p.$$eval('[data-chalk-id^="video"]', (e) => e.length)) > before);
await p.waitForTimeout(500);
check('it shows its poster (from the library)', await p.evaluate(() => !![...document.querySelectorAll('[data-chalk-id^="video"]')].pop()?.querySelector('img')));

// the library now has it: the gallery lists it, search finds it, a pick places another
await p.keyboard.press('Escape');
await add('Video');
await p.waitForTimeout(500);
check('the gallery lists what was uploaded', (await tiles()).some((n) => n?.includes('pendulum')), JSON.stringify(await tiles()));
await p.fill('.chalk-gallery-search input', 'PENDULUM');
await p.waitForTimeout(500);
check('search finds it (any case)', (await tiles()).length === 1);
await p.fill('.chalk-gallery-search input', 'no such thing');
await p.waitForTimeout(500);
check('and says when nothing matches', (await p.textContent('.chalk-gallery')).includes('Nothing matches'));
await p.fill('.chalk-gallery-search input', '');
await p.waitForTimeout(500);
await shot(p, 'lib-gallery');
const n2 = await p.$$eval('[data-chalk-id^="video"]', (e) => e.length);
await p.click('.chalk-gallery-grid .chalk-tile');
await p.waitForTimeout(400);
check('a pick places it (no new upload)', (await p.$$eval('[data-chalk-id^="video"]', (e) => e.length)) === n2 + 1);

// the libraries panel: This device, connected
await p.keyboard.press('Escape'); await p.keyboard.press('Escape');
await p.waitForSelector('.chalk-libs');
check('the page view lists the libraries', (await p.textContent('.chalk-libs')).includes('This device') && !!(await p.$('.chalk-libs-dot.is-ok')));
await shot(p, 'lib-panel');

// a self-contained save carries media that lives in a library
const [dl] = await Promise.all([p.waitForEvent('download'), p.click('.chalk-dock button[aria-label^="Save the book"]')]);
const r = await unpackLesson(new Uint8Array(readFileSync(await dl.path())));
const vids = r.lesson.pages.flatMap((pg) => pg.objects).filter((o) => o.type === 'embed' && o.embed === 'video' && o.id.startsWith('video'));
check('saved: the library videos and their bytes', vids.length >= 2 && vids.every((v) => r.assets.has(v.assetId) && r.assets.has(v.poster)), `${vids.length} videos`);

// after a reload the library still has it (IndexedDB), and the gallery finds it
await p.reload(); await p.waitForSelector('.chalk-dock-page');
await p.click('.app-mode button:has-text("Author")'); await p.waitForSelector('.chalk-rail');
await add('Video'); await p.waitForTimeout(600);
check('after a reload the library still has it', (await tiles()).some((n) => n?.includes('pendulum')));
await p.keyboard.press('Escape');

// a book whose media no connected library has: the card says so, and the reader counts what is missing
await p.click('.app-mode button:has-text("Read")');
await p.setInputFiles('.app-bar input[type="file"]', conformance('valid/thin-sources.chalk'));
await p.waitForSelector('.chalk-card.is-missing', { timeout: 10000 }).catch(() => {});
check('media no library has is marked "Not in your libraries"', (await p.textContent('.chalk-card.is-missing').catch(() => '')).includes('আপনার লাইব্রেরিতে নেই') || (await p.textContent('.chalk-card.is-missing').catch(() => '')).includes('Not in your libraries'));
check('and the reader says how many are missing', !!(await p.$('.chalk-missing-chip')));
await p.click('.chalk-missing-chip'); await p.waitForTimeout(200);
check('with a list of what and where', (await p.$$('.chalk-missing-list li')).length >= 1);
await shot(p, 'lib-missing');
check('no errors', errs.length === 0, errs.join(' | '));
await b.close();
process.exit(failed ? 1 : 0);
