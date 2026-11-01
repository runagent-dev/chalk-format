// Author mode: an object goes to another page, with real input. A mouse drag carries the 3D model from its page onto the next one (the
// view scrolls when the pointer nears its edge); one undo puts it back, redo again; "Move to page" in the sidebar and Alt+Page Up / Down
// take it to a far page; the selection follows it everywhere and its id stays. On a phone a finger does the same (real touch events).
// The patch save sends both pages, the saved .chalk has it once, on its new page; Bengali author strings read right.
//
//   npx tsx tools/reader-move-page-e2e.mjs [url] [shots-dir]   (default http://localhost:5190/; the showcase must be running)
import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { unpackLesson } from '../packages/container/src/index.ts';

const URL = (process.argv[2] ?? 'http://localhost:5190/').replace(/\/?$/, '/');
const SHOTS = process.argv[3];
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = async (p, name) => { if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}.png` }); };
const b = await chromium.launch();
let failed = false;
const check = (name, ok, detail = '') => { if (!ok) failed = true; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : detail ? ` (${detail})` : ''}`); };

/** Where an object is drawn: its page's number (1-based, by the order of the pages in the view), its screen box, how many there are. */
const where = (p, id) => p.evaluate((i) => {
  const all = [...document.querySelectorAll(`.chalk-viewer [data-chalk-id="${i}"]`)];
  const e = all[0]; if (!e) return null;
  const pages = [...document.querySelectorAll('.chalk-viewer .chalk-page')];
  const pg = e.closest('.chalk-page'), r = e.getBoundingClientRect();
  const surface = pg?.querySelector('[data-chalk-page]');
  return { page: pages.indexOf(pg) + 1, pageId: surface?.getAttribute('data-chalk-page'), count: all.length, x: r.x, y: r.y, w: r.width, h: r.height,
    selOnSame: !!pg?.querySelector('.chalk-author-sel'), sels: document.querySelectorAll('.chalk-author-sel').length };
}, id);
const pageBox = (p, n) => p.evaluate((k) => { const r = document.querySelectorAll('.chalk-viewer .chalk-page')[k - 1]?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null; }, n);
const scrollTo = (p, id) => p.evaluate((i) => document.querySelector(`.chalk-viewer [data-chalk-id="${i}"]`)?.scrollIntoView({ block: 'center' }), id);

async function openAuthor(o, query = '', book) {
  const ctx = await b.newContext({ acceptDownloads: true, ...o });
  const p = await ctx.newPage();
  await p.addInitScript({ content: 'window.__name = (f) => f' }); // tsx names functions; those sent to the page need the helper
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/CORS|ERR_FAILED|404/.test(m.text())) errs.push(m.text().slice(0, 200)); });
  await p.goto(`${URL}${query}`);
  await p.waitForSelector('.chalk-dock-page');
  if (book) { await p.selectOption('.app-bar select', book); await p.waitForSelector('.chalk-dock-page'); }
  await p.click('.app-mode button[role=radio]:has-text("Author")');
  await p.waitForSelector('.chalk-surface.chalk-author', { timeout: 60000 });
  await p.waitForTimeout(800);
  return { ctx, p, errs };
}

