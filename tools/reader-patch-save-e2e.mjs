// The patch save in the reader: a host that takes patches (`onSavePatch`) gets only the pages that changed and the media added, and no picture of the book
// is fetched for a save; the next save is again a patch against what the host answered; a refused patch keeps the unsaved mark; a page the host merged with
// someone else's work comes back and replaces the editor's copy; one save at a time; and a host without `onSavePatch` still gets the whole book.
// Real clicks and keys, in the showcase (its `?save=patch`, `patchfail`, `patchmerge` demo hosts record every patch in `window.__patches`).
//
//   node tools/reader-patch-save-e2e.mjs [url] [shots-dir]     (default http://localhost:5190/; the showcase must be running)
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const URL = (process.argv[2] ?? 'http://localhost:5190/').replace(/\/?$/, '/');
const SHOTS = process.argv[3];
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const b = await chromium.launch();
let failed = false;
const check = (name, ok, detail = '') => { if (!ok) failed = true; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : detail ? ` (${detail})` : ''}`); };
const glb = (() => { const j = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, scenes: [{ nodes: [] }], scene: 0 })); const pad = (4 - (j.length % 4)) % 4; const jj = Buffer.concat([j, Buffer.alloc(pad, 0x20)]); const h = Buffer.alloc(12); h.write('glTF', 0); h.writeUInt32LE(2, 4); h.writeUInt32LE(12 + 8 + jj.length, 8); const c = Buffer.alloc(8); c.writeUInt32LE(jj.length, 0); c.writeUInt32LE(0x4e4f534a, 4); return Buffer.concat([h, c, jj]); })();

async function open(mode) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  const p = await ctx.newPage();
  const errs = [];
  const pictures = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/CORS|ERR_FAILED/.test(m.text())) errs.push(m.text().slice(0, 160)); });
  p.on('request', (r) => { if (r.url().includes('/samples/long/assets/')) pictures.push(Date.now()); });
  await p.goto(`${URL}?save=${mode}`);
  await p.waitForSelector('.chalk-dock-page');
  await p.selectOption('.app-bar select', 'long');
  await p.waitForSelector('.chalk-dock-page');
  await p.click('.app-mode button[role=radio]:has-text("Author")');
  await p.waitForSelector('.chalk-surface.chalk-author', { timeout: 60000 });
  await p.waitForTimeout(1500);
  return { ctx, p, errs, pictures };
}
const dockSave = (p) => p.locator('.chalk-dock-btn:has(.chalk-dock-save)').first();
const toast = async (p) => (await p.locator('.chalk-toast').first().textContent({ timeout: 4000 }).catch(() => '')) ?? '';
const dirty = (p) => p.locator('.app-save').getAttribute('data-dirty');
const patches = (p) => p.evaluate(() => window.__patches ?? []);
const edit = async (p, text) => {
  const s = await p.locator('.chalk-surface').first().boundingBox();
  await p.keyboard.press('t'); await p.mouse.click(s.x + 220, s.y + 220);
  const f = p.locator('.chalk-surface textarea').first(); await f.waitFor({ timeout: 4000 }); await f.fill(text);
  await p.mouse.click(300, 700); await p.waitForTimeout(500);
};
const savedAgain = (p) => p.waitForFunction(() => document.querySelector('.app-save')?.getAttribute('data-dirty') === 'false' && document.querySelector('.app-save')?.getAttribute('data-saving') === 'false', null, { timeout: 30000 });

// 1. one object on one page: a few kilobytes, no pictures
{
  const { ctx, p, errs, pictures } = await open('patch');
  await edit(p, 'first edit');
  check('the book is unsaved after an edit', (await dirty(p)) === 'true');
  const since = pictures.length;
  const t0 = Date.now();
  await dockSave(p).click();
  await savedAgain(p);
  const ms = Date.now() - t0;
  const one = await patches(p);
  check('exactly one patch reached the host', one.length === 1, `${one.length}`);
  check('it holds one changed page, with its base', one[0]?.pages.length === 1 && one[0]?.base.length === 1, JSON.stringify(one[0]));
  check('it deleted nothing and carries no media', one[0]?.deleted.length === 0 && one[0]?.media.length === 0);
  check('it starts from the version the book was opened at', /^sha256:[0-9a-f]{64}$/.test(one[0]?.version ?? ''));
  console.log(`     patch size: ${one[0]?.bytes} bytes, ${one[0]?.order} page ids in its order, click to saved ${ms} ms`);
  check('the patch is kilobytes, not megabytes', (one[0]?.bytes ?? 1e9) < 60_000, `${one[0]?.bytes}`);
  check('no picture of the book was fetched for the save', pictures.length - since === 0, `${pictures.length - since} requests`);
  check('the book is marked saved', (await dirty(p)) === 'false');
  check('the status says it was saved', /saved/i.test(await toast(p)), await toast(p));
  // 2. the next save is again a patch, against the host's answer
  await edit(p, 'second edit');
  await dockSave(p).click();
  await savedAgain(p);
  const two = await patches(p);
  check('the next save is a second patch', two.length === 2 && two[1].pages.length === 1);
  check('its base is the host\'s answer, not the version the book was opened at', two[1]?.version !== two[0]?.version && /^sha256:/.test(two[1]?.version ?? ''));
  // 3. a save during a save is ignored (one at a time): the button, Ctrl+S, and the handle
  await edit(p, 'third edit');
  await dockSave(p).click();
  await p.keyboard.press('Control+s'); await p.keyboard.press('Control+s');
  await dockSave(p).click({ force: true }).catch(() => {});
  await savedAgain(p);
  await p.waitForTimeout(600);
  const three = await patches(p);
  check('Ctrl+S and clicks during a save start no second one', three.length === 3, `${three.length} patches`);
  // 4. media added in the session travels, once
  const s = await p.locator('.chalk-surface').first().boundingBox();
  await p.mouse.click(s.x + s.width * 0.5, s.y + s.height * 0.3, { button: 'right' });
  await p.locator('.chalk-insert-menu [role=menuitem]', { hasText: '3D' }).click(); await p.waitForTimeout(600);
  const up = p.locator('.chalk-gallery-upload input[type=file]');
  if (await up.count()) await up.setInputFiles({ name: 't.glb', mimeType: 'model/gltf-binary', buffer: glb });
  else { const [fc] = await Promise.all([p.waitForEvent('filechooser'), p.click('button:has-text("Choose file")')]); await fc.setFiles({ name: 't.glb', mimeType: 'model/gltf-binary', buffer: glb }); }
  await p.waitForTimeout(2500);
  const beforeMedia = pictures.length;
  await dockSave(p).click();
  await savedAgain(p);
  const four = await patches(p);
  check('the new 3D model\'s bytes travel with the patch', four.length === 4 && four[3].media.length === 1 && four[3].mediaBytes === glb.length, JSON.stringify({ n: four.length, m: four[3]?.media, mb: four[3]?.mediaBytes, want: glb.length }));
  check('and no picture of the book was fetched for that save either', pictures.length - beforeMedia === 0, `${pictures.length - beforeMedia}`);
  await edit(p, 'fifth edit');
  await dockSave(p).click();
  await savedAgain(p);
  const five = await patches(p);
  check('media already sent is not sent again', five.length === 5 && five[4].media.length === 0, JSON.stringify(five[4]?.media));
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/patch-saved.png` });
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

