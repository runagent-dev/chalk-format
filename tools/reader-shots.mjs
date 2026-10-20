// Screenshots of the reader showcase for visual checks.
//
//   node tools/reader-shots.mjs <outDir> [url] [--steps steps.json]
//
// Shoots desktop (1280×800) and phone (390×844, touch) views of the page, after an optional list of steps
// ({ name, waitFor?, eval?: "js run in the page", click?: "selector", drag?: [[x, y], …] (viewport px; on phone a finger),
// tap?: [x, y], key?: "Control+z", wait?: ms }), one PNG per step and viewport. Coordinates in desktop px are scaled for phone.
// Prints page errors. Uses the Chromium that Playwright has installed (npx playwright install chromium).
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2), si = args.indexOf('--steps');
const steps = si >= 0 ? JSON.parse(fs.readFileSync(args.splice(si, 2)[1], 'utf8')) : [{ name: 'start', wait: 1500 }];
const [OUT, URL = 'http://localhost:5190/'] = args;
fs.mkdirSync(OUT, { recursive: true });
const b = await chromium.launch();
for (const [vp, opts] of [['desktop', { viewport: { width: 1280, height: 800 } }], ['phone', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }]]) {
  const p = await b.newPage(opts);
  const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
  await p.goto(URL, { waitUntil: 'networkidle' });
  for (const s of steps) {
    if (s.waitFor) await p.waitForSelector(s.waitFor, { timeout: 30000 });
    if (s.select) await p.selectOption(s.select[0], s.select[1]);
    if (s.click) await p.click(s.click);
    if (s.eval) await p.evaluate(s.eval);   // before any pointer input, which may close what it opened
    const k = vp === 'phone' ? 390 / 1280 : 1, pt = ([x, y]) => [x * k, y * (vp === 'phone' ? 844 / 800 : 1)];
    if (s.drag) { const [x0, y0] = pt(s.drag[0]); await p.mouse.move(x0, y0); await p.mouse.down(); for (const q of s.drag.slice(1)) { const [x, y] = pt(q); await p.mouse.move(x, y, { steps: 6 }); } await p.mouse.up(); }
    if (s.tap) { const [x, y] = pt(s.tap); await p.mouse.click(x, y); }
    if (s.type) await p.keyboard.type(s.type);
    if (s.key) await p.keyboard.press(s.key);
    await p.waitForTimeout(s.wait ?? 600);
    await p.screenshot({ path: path.join(OUT, `${s.name}-${vp}.png`) });
  }
  console.log(vp, errs.length ? 'ERRORS: ' + errs.join(' | ') : 'no errors');
  await p.close();
}
await b.close();