// ---- desktop: drag with the mouse, undo, redo, Move to page, keys, save ----
{
  const { ctx, p, errs } = await openAuthor({ viewport: { width: 1280, height: 800 } });
  await scrollTo(p, 'screw-gauge'); await p.waitForTimeout(800);
  const a = await where(p, 'screw-gauge');
  check('the 3D model starts on page 2', a?.page === 2, JSON.stringify(a));
  await p.mouse.click(a.x + a.w / 2, a.y + a.h / 2);
  await p.waitForSelector('.chalk-insp-move select', { timeout: 5000 }).catch(async () => { console.log('     sidebar:', await p.textContent('.chalk-sidebar-head'), JSON.stringify(a)); await p.screenshot({ path: 'out/fail.png' }); });
  check('selected: the sidebar offers Move to page, on page 2', (await p.inputValue('.chalk-insp-move select')) === '1');
  await shot(p, 'move-selected-desktop');

  // drag it down past the bottom of its page, onto the top of page 3 (the view scrolls on its way)
  const from = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  await p.mouse.move(from.x, from.y); await p.mouse.down();
  await p.mouse.move(from.x, 790, { steps: 12 });
  // hold near the bottom edge: the view scrolls until page 3 is under the pointer
  for (let i = 0; i < 80; i++) { await p.mouse.move(from.x + (i % 2), 790); await p.waitForTimeout(30); if ((await where(p, 'screw-gauge'))?.page === 3 && (await pageBox(p, 3)).y < 300) break; }
  const p3 = await pageBox(p, 3);
  const dropAt = { x: from.x - 60, y: Math.round(p3.y + 140) };
  await p.mouse.move(dropAt.x, dropAt.y, { steps: 10 });
  await p.waitForTimeout(150);
  await shot(p, 'move-dragging-desktop');
  await p.mouse.up();
  await p.waitForTimeout(300);
  const c = await where(p, 'screw-gauge'), p3after = await pageBox(p, 3);
  check('the drag carried it onto page 3, once, under the pointer', c?.page === 3 && c.count === 1 && Math.abs(c.x + c.w / 2 - dropAt.x) < 4 && c.y <= dropAt.y && c.y + c.h >= dropAt.y, JSON.stringify({ c, dropAt }));
  check('dropped on another page, all of it is on that page', c && c.y >= p3after.y - 1 && c.y + c.h <= p3after.y + p3after.h + 1, JSON.stringify({ c, p3after }));
  check('it stays selected, on its new page (one selection box)', c?.selOnSame && c.sels === 1 && (await p.textContent('.chalk-sidebar-head h2')).includes('3D model'));
  check('the sidebar says page 3', (await p.inputValue('.chalk-insp-move select')) === '2');
  check('the book is unsaved', !!(await p.$('.chalk-dock-save.is-dirty')));
  await shot(p, 'move-dropped-desktop');

  await p.keyboard.press('Control+z'); await p.waitForTimeout(300);
  await scrollTo(p, 'screw-gauge'); await p.waitForTimeout(300);
  const u = await where(p, 'screw-gauge');
  check('one undo puts it back on page 2, where it was', u?.page === 2 && u.count === 1 && Math.abs(u.w - a.w) < 1, JSON.stringify(u));
  check('the selection followed it back', u?.selOnSame === true);
  await p.keyboard.press('Control+y'); await p.waitForTimeout(300);
  check('redo carries it to page 3 again', (await where(p, 'screw-gauge'))?.page === 3);

  // the sidebar: a far page by its number, then the previous page by the button
  await p.selectOption('.chalk-insp-move select', '4'); await p.waitForTimeout(600);
  const f = await where(p, 'screw-gauge');
  check('Move to page › page 5: it is on page 5, in view, still selected', f?.page === 5 && f.selOnSame && f.y > 0 && f.y < 800, JSON.stringify(f));
  await shot(p, 'move-to-page5-desktop');
  await p.click('.chalk-insp-move button[aria-label="Move to the previous page"]'); await p.waitForTimeout(500);
  check('the previous-page button takes it to page 4', (await where(p, 'screw-gauge'))?.page === 4);
  check('the next-page button is off on the last page only', !(await p.isDisabled('.chalk-insp-move button[aria-label="Move to the next page"]')));
  // keys: Alt+Page Up / Page Down (focus on the page, as after a click)
  await p.keyboard.press('Alt+PageUp'); await p.waitForTimeout(500);
  check('Alt+Page Up: to page 3', (await where(p, 'screw-gauge'))?.page === 3);
  await p.keyboard.press('Alt+PageDown'); await p.keyboard.press('Alt+PageDown'); await p.waitForTimeout(500);
  check('Alt+Page Down twice: to page 5, the last', (await where(p, 'screw-gauge'))?.page === 5);
  check('the next-page button is off on the last page', await p.isDisabled('.chalk-insp-move button[aria-label="Move to the next page"]'));
  await p.keyboard.press('Alt+PageDown'); await p.waitForTimeout(300);
  check('and Alt+Page Down there changes nothing', (await where(p, 'screw-gauge'))?.page === 5);
  // undo: the object goes back to page 4, and the view goes with it, still selected
  await p.keyboard.press('Control+z'); await p.waitForTimeout(700);
  const back = await where(p, 'screw-gauge');
  check('undo of a move shows the object where it went back to, selected', back?.page === 4 && back.selOnSame && back.y > -back.h && back.y < 800, JSON.stringify(back));
  await p.keyboard.press('Control+y'); await p.waitForTimeout(700);
  check('redo takes it (and the view) to page 5 again', (await where(p, 'screw-gauge'))?.page === 5);

  // a video goes too, keeping how it is presented
  // pages far from the view are not drawn: go to the video's page first
  await p.click('.chalk-dock-page'); await p.fill('.chalk-dock-page input', '3'); await p.press('.chalk-dock-page input', 'Enter'); await p.waitForTimeout(800);
  await scrollTo(p, 'pendulum-video'); await p.waitForTimeout(500);
  const v = await where(p, 'pendulum-video');
  const vLabel = await p.evaluate(() => document.querySelector('[data-chalk-id="pendulum-video"]')?.getAttribute('aria-label'));
  await p.mouse.click(v.x + v.w / 2, v.y + v.h / 2); await p.waitForTimeout(200);
  await p.selectOption('.chalk-insp-move select', '0'); await p.waitForTimeout(500);
  const v2 = await where(p, 'pendulum-video');
  check('the video moves to page 1 with its label', v2?.page === 1 && (await p.evaluate(() => document.querySelector('[data-chalk-id="pendulum-video"]')?.getAttribute('aria-label'))) === vLabel, JSON.stringify(v2));

  // a drag cut short by a tool change (P, let go, V) is over: moving the mouse afterwards moves nothing
  const s0 = await where(p, 'pendulum-video');
  await p.mouse.move(s0.x + s0.w / 2, s0.y + s0.h / 2); await p.mouse.down(); await p.mouse.move(s0.x + s0.w / 2 + 20, s0.y + s0.h / 2 + 10, { steps: 4 });
  await p.keyboard.press('p'); await p.mouse.up(); await p.keyboard.press('v'); await p.waitForTimeout(200);
  const s1 = await where(p, 'pendulum-video');
  await p.mouse.move(s0.x + s0.w / 2 + 200, s0.y + s0.h / 2 + 120, { steps: 6 }); await p.waitForTimeout(200);
  const s2 = await where(p, 'pendulum-video');
  check('a drag cut short by a tool change leaves the object where it was let go', Math.abs(s2.x - s1.x) < 1 && Math.abs(s2.y - s1.y) < 1, JSON.stringify({ s1, s2 }));

  // save (the showcase downloads the .chalk): each object once, on its new page, the same id
  const dl = p.waitForEvent('download');
  await p.keyboard.press('Control+s');
  const file = await (await dl).path();
  const { lesson } = await unpackLesson(new Uint8Array(readFileSync(file)));
  const on = (id) => lesson.pages.flatMap((pg, i) => pg.objects.filter((o) => o.id === id).map(() => i + 1));
  check('saved: the 3D model once, on page 5', JSON.stringify(on('screw-gauge')) === '[5]', JSON.stringify(on('screw-gauge')));
  check('saved: the video once, on page 1', JSON.stringify(on('pendulum-video')) === '[1]', JSON.stringify(on('pendulum-video')));
  check('no errors on the page', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

// ---- the patch save of a streamed book: both pages, nothing else ----
{
  const { ctx, p, errs } = await openAuthor({ viewport: { width: 1280, height: 800 } }, '?save=patch', 'long');
  // the lab of the sample's pages: the first page that has it
  let l = null;
  for (let n = 1; n <= 5 && !l; n++) {
    await p.click('.chalk-dock-page'); await p.fill('.chalk-dock-page input', String(n)); await p.press('.chalk-dock-page input', 'Enter'); await p.waitForTimeout(800);
    await scrollTo(p, 'pendulum-lab'); await p.waitForTimeout(500);
    l = await where(p, 'pendulum-lab');
  }
  await p.mouse.click(l.x + 20, l.y + 20); await p.waitForSelector('.chalk-insp-move select');
  const fromPage = Number(await p.inputValue('.chalk-insp-move select'));
  await p.click('.chalk-insp-move button[aria-label="Move to the next page"]'); await p.waitForTimeout(500);
  await p.locator('.chalk-dock-btn:has(.chalk-dock-save)').first().click();
  await p.waitForFunction(() => document.querySelector('.app-save')?.getAttribute('data-dirty') === 'false', null, { timeout: 30000 });
  const patches = await p.evaluate(() => window.__patches ?? []);
  const sent = patches[0];
  check('one patch, with exactly the two pages', patches.length === 1 && sent.pages.length === 2 && sent.pages.includes(`long-${fromPage + 1}`) && sent.pages.includes(`long-${fromPage + 2}`), JSON.stringify(sent?.pages));
  check('the page it left has one object fewer, the page it is on one more', sent && sent.mineObjects[sent.pages.indexOf(`long-${fromPage + 1}`)] === sent.baseObjects[sent.base.indexOf(`long-${fromPage + 1}`)] - 1 && sent.mineObjects[sent.pages.indexOf(`long-${fromPage + 2}`)] === sent.baseObjects[sent.base.indexOf(`long-${fromPage + 2}`)] + 1, JSON.stringify(sent));
  check('no media is sent for a move', sent?.media.length === 0);
  check('no errors (streamed book)', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

// ---- phone: a finger selects, then carries the object onto the next page; the sheet's buttons; Bengali ----
{
  const { ctx, p, errs } = await openAuthor({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const cdp = await ctx.newCDPSession(p);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  await scrollTo(p, 'screw-gauge'); await p.waitForTimeout(800);
  let a = await where(p, 'screw-gauge');
  await p.touchscreen.tap(a.x + a.w / 2, a.y + a.h / 2);
  await p.waitForSelector('.chalk-insp-move select'); await p.waitForTimeout(700); // the sheet opens and the object is scrolled up above it
  a = await where(p, 'screw-gauge');
  check('phone: a tap selects; the sheet offers Move to page', a?.page === 2);
  await shot(p, 'move-selected-phone');
  const sheetTop = await p.evaluate(() => document.querySelector('.chalk-sidebar').getBoundingClientRect().top);
  // the finger goes down the page to just above the sheet and waits there: the view scrolls until page 3 is under it
  const x0 = a.x + a.w / 2, y0 = a.y + a.h / 2;
  await touch('touchStart', x0, y0);
  for (let k = 1; k <= 10; k++) { await touch('touchMove', x0, y0 + ((sheetTop - 20 - y0) * k) / 10); await p.waitForTimeout(16); }
  for (let i = 0; i < 80 && (await where(p, 'screw-gauge'))?.page !== 3; i++) { await touch('touchMove', x0 + (i % 2), sheetTop - 20); await p.waitForTimeout(30); }
  const p3 = await pageBox(p, 3);
  const dropY = Math.max(p3.y + 120, 120);
  for (let k = 1; k <= 6; k++) { await touch('touchMove', x0, sheetTop - 20 + ((dropY - sheetTop + 20) * k) / 6); await p.waitForTimeout(16); }
  await shot(p, 'move-dragging-phone');
  await touch('touchEnd'); await p.waitForTimeout(400);
  const c = await where(p, 'screw-gauge');
  check('phone: the finger carried it onto page 3, once, still selected', c?.page === 3 && c.count === 1 && c.selOnSame, JSON.stringify(c));
  await shot(p, 'move-dropped-phone');
  await p.tap('.chalk-insp-move button[aria-label="Move to the next page"]'); await p.waitForTimeout(600);
  check('phone: the next-page button in the sheet takes it to page 4', (await where(p, 'screw-gauge'))?.page === 4);
  check('no errors (phone)', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

// ---- the author strings in Bengali ----
{
  const { ctx, p } = await openAuthor({ viewport: { width: 1280, height: 800 } });
  // the Configure playground: the language of the author's tools
  await p.click('.app-btn:has-text("Configure")');
  await p.click('fieldset.pg-choice:has(legend:has-text("Language of the author")) label:has-text("bn")');
  await p.click('.app-btn:has-text("Configure")');
  await p.waitForTimeout(500);
  await scrollTo(p, 'screw-gauge'); await p.waitForTimeout(800);
  const a = await where(p, 'screw-gauge');
  await p.mouse.click(a.x + a.w / 2, a.y + a.h / 2);
  const bn = await p.waitForSelector('.chalk-insp-move', { timeout: 3000 }).then(() => p.evaluate(() => ({
    title: [...document.querySelectorAll('.chalk-side-section h3')].map((h) => h.textContent).find((t) => t.includes('পাতায়')),
    option: document.querySelector('.chalk-insp-move select option:checked')?.textContent,
    prev: document.querySelector('.chalk-insp-move button')?.getAttribute('aria-label'),
  })), () => null);
  check('Bengali: the Move to page section is there', !!bn);
  if (bn) {
    check('Bengali: the section, the page (Bengali digits) and the button read right', bn.title === 'অন্য পাতায় সরান' && bn.option === 'পাতা ২' && bn.prev === 'আগের পাতায় সরান', JSON.stringify(bn));
    await shot(p, 'move-bengali-desktop');
  }
  await ctx.close();
}

await b.close();
console.log(failed ? 'SOME CHECKS FAILED' : 'all checks passed');
process.exit(failed ? 1 : 0);
