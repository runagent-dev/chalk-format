// Author mode's Save: while there are unsaved changes the dock's Save is a filled, labelled button (not a dot you have to notice), Ctrl or
// Cmd+S saves, and a host can both hear that the book is unsaved (onDirtyChange) and save it itself (handle.save). Real keys and clicks.
//
//   node tools/reader-save-e2e.mjs [url]     (default http://localhost:5190/; the showcase must be running)
import { chromium } from 'playwright-core';

const URL = process.argv[2] ?? 'http://localhost:5190/';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => { if (m.type() === 'error' && !/CORS|ERR_FAILED/.test(m.text())) errs.push(m.text().slice(0, 160)); });
await p.goto(URL);
await p.waitForSelector('.chalk-dock-page');
const r = {};
const dockSave = () => p.locator('.chalk-dock-btn:has(.chalk-dock-save)').first();
const state = async () => {
  const btn = dockSave(), bb = await btn.boundingBox();
  return { primary: (await btn.getAttribute('class'))?.includes('is-primary') ?? false, text: ((await btn.innerText().catch(() => '')) || '').trim(), pill: !!bb && bb.width > bb.height * 1.3, host: (await p.locator('.app-save').innerText().catch(() => '(none)')).trim(), hostEnabled: await p.locator('.app-save').isEnabled().catch(() => false) };
};
const download = (fn) => Promise.all([p.waitForEvent('download', { timeout: 5000 }).then((d) => d.suggestedFilename(), () => null), fn()]).then(([name]) => name);
const edit = async (text) => {   // a text object on the page: a real edit
  const s = await p.locator('.chalk-surface').first().boundingBox();   // the page (while the text tool is on, the surface is the drawing one)
  await p.keyboard.press('t'); await p.mouse.click(s.x + 220, s.y + 220);
  const f = p.locator('.chalk-surface textarea').first(); await f.waitFor({ timeout: 4000 }); await f.fill(text);
  return f;
};

// 0. read mode: no Save button from the host, Ctrl+S is the browser's
r.readMode = { hostSave: await p.locator('.app-save').count(), downloadOnCtrlS: await download(() => p.keyboard.press('Control+s')) };
await p.click('.app-mode button[role=radio]:has-text("Author")');
await p.waitForSelector('.chalk-surface.chalk-author', { timeout: 15000 }); await p.waitForTimeout(1200);

// 1. nothing changed yet: quiet
r.clean = await state();
r.cleanCtrlS = await download(() => p.keyboard.press('Control+s'));   // saves anyway? it saves the book as it is: a download is fine, but nothing is unsaved
await p.waitForTimeout(500);

// 2. an edit: the dock's Save becomes filled and labelled, and the host is told
const f1 = await edit('first');
await p.mouse.click(300, 700); await p.waitForTimeout(600);
r.dirty = await state();
await p.screenshot({ path: 'out/save-dirty.png' });

// 3. Ctrl+S saves (a download here: the showcase has no onSave) and everything goes quiet again
r.ctrlS = await download(() => p.keyboard.press('Control+s')); await p.waitForTimeout(800);
r.afterCtrlS = await state();

// 4. Ctrl+S from inside a text field being typed in
const f2 = await edit('second'); await p.waitForTimeout(300);
r.fieldOpen = (await f2.count()) === 1;
r.ctrlSInField = await download(() => p.keyboard.press('Control+s')); await p.waitForTimeout(1200);
r.afterCtrlSInField = await state();
r.typedTextKept = (await p.getByText('second', { exact: true }).count()) > 0;   // it was committed, so it is on the page (and in what was saved)

// 5. the host's own button saves through handle.save()
await edit('third'); await p.mouse.click(300, 700); await p.waitForTimeout(600);
r.hostBefore = await state();
r.hostSave = await download(() => p.click('.app-save')); await p.waitForTimeout(800);
r.hostAfter = await state();

const q = (x) => x.primary && x.text === 'Save' && x.pill && x.host === 'Save changes' && x.hostEnabled;
const quiet = (x) => !x.primary && x.host === 'Saved' && !x.hostEnabled;
const ok = r.readMode.hostSave === 0 && r.readMode.downloadOnCtrlS === null
  && quiet(r.clean) && q(r.dirty) && /\.chalk$/.test(r.ctrlS ?? '') && quiet(r.afterCtrlS)
  && r.fieldOpen && /\.chalk$/.test(r.ctrlSInField ?? '') && quiet(r.afterCtrlSInField) && r.typedTextKept
  && q(r.hostBefore) && /\.chalk$/.test(r.hostSave ?? '') && quiet(r.hostAfter) && !errs.length;
console.log(ok ? 'OK  ' : 'FAIL', JSON.stringify(r), errs.length ? 'errors: ' + errs.join(' | ') : '');
await b.close();
process.exit(ok ? 0 : 1);
