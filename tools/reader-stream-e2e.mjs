// Streamed books (spec 1.4) in a real browser: what is fetched, and when. Watches the network while a student
// opens a 60-page book, jumps to page 50, searches, and an author starts editing.
//
//   node tools/reader-stream-e2e.mjs [url] [shots-dir]   (default http://localhost:5190/; the showcase must be running)
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const URL = process.argv[2] ?? 'http://localhost:5190/';
const SHOTS = process.argv[3];
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const b = await chromium.launch();
let failed = false;
const check = (name, ok, detail = '') => { if (!ok) failed = true; console.log(ok ? 'ok  ' : 'FAIL', name, detail); };

const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
const got = [], every = new Set();
p.on('request', (r) => { const m = /\/samples\/long\/(.*)$/.exec(r.url()); if (m) { got.push(m[1]); if (m[1].startsWith('pages/')) every.add(m[1]); } });
const pagesFetched = () => [...new Set(got.filter((f) => f.startsWith('pages/')).map((f) => Number(/pages\/(\d+)-/.exec(f)[1])))].sort((a, c) => a - c);
const go = async (n) => { await p.click('.chalk-dock-page'); await p.fill('.chalk-dock-page input', String(n)); await p.press('.chalk-dock-page input', 'Enter'); };

await p.goto(URL); await p.waitForSelector('.chalk-dock-page');
await p.selectOption('.app-field select', 'long');
await p.waitForFunction(() => document.querySelectorAll('.chalk-page').length > 0 && !document.querySelector('.chalk-state'));
await p.waitForTimeout(1500);
check('opens from book.json first', got[0] === 'book.json', got[0]);
check('the whole book is laid out: 60 pages, numbered', (await p.textContent('.chalk-dock-page')).includes('৬০'));
const first = pagesFetched();
check('only the pages near the start are fetched', first.length > 0 && first.length <= 6 && first.every((n) => n <= 6), JSON.stringify(first));
check('the first page is drawn', await p.evaluate(() => !document.querySelector('.chalk-page .chalk-page-loading')));
if (SHOTS) await p.screenshot({ path: `${SHOTS}/stream-open.png` });

// a jump to page 50: its neighbours, nothing in between
got.length = 0;
await go(50);
await p.waitForTimeout(1500);
const jump = pagesFetched();
check('a jump to page 50 fetches pages around 50 (±5), current first', jump.length > 0 && jump.every((n) => n >= 45 && n <= 55) && got.find((f) => f.startsWith('pages/'))?.startsWith('pages/50-'), JSON.stringify(jump));
check('nothing between was fetched', !jump.some((n) => n > 6 && n < 45));
if (SHOTS) await p.screenshot({ path: `${SHOTS}/stream-jump.png` });

// thumbnails: from the index and the small pictures, without fetching pages
got.length = 0;
await p.click('.chalk-dock button[aria-label="পৃষ্ঠাগুলো"]').catch(() => {});
await p.waitForTimeout(800);
check('the page strip shows without fetching pages', pagesFetched().length === 0 && (await p.$$('.chalk-thumb, .chalk-thumbs button')).length > 0, JSON.stringify(pagesFetched()));
if (SHOTS) await p.screenshot({ path: `${SHOTS}/stream-thumbs.png` });
await p.keyboard.press('Escape');

// search: the text file once, hits on pages never fetched
got.length = 0;
await p.keyboard.press('Control+f');
await p.fill('.chalk-search input', 'সুরশলাকা');
await p.waitForTimeout(800);
const hitPages = await p.evaluate(() => [...document.querySelectorAll('.chalk-results li')].length);
check('search loads the text file, not pages', got.some((f) => f.startsWith('text-')) && pagesFetched().length === 0, JSON.stringify(got));
check('and finds the word on pages never fetched', hitPages >= 12, `${hitPages} hits`);
if (SHOTS) await p.screenshot({ path: `${SHOTS}/stream-search.png` });
await p.keyboard.press('Escape');

// author mode: the whole book first
got.length = 0;
await p.click('.app-mode button:has-text("Author")');
await p.waitForFunction(() => document.querySelector('.chalk-reader')?.dataset.mode === 'author' && document.querySelector('.chalk-rail'), null, { timeout: 30000 }).catch(() => {});
await p.waitForTimeout(500);
check('author mode loads the rest of the book, then begins', !!(await p.$('.chalk-rail')) && every.size === 60, `${every.size} of 60 pages loaded in all`);
// author mode from a slow host: every streamed file takes a while to arrive. The delay is added on this side (route.fetch, then fulfill),
// so the browser's own limit of 6 connections per host does not apply, like a host on HTTP/2. Switching to Author must show how far the
// loading is (a counter that rises) and then begin; the time it takes is printed (compare runs of different code with the same numbers).
const mulberry = (seed) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const authorLoad = async (label, delay) => {
  const q = await b.newPage({ viewport: { width: 1280, height: 800 } });
  const bad = []; q.on('pageerror', (e) => bad.push(e.message));
  await q.route('**/samples/long/**', async (route) => { const res = await route.fetch(); await new Promise((r) => setTimeout(r, delay())); await route.fulfill({ response: res }); });
  await q.goto(URL); await q.waitForSelector('.chalk-dock-page');
  await q.selectOption('.app-field select', 'long');
  await q.waitForFunction(() => document.querySelectorAll('.chalk-page').length > 0 && !document.querySelector('.chalk-state'), null, { timeout: 60000 });
  const t0 = Date.now();
  await q.click('.app-mode button:has-text("Author")');
  const seen = [];
  let ready = null;
  while (Date.now() - t0 < 60000) {
    const text = await q.locator('.chalk-toast').first().innerText({ timeout: 100 }).catch(() => '');
    const m = /(\d+)\D+(\d+)\s*$/.exec(text.replace(/[০-৯]/g, (d) => '০১২৩৪৫৬৭৮৯'.indexOf(d)));
    if (m && /Loading the book/.test(text)) seen.push([Number(m[1]), Number(m[2])]);
    if (await q.$('.chalk-rail')) { ready = Date.now() - t0; break; }
    await q.waitForTimeout(40);
  }
  const counts = seen.map(([d]) => d), distinct = [...new Set(counts)];
  await q.waitForTimeout(300);
  const gone = !(await q.locator('.chalk-toast', { hasText: 'Loading the book' }).count());
  console.log(`time  author view ready: ${ready} ms (${label}); counter values seen: ${distinct.length}${distinct.length ? ` (${distinct[0]} .. ${distinct.at(-1)} of ${seen.at(-1)?.[1]})` : ''}`);
  check(`the author view begins (${label})`, ready !== null);
  check(`it shows a counter that rises, up to the whole book (${label})`, distinct.length >= 3 && counts.every((n, i) => i === 0 || n >= counts[i - 1]) && (seen.at(-1)?.[1] ?? 0) >= 60, JSON.stringify(distinct.slice(0, 6)));   // 60 pages and the snip page: the total is 61
  check(`the counter is gone once the book is whole (${label})`, gone);
  check(`no errors (${label})`, bad.length === 0, bad.join(' | '));
  await q.close();
  return ready;
};
await authorLoad('every request takes 200 ms', () => 200);
const jitter = mulberry(7);
await authorLoad('requests take 100 to 400 ms', () => 100 + Math.floor(jitter() * 300));

check('no errors', errs.length === 0, errs.join(' | '));
await b.close();
process.exit(failed ? 1 : 0);
