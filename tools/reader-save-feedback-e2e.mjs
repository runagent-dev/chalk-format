// A save gives feedback from the click on (spec-independent reader behaviour): the dock's Save button is busy and the status line says what the
// save is doing (collecting the pictures of a big book first, then packing, then the host's upload), a second click, Ctrl/Cmd+S or handle.save()
// during it does not start another save, a failed save ends the busy state and keeps the unsaved mark, and motion honours prefers-reduced-motion.
// Real clicks and keys, in the showcase (its `?save=slow` / `?save=fail` host save, and the 60-page streamed book with its pictures slowed down).
//
//   node tools/reader-save-feedback-e2e.mjs [url] [shots-dir]     (default http://localhost:5190/; the showcase must be running)
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const URL = (process.argv[2] ?? 'http://localhost:5190/').replace(/\/?$/, '/');
const SHOTS = process.argv[3];
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await chromium.launch();
let failed = false;
const check = (name, ok, detail = '') => { if (!ok) failed = true; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : detail ? ` (${detail})` : ''}`); };

async function open(mode, { reduced = false } = {}) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true, ...(reduced ? { reducedMotion: 'reduce' } : {}) });
  // the pictures of the streamed book come slowly, so what a save shows while it fetches them can be looked at
  await ctx.route('**/samples/long/assets/**', async (route) => { await sleep(400); await route.continue(); });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/CORS|ERR_FAILED/.test(m.text())) errs.push(m.text().slice(0, 160)); });
  await p.goto(`${URL}?save=${mode}`);
  await p.waitForSelector('.chalk-dock-page');
  await p.selectOption('.app-bar select', 'long');
  await p.waitForSelector('.chalk-dock-page');
  await p.click('.app-mode button[role=radio]:has-text("Author")');
  await p.waitForSelector('.chalk-surface.chalk-author', { timeout: 60000 });
  await p.waitForTimeout(800);
  return { ctx, p, errs };
}
const dockSave = (p) => p.locator('.chalk-dock-btn:has(.chalk-dock-save)').first();
const toast = (p) => p.locator('.chalk-toast').first();
const edit = async (p, text) => {
  const s = await p.locator('.chalk-surface').first().boundingBox();
  await p.keyboard.press('t'); await p.mouse.click(s.x + 220, s.y + 220);
  const f = p.locator('.chalk-surface textarea').first(); await f.waitFor({ timeout: 4000 }); await f.fill(text);
  await p.mouse.click(300, 700); await p.waitForTimeout(500);
};
const busy = (p) => dockSave(p).evaluate((el) => ({ busy: el.getAttribute('aria-busy') === 'true', cls: el.className, name: el.getAttribute('aria-label') }));
const calls = (p) => p.evaluate(() => window.__saveCalls ?? 0);

// 1. a slow host save of a big book
{
  const { ctx, p, errs } = await open('slow');
  await edit(p, 'first');
  const before = await busy(p);
  check('before the click the Save button is not busy', !before.busy && !/is-busy/.test(before.cls));
  const t0 = Date.now();
  await dockSave(p).click();
  // within 300 ms: busy, named "Saving…", the status line already says so, and the host has been told
  await p.waitForFunction(() => document.querySelector('.chalk-dock-btn:has(.chalk-dock-save)')?.getAttribute('aria-busy') === 'true', null, { timeout: 300 }).catch(() => {});
  const early = await busy(p);
  const early1 = Date.now() - t0;
  check('within 300 ms of the click the Save button is busy (aria-busy, is-busy)', early.busy && /is-busy/.test(early.cls), `${early1} ms, ${JSON.stringify(early)}`);
  check('its accessible name is "Saving…"', early.name === 'Saving…', early.name);
  check('the status line says "Saving…" at once', /Saving…/.test((await toast(p).textContent().catch(() => '')) ?? ''));
  check('the host heard onSavingChange(true) (its own button is busy too)', (await p.locator('.app-save').getAttribute('data-saving')) === 'true');
  // the picture counter: "collecting pictures, N of M" and the host's progress
  await p.waitForFunction(() => /collecting pictures, \d+ of \d+/.test(document.querySelector('.chalk-toast')?.textContent ?? ''), null, { timeout: 4000 });
  const note = await toast(p).textContent();
  check('the status line counts the pictures', /collecting pictures, \d+ of \d+/.test(note), note);
  check('the host hears the progress too', /^collecting \d+\/\d+$/.test((await p.locator('.app-save').getAttribute('data-phase')) ?? ''), await p.locator('.app-save').getAttribute('data-phase'));
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/save-busy.png` });
  // a second click, a double click, Ctrl+S and the host's own button during the save: no second save
  const bb = await dockSave(p).boundingBox();
  await p.mouse.dblclick(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await p.keyboard.press('Control+s');
  await p.waitForFunction(() => /Already saving/.test(document.querySelector('.chalk-toast')?.textContent ?? ''), null, { timeout: 2000 }).then(() => check('Ctrl/⌘+S during the save says "Already saving"', true), () => check('Ctrl/⌘+S during the save says "Already saving"', false));
  check('the host\'s own Save button is disabled while saving', await p.locator('.app-save').isDisabled());
  // the phases go on: packing, uploading (the host's save takes 1.5 s), then saved
  const seen = new Set();
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    const t = (await toast(p).textContent().catch(() => '')) ?? '';
    if (/Book saved/.test(t)) { seen.add('saved'); break; }
    await sleep(40);
  }
  check('the status line ends on "Book saved"', seen.has('saved'), [...seen].join());
  const phases = await p.evaluate(() => window.__savePhases);
  check('the host heard collecting, then packing, then handing-over (each once, in order)', JSON.stringify(phases) === '["collecting","packing","handing-over"]', JSON.stringify(phases));
  await p.waitForFunction(() => document.querySelector('.app-save')?.textContent === 'Saved', null, { timeout: 10000 });
  const after = await busy(p);
  check('after it the Save button is back to normal and the book is saved', !after.busy && !/is-busy/.test(after.cls) && (await p.locator('.app-save').getAttribute('data-saving')) === 'false');
  check('exactly one save reached the host (double click, Ctrl+S did not start more)', (await calls(p)) === 1, String(await calls(p)));
  // after it ended, a new edit and a new save work again
  await edit(p, 'second'); await dockSave(p).click();
  const seen2 = new Set();
  for (const end = Date.now() + 30000; Date.now() < end; await sleep(40)) {
    const t = (await toast(p).textContent().catch(() => '')) ?? '';
    if (/collecting pictures/.test(t)) seen2.add('collecting'); if (/uploading/.test(t)) seen2.add('uploading'); if (/Book saved/.test(t)) { seen2.add('saved'); break; }
  }
  check('the status line shows the pictures, then "uploading", then "Book saved" (a save with no other messages)', seen2.has('collecting') && seen2.has('uploading') && seen2.has('saved'), [...seen2].join());
  await p.waitForFunction(() => document.querySelector('.app-save')?.textContent === 'Saved', null, { timeout: 30000 });
  check('a later save starts a new one', (await calls(p)) === 2, String(await calls(p)));
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