// 5. a host that refuses the patch: the unsaved mark stays, the busy state ends, the next try works
{
  const { ctx, p, errs } = await open('patchfail');
  await edit(p, 'will not be kept');
  await dockSave(p).click();
  await p.waitForFunction(() => document.querySelector('.app-save')?.getAttribute('data-saving') === 'false' && (window.__patches ?? []).length === 1, null, { timeout: 15000 });
  check('a refused patch keeps the unsaved mark', (await dirty(p)) === 'true');
  check('the failure is shown', /not saved/i.test(await toast(p)), await toast(p));
  check('the Save button works again', await dockSave(p).evaluate((el) => el.getAttribute('aria-busy') !== 'true' && !el.disabled));
  await dockSave(p).click();
  await p.waitForFunction(() => (window.__patches ?? []).length === 2, null, { timeout: 15000 });
  const both = await patches(p);
  check('the retry sends the same change, still against the original version', both[1].version === both[0].version && both[1].pages.length === 1);
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

// 6. a host that merged someone else's work into the page: said so, and the editor takes the merged page in
{
  const { ctx, p, errs } = await open('patchmerge');
  await edit(p, 'merged edit');
  await dockSave(p).click();
  await savedAgain(p);
  check('the merge is mentioned, briefly', /merged with someone else/i.test(await toast(p)), await toast(p));
  check('the book is marked saved (the merged page is the saved one)', (await dirty(p)) === 'false');
  await edit(p, 'after the merge');
  await dockSave(p).click();
  await savedAgain(p);
  const ps = await patches(p);
  const baseTitle = Object.values(ps[1]?.baseTitles ?? {})[0] ?? '';
  check('the next patch starts from the merged page, so it cannot undo the other work', /\(merged\)/.test(baseTitle), baseTitle);
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

// 7. a host without onSavePatch: the whole book, as before
{
  const { ctx, p, errs, pictures } = await open('slow');
  await edit(p, 'whole book');
  const since = pictures.length;
  await dockSave(p).click();
  await p.waitForFunction(() => (window.__saveCalls ?? 0) >= 1, null, { timeout: 60000 });
  await savedAgain(p);
  check('without onSavePatch the whole-book save still runs (onSave called once)', (await p.evaluate(() => window.__saveCalls)) === 1);
  check('and it still fetches the book\'s pictures (the old path, unchanged)', pictures.length - since > 5, `${pictures.length - since} requests`);
  check('no patch was made', (await patches(p)).length === 0);
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

await b.close();
console.log(failed ? '\nFAILED' : '\nall ok');
process.exit(failed ? 1 : 0);
