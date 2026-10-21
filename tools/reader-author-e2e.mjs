// Author mode with real input (in the reader's default language, Bengali), the way a teacher uses it: select, change how media is presented, undo, move,
// resize, add files, preview as a student, save, and open what was saved.
//
//   node tools/reader-author-e2e.mjs [url] [shots-dir]   (default http://localhost:5190/; the showcase must be running)
import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { unpackLesson } from '../packages/container/src/index.ts';

const URL = process.argv[2] ?? 'http://localhost:5190/';
const SHOTS = process.argv[3];
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const media = (f) => new globalThis.URL(`../apps/reader/showcase/media/${f}`, import.meta.url).pathname;
const shot = async (p, name) => { if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}.png` }); };

const b = await chromium.launch();
let failed = false;
const check = (name, ok, detail = '') => { if (!ok) failed = true; console.log(ok ? 'ok  ' : 'FAIL', name, detail); };

// ---- desktop ----
{
  const p = await b.newPage({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
  await p.goto(URL); await p.waitForSelector('.chalk-dock-page');
  const go = async (n) => { await p.click('.chalk-dock-page'); await p.fill('.chalk-dock-page input', String(n)); await p.press('.chalk-dock-page input', 'Enter'); await p.waitForTimeout(1000); };
  const obj = (id) => p.evaluate((i) => { const e = document.querySelector(`[data-chalk-id="${i}"]`); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, cls: e.className, label: e.getAttribute('aria-label') }; }, id);

  await p.click('.app-mode button:has-text("Author")');
  check('author mode on', await p.waitForFunction(() => document.querySelector('.chalk-reader')?.dataset.mode === 'author', null, { timeout: 3000 }).then(() => true, () => false));
  await go(2);
  await p.evaluate(() => document.querySelector('[data-chalk-id="screw-gauge"]')?.scrollIntoView({ block: 'center' }));
  await p.waitForTimeout(500);
  const card = await obj('screw-gauge');
  check('nothing starts by itself in author mode', !(await p.$('.chalk-model')));
  await p.mouse.click(card.x + card.w / 2, card.y + card.h / 2);
  await p.waitForSelector('.chalk-insp');
  check('a tap selects and shows its properties', (await p.textContent('.chalk-insp-kind')).includes('ত্রিমাত্রিক মডেল'));
  await shot(p, 'author-selected');

  // presentation through the panel
  await p.fill('.chalk-insp input[type="text"]', 'স্ক্রু গজ · দেখো');
  await p.click('.chalk-insp-icon[aria-label="atom"]');
  await p.click('.chalk-insp-swatch[aria-label="#b42318"]');
  const c2 = await obj('screw-gauge');
  check('label, icon and colour show on the card', c2.label === 'স্ক্রু গজ · দেখো' && (await p.evaluate(() => getComputedStyle(document.querySelector('[data-chalk-id="screw-gauge"] .chalk-card-glyph')).backgroundColor)) === 'rgb(180, 35, 24)');
  await p.click('.chalk-insp-seg label:has-text("ছোট আইকন")');
  check('small icon makes it a marker', !!(await p.$('.chalk-marker[data-chalk-id="screw-gauge"]')));
  await p.keyboard.press('Control+z');
  await p.waitForTimeout(200);
  check('undo brings the card back', !!(await p.$('[data-chalk-id="screw-gauge"].chalk-card')));

  // move and resize with the mouse
  const before = await obj('screw-gauge');
  await p.mouse.move(before.x + before.w / 2, before.y + before.h / 2);
  await p.mouse.down(); await p.mouse.move(before.x + before.w / 2 - 120, before.y + before.h / 2 + 30, { steps: 8 }); await p.mouse.up();
  const after = await obj('screw-gauge');
  check('drag moves it', Math.round(before.x - after.x) > 100, `${Math.round(before.x - after.x)} px`);
  const hd = await p.$('.chalk-author-handle'); const hb = await hd.boundingBox();
  await p.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await p.mouse.down(); await p.mouse.move(hb.x + hb.width / 2 + 80, hb.y + hb.height / 2 + 5, { steps: 8 }); await p.mouse.up();
  const sized = await obj('screw-gauge');
  check('handle resizes it, keeping its proportions', sized.w > after.w + 60 && Math.abs(sized.w / sized.h - after.w / after.h) < 0.02, `${Math.round(after.w)}→${Math.round(sized.w)}`);
  await shot(p, 'author-moved');

  // add media with the + button (the file picker)
  await p.setInputFiles('.chalk-reader input[type="file"][multiple]', [media('screw-gauge-poster.png'), media('pendulum.webm')]);
  await p.waitForFunction(() => document.querySelectorAll('[data-chalk-id^="video"], [data-chalk-id^="image"]').length >= 1, null, { timeout: 15000 }).catch(() => {});
  await p.waitForTimeout(800);
  const added = await p.evaluate(() => [...document.querySelectorAll('[data-chalk-id]')].map((e) => e.getAttribute('data-chalk-id')).filter((i) => /^(image|video)/.test(i)));
  check('added files appear on the page', added.some((i) => i.startsWith('video')), JSON.stringify(added));
  check('the last one added is selected', (await p.textContent('.chalk-insp-kind')).includes('ভিডিও'));
  check('a new video gets a poster from its frames', await p.evaluate(() => { const v = [...document.querySelectorAll('[data-chalk-id^="video"]')].pop(); return !!v?.querySelector('img'); }));
  check('unsaved changes are marked', !!(await p.$('.chalk-dock-save.is-dirty')));
  await shot(p, 'author-added');

  // the student's view
  await p.click('.app-mode button:has-text("Read")');
  await p.waitForTimeout(400);
  check('read mode: the edits are there', (await p.$('[data-chalk-id="screw-gauge"][aria-label="স্ক্রু গজ · দেখো"]')) !== null);
  check('read mode: no selection or panel', !(await p.$('.chalk-author-sel')) && !(await p.$('.chalk-insp')));

  // save
  await p.click('.app-mode button:has-text("Author")');
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('.chalk-dock button[aria-label^="বইটি সংরক্ষণ করুন"]')]);
  const file = await dl.path();
  const r = await unpackLesson(new Uint8Array(readFileSync(file)));
  const pg = r.lesson.pages[1];
  const sg = pg.objects.find((o) => o.id === 'screw-gauge');
  check('saved: presentation', sg?.presentation?.label === 'স্ক্রু গজ · দেখো' && sg.presentation.icon === 'atom' && sg.presentation.accent === '#b42318', JSON.stringify(sg?.presentation));
  const vid = pg.objects.find((o) => o.type === 'embed' && o.embed === 'video');
  check('saved: the new video, its bytes and its poster', !!vid && r.assets.has(vid.assetId) && !!vid.poster && r.assets.has(vid.poster));
  check('saved: the new image', pg.objects.some((o) => o.type === 'image' && r.assets.has(o.assetId)));
  check('saved: c1 keys for added media', /^c1:/.test(vid?.assetId ?? ''));
  check('saved: nothing missing', r.missingAssetIds.length === 0, JSON.stringify(r.missingAssetIds));
  await p.waitForTimeout(300);
  check('saving clears the unsaved mark', !(await p.$('.chalk-dock-save.is-dirty')));
  check('no errors', errs.length === 0, errs.join(' | '));
  await p.close();
}

// ---- phone ----
{
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await p.goto(URL); await p.waitForSelector('.chalk-dock-page');
  await p.tap('.app-mode button:has-text("Author")');
  await p.tap('.chalk-dock-page'); await p.fill('.chalk-dock-page input', '3'); await p.press('.chalk-dock-page input', 'Enter'); await p.waitForTimeout(1000);
  await p.evaluate(() => document.querySelector('[data-chalk-id="pendulum-video"]')?.scrollIntoView({ block: 'center' }));
  await p.waitForTimeout(400);
  const v = await p.evaluate(() => { const r = document.querySelector('[data-chalk-id="pendulum-video"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await p.touchscreen.tap(v.x, v.y);
  await p.waitForSelector('.chalk-insp', { timeout: 3000 }).catch(() => {});
  check('phone: a tap selects; properties in a bottom sheet', !!(await p.$('.chalk-panel .chalk-insp')));
  await p.waitForTimeout(700);
  check('phone: the selection is moved up above the sheet', await p.evaluate(() => {
    const o = document.querySelector('[data-chalk-id="pendulum-video"]').getBoundingClientRect(), s = document.querySelector('.chalk-panel').getBoundingClientRect();
    return o.top >= 0 && o.top < s.top - 40;
  }));
  await shot(p, 'author-phone');
  await p.close();
}
await b.close();
process.exit(failed ? 1 : 0);