// 2. the host's save fails: the busy state ends, the unsaved mark stays, the toast says why
{
  const { ctx, p, errs } = await open('fail');
  await edit(p, 'one');
  await dockSave(p).click();
  await p.waitForFunction(() => /not saved/.test(document.querySelector('.chalk-toast')?.textContent ?? ''), null, { timeout: 30000 });
  const msg = await toast(p).textContent();
  check('a failed save says so, with the host\'s reason', /The book was not saved: The host refused the save/.test(msg), msg);
  const after = await busy(p);
  check('the busy state ended', !after.busy && !/is-busy/.test(after.cls));
  check('the unsaved mark stays (host button enabled and "Save changes")', !(await p.locator('.app-save').isDisabled()) && (await p.locator('.app-save').textContent()) === 'Save changes');
  check('the dock Save is still the filled, labelled button', /is-primary/.test(after.cls));
  await dockSave(p).click();
  await p.waitForFunction(() => window.__saveCalls === 2, null, { timeout: 30000 });
  check('trying again starts a fresh save', true);
  await p.waitForFunction(() => /not saved/.test(document.querySelector('.chalk-toast')?.textContent ?? ''), null, { timeout: 30000 });
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

// 3. motion: the icon pulses, and does not when the reader is asked for no motion
for (const reduced of [false, true]) {
  const { ctx, p } = await open('slow', { reduced });
  await edit(p, 'm');
  await dockSave(p).click();
  await p.waitForFunction(() => document.querySelector('.chalk-dock-save.is-busy'), null, { timeout: 2000 });
  const anim = await p.locator('.chalk-dock-save.is-busy svg').evaluate((el) => getComputedStyle(el).animationName);
  check(reduced ? 'with reduced motion the icon does not animate' : 'normally the icon pulses', reduced ? anim === 'none' : /chalk-save-pulse/.test(anim), anim);
  await p.waitForFunction(() => document.querySelector('.app-save')?.textContent === 'Saved', null, { timeout: 30000 });
  await ctx.close();
}

await b.close();
console.log(failed ? 'FAILED' : 'ALL OK');
process.exit(failed ? 1 : 0);
