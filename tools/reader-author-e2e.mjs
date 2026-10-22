// Author mode with real input (the author's tools in English, the default authoring language), the way a teacher uses it: select, change how media is presented, undo, move,
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
  check('a tap selects and shows its properties', (await p.textContent('.chalk-sidebar-head h2')).includes('3D model'));
  await shot(p, 'author-selected');

  // presentation through the panel
  await p.fill('.chalk-insp input[type="text"]', 'স্ক্রু গজ · দেখো');
  await p.click('.chalk-insp-icon[aria-label="atom"]');
  await p.click('.chalk-insp-swatch[aria-label="#b42318"]');
  const c2 = await obj('screw-gauge');
  check('label, icon and colour show on the card', c2.label === 'স্ক্রু গজ · দেখো' && (await p.evaluate(() => getComputedStyle(document.querySelector('[data-chalk-id="screw-gauge"] .chalk-card-glyph')).backgroundColor)) === 'rgb(180, 35, 24)');
  await p.click('.chalk-sidebar .chalk-insp-seg label:has-text("Thumbnail")');
  await p.click('.chalk-insp-seg label:has-text("Small icon")');
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

  // add media: + in the rail, a kind, its options in the sidebar (start as live), then the file
  await p.click('.chalk-rail .is-add');
  await p.click('.chalk-rail-item:has-text("Video")');
  check('+ › video: the sidebar shows adding a video', (await p.textContent('.chalk-sidebar-head h2')).includes('Video') && !!(await p.$('.chalk-drop, .chalk-gallery')));
  await p.click('.chalk-sidebar .chalk-insp-seg label:has-text("Live")');
  await shot(p, 'author-adding');
  await p.setInputFiles('.chalk-reader input[type="file"][multiple]', [media('screw-gauge-poster.png'), media('pendulum.webm')]);
  await p.waitForFunction(() => document.querySelectorAll('[data-chalk-id^="video"], [data-chalk-id^="image"]').length >= 1, null, { timeout: 15000 }).catch(() => {});
  await p.waitForTimeout(800);
  const added = await p.evaluate(() => [...document.querySelectorAll('[data-chalk-id]')].map((e) => e.getAttribute('data-chalk-id')).filter((i) => /^(image|video)/.test(i)));
  check('added files appear on the page', added.some((i) => i.startsWith('video')), JSON.stringify(added));
  check('the last one added is selected', (await p.textContent('.chalk-sidebar-head h2')).includes('Video'));
  check('a new video gets a poster from its frames', await p.evaluate(() => { const v = [...document.querySelectorAll('[data-chalk-id^="video"]')].pop(); return !!v?.querySelector('img'); }));
  check('unsaved changes are marked', !!(await p.$('.chalk-dock-save.is-dirty')));
  await shot(p, 'author-added');

  // drawing into the book, ChalkBoard-style tools from the rail and the keyboard
  check('the tool rail is there', !!(await p.$('.chalk-rail')));
  await go(1);
  // a tool other than select closes the properties panel, which moves the page: measure after that
  await p.click('.chalk-rail button[aria-label^="Pen"]');
  await p.waitForTimeout(300);
  const pg1 = await p.evaluate(() => { const r = document.querySelector('.chalk-page').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const P = (fx, fy) => [pg1.x + pg1.w * fx, pg1.y + pg1.h * fy];
  const count = (sel) => p.evaluate((s) => document.querySelectorAll(s).length, sel);
  const drawLine = async (a, b2) => { await p.mouse.move(...a); await p.mouse.down(); await p.mouse.move(...b2, { steps: 12 }); await p.mouse.up(); await p.waitForTimeout(150); };
  const inkBefore = await count('.chalk-page path');
  await drawLine(P(0.2, 0.3), P(0.45, 0.33));
  check('pen draws into the page', (await count('.chalk-page path')) > inkBefore);
  await p.keyboard.press('r');
  check('R picks the rectangle', await p.evaluate(() => document.querySelector('.chalk-surface')?.classList.contains('is-rect')));
  check('the sidebar shows the tool\'s settings', (await p.textContent('.chalk-sidebar-head h2')).includes('Rectangle') && !!(await p.$('.chalk-sidebar fieldset:has(legend:text("Fill"))')));
  await p.click('.chalk-sidebar fieldset:has(legend:text("Fill")) .chalk-insp-swatch[aria-label="#2e7d32"]');
  await shot(p, 'author-tool');
  await drawLine(P(0.55, 0.34), P(0.8, 0.44));
  check('the tool settings shape what is drawn', await p.evaluate(() => [...document.querySelectorAll('.chalk-page rect')].some((r) => r.getAttribute('fill') === '#2e7d32')));
  await p.keyboard.press('t');
  await p.mouse.click(...P(0.15, 0.46)); await p.waitForTimeout(150);
  await p.keyboard.type('লেখকের লেখা'); await p.keyboard.press('Enter'); await p.waitForTimeout(200);
  check('text tool writes text', await p.evaluate(() => [...document.querySelectorAll('.chalk-text')].some((t) => t.textContent === 'লেখকের লেখা')),
    JSON.stringify(await p.evaluate(() => ({ input: document.querySelector('.chalk-note-input')?.value, surface: document.querySelector('.chalk-surface')?.className }))));
  // select the rectangle and fill it from the panel
  await p.keyboard.press('v');
  await p.mouse.click(...P(0.67, 0.39)); await p.waitForSelector('.chalk-insp', { timeout: 5000 });
  check('a shape is selectable, with its own properties', (await p.textContent('.chalk-sidebar-head h2')).includes('Rectangle'));
  await p.click('.chalk-insp fieldset:has(legend:text("Fill")) .chalk-insp-swatch[aria-label="#ef6c00"]');
  check('the sidebar fills it', await p.evaluate(() => [...document.querySelectorAll('.chalk-page rect')].some((r) => r.getAttribute('fill') === '#ef6c00')));
  const rx = () => p.evaluate(() => Number([...document.querySelectorAll('.chalk-page rect')].find((r) => r.getAttribute('fill') === '#ef6c00')?.getAttribute('x')));
  const x0 = await rx();
  await p.fill('.chalk-sidebar .chalk-num:has(span:text-is("X")) input', String(x0 + 50));
  check('X in the sidebar moves it', (await rx()) === x0 + 50, `${x0}→${await rx()}`);
  await shot(p, 'author-shape-selected');
  await p.keyboard.press('Escape'); await p.keyboard.press('Escape');
  check('nothing selected: the sidebar shows the page and what is on it', !!(await p.$('.chalk-objlist')) && (await p.textContent('.chalk-objlist')).includes('Rectangle'));
  await shot(p, 'author-page');
  await p.click('.chalk-objrow:has-text("Rectangle")');
  check('a click in that list selects', (await p.textContent('.chalk-sidebar-head h2')).includes('Rectangle'));
  await p.keyboard.press('Escape');
  // the eraser removes the pen stroke, not media
  await p.keyboard.press('e');
  const inkNow = await count('.chalk-page path');
  await drawLine(P(0.3, 0.28), P(0.3, 0.36));
  check('eraser removes the drawing', (await count('.chalk-page path')) < inkNow);
  await p.keyboard.press('v');
  await shot(p, 'author-drawn');

  // a video carried in the book, set to live + autoplay
  await go(3);
  await p.evaluate(() => document.querySelector('[data-chalk-id="pendulum-video"]')?.scrollIntoView({ block: 'center' }));
  await p.waitForTimeout(300);
  { const v = await obj('pendulum-video'); await p.mouse.click(v.x + v.w / 2, v.y + v.h / 2); }
  await p.click('.chalk-sidebar .chalk-insp-seg label:has-text("Live")');
  await p.click('.chalk-sidebar label:has-text("Play by itself")');

  // the student's view
  await p.click('.app-mode button:has-text("Read")');
  await p.evaluate(() => document.querySelector('[data-chalk-id="pendulum-video"]')?.scrollIntoView({ block: 'center' }));
  const auto = await p.waitForFunction(() => { const v = document.querySelector('[data-chalk-id="pendulum-video"] video'); return v && !v.paused && v.currentTime > 0.3 ? { muted: v.muted } : null; }, null, { timeout: 8000 }).then((h) => h.jsonValue(), () => null);
  check('a book video set live + autoplay plays by itself, silently', auto?.muted === true, JSON.stringify(auto));
  await p.waitForTimeout(400);
  check('read mode: the edits are there', (await p.$('[data-chalk-id="screw-gauge"][aria-label="স্ক্রু গজ · দেখো"]')) !== null);
  check('read mode: no selection or panel', !(await p.$('.chalk-author-sel')) && !(await p.$('.chalk-insp')));

  // save; the dock's own switch goes through the host (the showcase controls the mode)
  await p.click('.chalk-dock button[aria-label="Edit this book"]');
  check('the dock\'s switch changes a host-controlled mode', await p.waitForFunction(() => document.querySelector('.chalk-reader')?.dataset.mode === 'author' && document.querySelector('.app-mode button[aria-checked="true"]')?.textContent === 'Author', null, { timeout: 3000 }).then(() => true, () => false));
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('.chalk-dock button[aria-label^="Save the book"]')]);
  const file = await dl.path();
  const r = await unpackLesson(new Uint8Array(readFileSync(file)));
  const pg = r.lesson.pages[1];
  const sg = pg.objects.find((o) => o.id === 'screw-gauge');
  check('saved: presentation', sg?.presentation?.label === 'স্ক্রু গজ · দেখো' && sg.presentation.icon === 'atom' && sg.presentation.accent === '#b42318', JSON.stringify(sg?.presentation));
  const vid = pg.objects.find((o) => o.type === 'embed' && o.embed === 'video');
  check('saved: the new video, its bytes and its poster', !!vid && r.assets.has(vid.assetId) && !!vid.poster && r.assets.has(vid.poster));
  check('saved: the new image', pg.objects.some((o) => o.type === 'image' && r.assets.has(o.assetId)));
  check('saved: c1 keys for added media', /^c1:/.test(vid?.assetId ?? ''));
  check('saved: "Thumbnail" chosen by the author is kept, not dropped', sg?.presentation?.show === 'card', JSON.stringify(sg?.presentation));
  check('saved: the video starts as set while adding it (live)', vid?.presentation?.show === 'live', JSON.stringify(vid?.presentation));
  check('saved: nothing missing', r.missingAssetIds.length === 0, JSON.stringify(r.missingAssetIds));
  const p1 = r.lesson.pages[0].objects;
  check('saved: the rectangle (filled), the text, and no erased stroke', p1.some((o) => o.type === 'rect' && o.fill === '#ef6c00') && p1.some((o) => o.type === 'text' && o.text === 'লেখকের লেখা') && !p1.some((o) => o.type === 'ink'),
    JSON.stringify(p1.map((o) => o.type)));
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
  check('phone: a tap selects; properties in a bottom sheet', !!(await p.$('.chalk-sidebar .chalk-insp')));
  await p.waitForTimeout(700);
  check('phone: the selection is moved up above the sheet', await p.evaluate(() => {
    const o = document.querySelector('[data-chalk-id="pendulum-video"]').getBoundingClientRect(), s = document.querySelector('.chalk-sidebar').getBoundingClientRect();
    return o.top >= 0 && o.top < s.top - 40;
  }));
  await shot(p, 'author-phone');
  await p.close();
}
await b.close();
process.exit(failed ? 1 : 0);
