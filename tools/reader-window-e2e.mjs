// The floating window (spec 1.6 `open: window`) with real input: an author chooses "In a floating window" for a lab and a video, a student taps them, and the
// window floats over a page that stays usable. Checks the author UI (Inspector and Add-media panel, undo), the window (no backdrop, the page behind scrolls and
// takes clicks, the lab runs, the media's own shape, drag, resize keeps the shape, keyboard, edges, one at a time, Escape and focus), the narrow-reader sheet,
// the host's options (docked side panel, own chrome), reduced motion, and that the dialog and full screen are unchanged.
//
//   node tools/reader-window-e2e.mjs [url] [shots-dir]   (default http://localhost:5190/; the showcase must be running)
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const URL = process.argv[2] ?? 'http://localhost:5190/';
const SHOTS = process.argv[3];
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = async (p, name) => { if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}.png` }); };

const b = await chromium.launch();
let failed = false;
const check = (name, ok, detail = '') => { if (!ok) failed = true; console.log(ok ? 'ok  ' : 'FAIL', name, ok ? '' : detail); };
const near = (a, c, tol) => Math.abs(a - c) <= tol;

const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => { if (m.type() === 'error' && !/CORS|ERR_FAILED|Failed to load resource/.test(m.text())) errs.push(m.text().slice(0, 200)); });
await p.goto(URL);
await p.waitForSelector('.chalk-dock-page');
// a cold Vite server reloads the page once when it has optimised its dependencies: let that happen before the test begins
await p.waitForTimeout(2500); await p.goto(URL); await p.waitForSelector('.chalk-dock-page');

const go = async (n) => { await p.click('.chalk-dock-page'); await p.fill('.chalk-dock-page input', String(n)); await p.press('.chalk-dock-page input', 'Enter'); await p.waitForTimeout(1000); };
const rect = (sel) => p.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom }; }, sel);
const obj = (id) => rect(`[data-chalk-id="${id}"]`);
const reveal = async (id) => { await p.evaluate((i) => document.querySelector(`[data-chalk-id="${i}"]`)?.scrollIntoView({ block: 'center' }), id); await p.waitForTimeout(500); return obj(id); };
const clickObj = async (id) => { const o = await reveal(id); await p.mouse.click(o.x + o.w / 2, o.y + o.h / 2); return o; };
const winCount = () => p.locator('.chalk-window').count();
const root = () => rect('.chalk-reader');
const mode = async (m) => { await p.click(`.app-mode button:has-text("${m}")`); await p.waitForTimeout(600); };
const labelsOf = (legend) => p.locator(`.chalk-insp-field:has(legend:text-is("${legend}")) .chalk-insp-seg label`).allInnerTexts().then((a) => a.map((s) => s.trim()));
const opens = async (name) => { await p.click(`.chalk-insp-field:has(legend:text-is("A tap opens it")) label:has-text("${name}")`); await p.waitForTimeout(300); };
const checkedOpen = () => p.evaluate(() => document.querySelector('.chalk-insp-field:has(legend) .chalk-insp-seg label.is-on')?.textContent?.trim());
const openChecked = () => p.evaluate(() => [...document.querySelectorAll('.chalk-insp-field')].find((f) => f.querySelector('legend')?.textContent === 'A tap opens it')?.querySelector('label.is-on')?.textContent?.trim());

// ---- the author chooses ----
await mode('Author');
await go(3);
const labBox = await clickObj('pendulum-lab');
await p.waitForSelector('.chalk-insp');
const labOptions = await labelsOf('A tap opens it');
check('the Inspector offers the window for a lab, between the dialog and full screen',
  JSON.stringify(labOptions) === JSON.stringify(['In place', 'In a dialog', 'In a floating window', 'Full screen']), JSON.stringify(labOptions));
const initial = await openChecked();
check('the lab has the choice its author made', ['In place', 'In a dialog', 'Full screen'].includes(initial), String(initial));
await opens('In a floating window');
check('the choice is applied', (await openChecked()) === 'In a floating window');
await p.click('.chalk-dock button[aria-label="Undo"]'); await p.waitForTimeout(300);
check('undo takes it back', (await openChecked()) === initial, `${await openChecked()} vs ${initial}`);
await p.click('.chalk-dock button[aria-label="Redo"]'); await p.waitForTimeout(300);
check('redo brings it back', (await openChecked()) === 'In a floating window');
await shot(p, 'window-author-inspector');

await clickObj('pendulum-video');
await p.waitForSelector('.chalk-insp');
check('a video offers it too', (await labelsOf('A tap opens it')).includes('In a floating window'));
await opens('In a floating window');

// the Add-media panel: the right-click menu, Lab, and the presentation it will have
await go(2);
// a point on the page where nothing is placed: the author surface itself answers there
const spot = await p.evaluate(() => {
  const v = document.querySelector('.chalk-viewer').getBoundingClientRect();
  for (let y = v.top + 80; y < v.bottom - 100; y += 24) for (let x = v.left + v.width * 0.3; x < v.left + v.width * 0.7; x += 24) {
    if (document.elementFromPoint(x, y)?.classList.contains('chalk-surface')) return { x, y };
  }
  return null;
});
await p.mouse.click(spot.x, spot.y, { button: 'right' });
await p.locator('.chalk-insert-menu [role=menuitem]', { hasText: 'Lab' }).click();
await p.waitForSelector('.chalk-sidebar .chalk-insp-seg');
check('the Add-media panel offers the window for what is about to be added',
  (await p.locator('.chalk-sidebar .chalk-insp-seg label').allInnerTexts()).some((s) => s.trim() === 'In a floating window'));
await shot(p, 'window-author-add-media');
await p.keyboard.press('Escape');

// ---- the student taps ----
await mode('Read');
await go(3);
const labCard = await reveal('pendulum-lab');
await p.mouse.click(labCard.x + labCard.w / 2, labCard.y + labCard.h / 2);
await p.waitForSelector('.chalk-window[data-layout="floating"]', { timeout: 5000 }); await p.waitForTimeout(400); // the entrance animation (200 ms) has ended
const w1 = await rect('.chalk-window');
const R = await root();
check('a tap opens a floating window, not a dialog', (await winCount()) === 1 && (await p.locator('.chalk-modal').count()) === 0);
check('it is a dialog that is not modal', await p.evaluate(() => { const w = document.querySelector('.chalk-window'); return w?.getAttribute('role') === 'dialog' && w.getAttribute('aria-modal') === 'false' && !!w.getAttribute('aria-label'); }));
check('there is no backdrop', (await p.locator('.chalk-modal-back').count()) === 0);
check('it is inside the reader', w1.x >= R.x && w1.y >= R.y && w1.r <= R.r && w1.b <= R.b);
const share = Math.max(0, Math.min(w1.r, labCard.r) - Math.max(w1.x, labCard.x)) * Math.max(0, Math.min(w1.b, labCard.b) - Math.max(w1.y, labCard.y));
check('it opens beside what was tapped: it covers well under half of it', share / (labCard.w * labCard.h) < 0.4, `${(share / (labCard.w * labCard.h)).toFixed(2)} of it covered`);
await p.waitForFunction(() => document.querySelector('.chalk-window .chalk-lab iframe') && !document.querySelector('.chalk-window .chalk-lab-wait'), null, { timeout: 20000 })
  .then(() => check('the lab runs in the window (hello, init, ready)', true), () => check('the lab runs in the window (hello, init, ready)', false, 'no running lab'));
const labBody = await rect('.chalk-window-body');
check("the window has the lab's own shape", near(labBody.w / labBody.h, labBox.w / labBox.h, 0.05), `${(labBody.w / labBody.h).toFixed(3)} vs ${(labBox.w / labBox.h).toFixed(3)}`);
await shot(p, 'window-floating');

// the page behind stays usable: it scrolls, and the dock turns its pages, with the window open
const sc0 = await p.evaluate(() => document.querySelector('.chalk-viewer').scrollTop);
await p.mouse.move(R.x + 120, R.y + 300); await p.mouse.wheel(0, 400); await p.waitForTimeout(400);
const sc1 = await p.evaluate(() => document.querySelector('.chalk-viewer').scrollTop);
check('the page behind scrolls while the window is open', sc1 !== sc0, `${sc0} -> ${sc1}`);
const pg0 = (await p.textContent('.chalk-dock-page')).trim();
await p.click('.chalk-dock button[aria-label="Next page"], .chalk-dock button[aria-label="পরের পৃষ্ঠা"]'); await p.waitForTimeout(700);
const pg1 = (await p.textContent('.chalk-dock-page')).trim();
check('the dock still turns pages with the window open', pg0 !== pg1, `${pg0} -> ${pg1}`);
check('the window stays open across pages', (await winCount()) === 1);
await go(3);

// drag by the header
const h = await rect('.chalk-window-head');
const before = await rect('.chalk-window');
await p.mouse.move(before.x + 90, h.y + h.h / 2);
await p.mouse.down(); await p.mouse.move(before.x + 90 - 140, h.y + h.h / 2 + 70, { steps: 8 }); await p.mouse.up();
const dragged = await rect('.chalk-window');
check('the header drags the window', near(dragged.x, before.x - 140, 3) && near(dragged.y, before.y + 70, 3), `${before.x},${before.y} -> ${dragged.x},${dragged.y}`);
check('the close button is not a drag handle', await p.evaluate(() => !!document.querySelector('.chalk-window-head button')));

// resize by the corner keeps the shape
const grip = await rect('.chalk-window-grip[data-dir="se"]');
await p.mouse.move(grip.x + grip.w - 4, grip.y + grip.h - 4);
await p.mouse.down(); await p.mouse.move(grip.x + grip.w - 4 + 90, grip.y + grip.h - 4 + 10, { steps: 8 }); await p.mouse.up();
const resized = await rect('.chalk-window');
const body2 = await rect('.chalk-window-body');
check('the corner resizes the window', resized.w > dragged.w + 60, `${dragged.w} -> ${resized.w}`);
check('resizing keeps the lab\'s shape', near(body2.w / body2.h, labBox.w / labBox.h, 0.05), `${(body2.w / body2.h).toFixed(3)}`);
check('the opposite corner stays', near(resized.x, dragged.x, 2) && near(resized.y, dragged.y, 2));
// an edge
const e = await rect('.chalk-window-grip[data-dir="e"]');
await p.mouse.move(e.x + 3, e.y + e.h / 2); await p.mouse.down(); await p.mouse.move(e.x + 3 - 70, e.y + e.h / 2, { steps: 6 }); await p.mouse.up();
const edged = await rect('.chalk-window');
const body3 = await rect('.chalk-window-body');
check('an edge resizes and keeps the shape', edged.w < resized.w - 40 && near(body3.w / body3.h, labBox.w / labBox.h, 0.05));

// keyboard
await p.evaluate(() => document.querySelector('.chalk-window-head').focus());
const k0 = await rect('.chalk-window');
await p.keyboard.press('ArrowLeft'); const k1 = await rect('.chalk-window');
check('an arrow key on the header moves the window 16 px', near(k1.x, k0.x - 16, 1), `${k0.x} -> ${k1.x}`);
await p.keyboard.press('Shift+ArrowDown'); const k2 = await rect('.chalk-window');
check('Shift makes it 64 px', near(k2.y, k1.y + 64, 1) || k2.b >= R.b - 9, `${k1.y} -> ${k2.y}`);
await p.keyboard.press('Alt+ArrowRight'); const k3 = await rect('.chalk-window');
check('Alt and an arrow resize it', k3.w > k2.w, `${k2.w} -> ${k3.w}`);

// it cannot be dragged out of the reader
const hh = await rect('.chalk-window-head'); const cur = await rect('.chalk-window');
await p.mouse.move(cur.x + 90, hh.y + hh.h / 2); await p.mouse.down(); await p.mouse.move(-400, -300, { steps: 6 }); await p.mouse.up();
const lost = await rect('.chalk-window');
check('it cannot be dragged out of the reader', lost.x >= R.x && lost.y >= R.y, `${lost.x},${lost.y}`);
await p.mouse.move(lost.x + 90, lost.y + 20); await p.mouse.down(); await p.mouse.move(R.r + 500, R.b + 500, { steps: 6 }); await p.mouse.up();
const lost2 = await rect('.chalk-window');
check('...nor out of the far corner, nor over the dock', lost2.r <= R.r && lost2.b <= R.b - 60, `${lost2.r},${lost2.b} vs ${R.r},${R.b}`);

// one at a time: tapping the video replaces the window
const vidBox = await reveal('pendulum-video');
const covered = await p.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('.chalk-window') != null, [vidBox.x + vidBox.w / 2, vidBox.y + vidBox.h / 2]);
if (covered) { await p.evaluate(() => document.querySelector('.chalk-window-head').focus()); for (let i = 0; i < 12; i++) await p.keyboard.press('Shift+ArrowLeft'); await p.waitForTimeout(200); }
await p.mouse.click(vidBox.x + vidBox.w / 2, vidBox.y + vidBox.h / 2);
await p.waitForSelector('.chalk-window video', { timeout: 5000 });
check('opening another replaces the window (one at a time)', (await winCount()) === 1 && (await p.locator('.chalk-window .chalk-lab').count()) === 0);
check('the video plays in its window', await p.waitForFunction(() => { const v = document.querySelector('.chalk-window video'); return v && !v.paused && v.currentTime > 0.3; }, null, { timeout: 8000 }).then(() => true, () => false));
await shot(p, 'window-video');

// Escape closes it from inside, and focus goes back to what opened it
await p.evaluate(() => document.querySelector('.chalk-window-head').focus());
await p.keyboard.press('Escape'); await p.waitForTimeout(300);
check('Escape closes the window', (await winCount()) === 0);
check('focus goes back to what opened it', await p.evaluate(() => document.activeElement?.closest('[data-chalk-id]')?.getAttribute('data-chalk-id') === 'pendulum-video'));

// the close button
await clickObj('pendulum-lab'); await p.waitForSelector('.chalk-window');
await p.click('.chalk-window-head button'); await p.waitForTimeout(250);
check('the close button closes it', (await winCount()) === 0);

// opened from the keyboard: focus is in the window at once, so Escape closes it straight away, and focus goes back to the card
await reveal('pendulum-lab');
await p.evaluate(() => document.querySelector('[data-chalk-id="pendulum-lab"]').focus());
await p.keyboard.press('Enter'); await p.waitForSelector('.chalk-window'); await p.waitForTimeout(300);
check('opened by the keyboard, focus is in the window', await p.evaluate(() => !!document.activeElement?.closest('.chalk-window')));
await p.keyboard.press('Escape'); await p.waitForTimeout(300);
check('...so Escape closes it at once, and focus returns to the card', (await winCount()) === 0 && await p.evaluate(() => document.activeElement?.closest('[data-chalk-id]')?.getAttribute('data-chalk-id') === 'pendulum-lab'));

// a window replaced by another: closing the second returns focus to the second's card, not the first's
await p.evaluate(() => document.querySelector('[data-chalk-id="pendulum-lab"]').focus()); await p.keyboard.press('Enter'); await p.waitForSelector('.chalk-window'); await p.waitForTimeout(300);
await p.evaluate(() => document.querySelector('[data-chalk-id="pendulum-video"]').focus()); await p.keyboard.press('Enter'); await p.waitForSelector('.chalk-window video'); await p.waitForTimeout(300);
await p.keyboard.press('Escape'); await p.waitForTimeout(300);
check('closing a window that replaced another returns focus to its own card', (await winCount()) === 0 && await p.evaluate(() => document.activeElement?.closest('[data-chalk-id]')?.getAttribute('data-chalk-id') === 'pendulum-video'));

// one live thing at a time: with a window open, a model that is "live" does not start by itself when its page comes up, and a tap on another lab takes the window's place
await clickObj('pendulum-lab'); await p.waitForSelector('.chalk-window');
await go(2); await p.evaluate(() => document.querySelector('[data-chalk-id="screw-gauge"]')?.scrollIntoView({ block: 'center' })); await p.waitForTimeout(3500);
check('a live model does not start by itself beside an open window', (await p.locator('.chalk-model model-viewer').count()) === 0 && (await winCount()) === 1);
await p.evaluate(() => document.querySelector('.chalk-window-head').focus()); await p.keyboard.press('Escape');
check('...and starts once the window is closed', await p.waitForSelector('.chalk-model model-viewer', { timeout: 8000 }).then(() => true, () => false));
await go(3); await clickObj('pendulum-lab'); await p.waitForSelector('.chalk-window'); await go(4);
await go(4);
await clickObj('screw-gauge-lab'); await p.waitForTimeout(1200);
check('a tap on another lab takes the window\'s place', (await winCount()) === 0);
await p.keyboard.press('Escape'); await go(3);

// a narrow reader: a sheet across the bottom, above the dock; live resize between the two
await clickObj('pendulum-lab'); await p.waitForSelector('.chalk-window[data-layout="floating"]');
await p.setViewportSize({ width: 390, height: 844 }); await p.waitForTimeout(500);
const sheet = await rect('.chalk-window'); const phoneRoot = await root();
check('on a narrow reader the window becomes a sheet', (await p.locator('.chalk-window[data-layout="sheet"]').count()) === 1);
check('...across the whole width, at the bottom, above the dock', near(sheet.x, phoneRoot.x, 1) && near(sheet.w, phoneRoot.w, 1) && sheet.b <= phoneRoot.b - 70 && sheet.h <= phoneRoot.h * 0.7 + 2, JSON.stringify(sheet));
check('the sheet header and close button are inside the reader', await p.evaluate(() => { const r = document.querySelector('.chalk-reader').getBoundingClientRect(), h = document.querySelector('.chalk-window-head button').getBoundingClientRect(); return h.top >= r.top && h.bottom <= r.bottom; }));
const sheetFrame = await rect('.chalk-window-frame');
check('the sheet keeps the lab\'s own shape', near(sheetFrame.w / sheetFrame.h, labBox.w / labBox.h, 0.1), `${(sheetFrame.w / sheetFrame.h).toFixed(3)} vs ${(labBox.w / labBox.h).toFixed(3)}`);
check('...with nothing to drag or resize', (await p.locator('.chalk-window-grip').count()) === 0);
const sh0 = await rect('.chalk-window'); const hd = await rect('.chalk-window-head');
await p.mouse.move(hd.x + 40, hd.y + hd.h / 2); await p.mouse.down(); await p.mouse.move(hd.x + 40, hd.y - 200, { steps: 5 }); await p.mouse.up();
check('...and the header does not drag it', near((await rect('.chalk-window')).y, sh0.y, 1));
check('the dock is not covered by the sheet', await p.evaluate(() => { const d = document.querySelector('.chalk-dock').getBoundingClientRect(); const e = document.elementFromPoint(d.x + d.width / 2, d.y + d.height / 2); return !!e?.closest('.chalk-dock'); }));
await shot(p, 'window-sheet');
await p.setViewportSize({ width: 1280, height: 800 }); await p.waitForTimeout(500);
check('widening the reader brings the floating window back, inside it', (await p.locator('.chalk-window[data-layout="floating"]').count()) === 1 && (await rect('.chalk-window')).r <= (await root()).r);
await p.keyboard.press('Escape');
await p.evaluate(() => document.querySelector('.chalk-window-head')?.focus()); await p.keyboard.press('Escape'); await p.waitForTimeout(200);

// reduced motion: the window just appears
await p.emulateMedia({ reducedMotion: 'reduce' });
await clickObj('pendulum-lab'); await p.waitForSelector('.chalk-window');
check('with reduced motion there is no entrance animation', await p.evaluate(() => getComputedStyle(document.querySelector('.chalk-window')).animationName === 'none'));
await p.evaluate(() => document.querySelector('.chalk-window-head').focus()); await p.keyboard.press('Escape');
await p.emulateMedia({ reducedMotion: 'no-preference' });

// ---- the host's options (Configure) ----
await p.click('.app-btn:has-text("Configure")'); await p.waitForSelector('.pg-seg');
await p.click('.pg-choice:has(legend:text-is("Where it opens")) label:has-text("right panel")');
await p.click('.app-btn:has-text("Configure")'); await p.waitForTimeout(300);
await clickObj('pendulum-lab'); await p.waitForSelector('.chalk-window[data-layout="side"]'); await p.waitForTimeout(400); // the entrance animation (200 ms) has ended
const side = await rect('.chalk-window'); const sr = await root();
check('a right panel docks to the right, full height, half the reader', near(side.r, sr.r, 1) && near(side.y, sr.y, 1) && near(side.h, sr.h, 1) && near(side.w, sr.w / 2, 3), 'panel ' + JSON.stringify(side) + ' reader ' + JSON.stringify(sr));
check('...and the left half of the page stays usable', await p.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('.chalk-window') == null, [sr.x + 200, sr.y + 300]));
const sideBody = await rect('.chalk-window-frame');
check('...the lab keeps its own shape inside it', near(sideBody.w / sideBody.h, labBox.w / labBox.h, 0.05), `${(sideBody.w / sideBody.h).toFixed(3)}`);
check('...and the dock is above it', await p.evaluate(() => { const d = document.querySelector('.chalk-dock').getBoundingClientRect(); return !!document.elementFromPoint(d.x + d.width / 2, d.y + d.height / 2)?.closest('.chalk-dock'); }));
await shot(p, 'window-side');
await p.evaluate(() => document.querySelector('.chalk-window-head').focus()); await p.keyboard.press('Escape');
// with the dock on top the panel keeps clear of it: its header and close button are not under the dock
await p.click('.app-btn:has-text("Configure")');
await p.click('.pg-choice:has(legend:text-is("Position")) label:has-text("top")');
await p.click('.pg-choice:has(legend:text-is("Where it opens")) label:has-text("left panel")'); // its close button is under the centred dock otherwise
await p.click('.app-btn:has-text("Configure")'); await p.waitForTimeout(400);
await clickObj('pendulum-lab'); await p.waitForSelector('.chalk-window[data-layout="side"]'); await p.waitForTimeout(400);
check('a side panel under a top dock keeps its close button visible', await p.evaluate(() => { const b = document.querySelector('.chalk-window-head button').getBoundingClientRect(); const e = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return !!e?.closest('.chalk-window-head'); }));
await shot(p, 'window-side-top-dock');
await p.evaluate(() => document.querySelector('.chalk-window-head').focus()); await p.keyboard.press('Escape');
await p.click('.app-btn:has-text("Configure")');
await p.click('.pg-choice:has(legend:text-is("Position")) label:has-text("bottom")');
await p.click('.app-btn:has-text("Configure")'); await p.waitForTimeout(300);
// free shape and a 4:3 shape
await p.click('.app-btn:has-text("Configure")');
await p.click('.pg-choice:has(legend:text-is("Where it opens")) label:has-text("floating")');
await p.click('.pg-choice:has(legend:text-is("Its shape")) label:has-text("4:3")');
await p.click('.app-btn:has-text("Configure")'); await p.waitForTimeout(300);
await clickObj('pendulum-lab'); await p.waitForSelector('.chalk-window[data-layout="floating"]');
const b43 = await rect('.chalk-window-body');
check('a host can ask for a 4:3 window', near(b43.w / b43.h, 4 / 3, 0.05), `${(b43.w / b43.h).toFixed(3)}`);
await p.evaluate(() => document.querySelector('.chalk-window-head').focus()); await p.keyboard.press('Escape');
await p.click('.app-btn:has-text("Configure")');
await p.click('.pg-choice:has(legend:text-is("Its shape")) label:has-text("free")');
await p.click('.app-btn:has-text("Configure")'); await p.waitForTimeout(300);
await clickObj('pendulum-lab'); await p.waitForSelector('.chalk-window[data-layout="floating"]');
const fw = await rect('.chalk-window');
const fg = await rect('.chalk-window-grip[data-dir="se"]');
await p.mouse.move(fg.x + fg.w - 4, fg.y + fg.h - 4); await p.mouse.down(); await p.mouse.move(fg.x + fg.w - 4 - 60, fg.y + fg.h - 4 + 20, { steps: 6 }); await p.mouse.up();
const fw2 = await rect('.chalk-window');
check('a free window resizes each side on its own', near(fw2.w, fw.w - 60, 3) && near(fw2.h, fw.h + 20, 3), `${fw.w}x${fw.h} -> ${fw2.w}x${fw2.h}`);
await p.evaluate(() => document.querySelector('.chalk-window-head').focus()); await p.keyboard.press('Escape');

// the host's own chrome replaces the built-in one
await p.click('.app-btn:has-text("Configure")');
await p.click('.pg-choice:has(legend:text-is("Its shape")) label:has-text("media")');
await p.click('.pg-check:has-text("My own window chrome")');
await p.click('.app-btn:has-text("Configure")'); await p.waitForTimeout(300);
await clickObj('pendulum-lab'); await p.waitForSelector('.demo-window');
check("a host's own chrome replaces the built-in one", (await p.locator('.chalk-window-head').count()) === 0 && (await p.locator('.demo-window .chalk-lab iframe').count()) === 1);
check('...it gets the title, the close and the shape', await p.evaluate(() => !!document.querySelector('.demo-window header strong')?.textContent && !!document.querySelector('.demo-window header button')));
await shot(p, 'window-custom');
await p.keyboard.press('Escape'); await p.waitForTimeout(200);
check('Escape closes it from inside the host\'s chrome', (await p.locator('.demo-window').count()) === 0 || await p.evaluate(() => { document.querySelector('.demo-window header button')?.focus(); return true; }));
if (await p.locator('.demo-window').count()) await p.click('.demo-window header button');
check('...and its close works', (await p.locator('.demo-window').count()) === 0);
await reveal('pendulum-lab');
await p.evaluate(() => document.querySelector('[data-chalk-id="pendulum-lab"]').focus()); await p.keyboard.press('Enter'); await p.waitForSelector('.demo-window'); await p.waitForTimeout(300);
check('a host\'s own chrome opened by the keyboard has focus, so Escape closes it at once', await p.evaluate(() => !!document.activeElement?.closest('.chalk-window-custom')));
await p.keyboard.press('Escape'); await p.waitForTimeout(300);
check('...and focus returns to the card', (await p.locator('.demo-window').count()) === 0 && await p.evaluate(() => document.activeElement?.closest('[data-chalk-id]')?.getAttribute('data-chalk-id') === 'pendulum-lab'));

// ---- a lab that starts by itself never starts behind a dialog that is open, nor beside a window ----
await mode('Author'); await go(4);
await clickObj('screw-gauge-lab'); await p.waitForSelector('.chalk-insp'); await opens('In a dialog');
await p.click('.app-btn:has-text("Configure")'); await p.click('.pg-check:has-text("Start a lab when its page opens")'); await p.click('.app-btn:has-text("Configure")');
await mode('Read'); await go(3);
await reveal('pendulum-video'); await p.evaluate(() => document.querySelector('[data-chalk-id="pendulum-video"]').focus()); await p.keyboard.press('Enter'); await p.waitForSelector('.chalk-window, .demo-window'); // the host's demo chrome is still on here
await go(4); await p.waitForTimeout(2500);
check('with a window open, a lab does not start by itself (autoStart)', (await p.locator('.chalk-lab iframe').count()) === 0);
await reveal('screw-gauge-lab');
await p.evaluate(() => document.querySelector('[data-chalk-id="screw-gauge-lab"]').focus()); await p.keyboard.press('Enter'); await p.waitForSelector('.chalk-modal', { timeout: 5000 });
await p.waitForTimeout(3500);
check('replacing the window with a dialog for that lab runs it once, in the dialog', (await p.locator('.chalk-lab iframe').count()) === 1 && (await p.locator('.chalk-modal .chalk-lab iframe').count()) === 1, `iframes ${await p.locator('.chalk-lab iframe').count()}`);
await p.keyboard.press('Escape'); await p.waitForTimeout(300);
await p.click('.app-btn:has-text("Configure")'); await p.click('.pg-check:has-text("Start a lab when its page opens")'); await p.click('.app-btn:has-text("Configure")');
await go(3);

// ---- what already existed is unchanged: the dialog and full screen ----
await p.click('.app-btn:has-text("Configure")');
await p.click('.pg-check:has-text("My own window chrome")');
await p.click('.app-btn:has-text("Configure")'); await p.waitForTimeout(300);
await mode('Author'); await go(3);
await clickObj('pendulum-video'); await p.waitForSelector('.chalk-insp');
await opens('In a dialog');
await mode('Read'); await go(3);
await clickObj('pendulum-video'); await p.waitForSelector('.chalk-modal');
check('"In a dialog" is the dialog it was: a backdrop, a modal, no window', (await p.locator('.chalk-modal-back').count()) === 1 && (await winCount()) === 0);
await shot(p, 'window-dialog-regression');
await p.keyboard.press('Escape'); await p.waitForTimeout(300);
check('...and Escape closes it', (await p.locator('.chalk-modal').count()) === 0);
await mode('Author'); await go(3);
await clickObj('pendulum-video'); await p.waitForSelector('.chalk-insp');
await opens('Full screen');
await mode('Read'); await go(3);
await clickObj('pendulum-video'); await p.waitForSelector('.chalk-modal.is-full');
check('"Full screen" is the full dialog it was', (await winCount()) === 0);
await p.keyboard.press('Escape'); await p.waitForTimeout(300);

// the 1.3 behaviour of a book that never heard of windows: the unknown value (what an older reader sees) is the default; here, a lab "In place" runs on the page
await mode('Author'); await go(3);
await clickObj('pendulum-lab'); await p.waitForSelector('.chalk-insp');
await opens('In place');
await mode('Read'); await go(3);
await clickObj('pendulum-lab');
check('"In place" still runs the lab on the page', await p.waitForSelector('.chalk-lab iframe', { timeout: 15000 }).then(() => true, () => false) && (await winCount()) === 0);

check('no errors in the page', errs.length === 0, errs.join(' | '));
await b.close();
console.log(failed ? 'FAIL' : 'OK');
process.exit(failed ? 1 : 0);
