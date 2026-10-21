// Plays every medium in the showcase book with real input, the way a student does, and checks it runs.
//
//   node tools/reader-media-e2e.mjs [url]        (default http://localhost:5190/; the showcase must be running)
//
// Real clicks on desktop and real taps on a phone: Playwright only clicks an element that actually receives
// the pointer, so anything covering a button fails the run. (Scripted element.click() skips that check, which
// once hid a text layer covering every media card.) No autoplay flags: playback must come from the gesture.
import { chromium } from 'playwright-core';

const URL = process.argv[2] ?? 'http://localhost:5190/';
const b = await chromium.launch();
let failed = false;
for (const [name, opts] of [['desktop', { viewport: { width: 1280, height: 800 } }], ['phone', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }]]) {
  const p = await b.newPage(opts);
  const press = (sel, o) => (name === 'phone' ? p.tap(sel, o) : p.click(sel, o));
  const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)); });
  await p.goto(URL); await p.waitForSelector('.chalk-dock-page');
  const goPage = async (n) => { await p.click('.chalk-dock-page'); await p.fill('.chalk-dock-page input', String(n)); await p.press('.chalk-dock-page input', 'Enter'); await p.waitForTimeout(1200); };
  const t0 = Date.now(), r = {};
  await goPage(2);
  // the author made the model live (spec 1.3): it starts by itself where its box is big enough, else its card opens it
  // (once at least half of it is on screen: scroll to it the way a student would)
  await p.evaluate(() => document.querySelector('[data-chalk-id="screw-gauge"]')?.scrollIntoView({ block: 'center' }));
  const live = await p.waitForSelector('.chalk-model model-viewer', { timeout: 4000 }).then(() => true, () => false);
  if (!live) await press('button.chalk-card[aria-label="স্ক্রু গজ"]', { timeout: 5000 });
  await p.waitForFunction(() => document.querySelector('model-viewer')?.loaded === true, null, { timeout: 20000 }).then(() => (r.model3d = 'loaded'), () => (r.model3d = 'NOT loaded'));
  r.model3dWhere = await p.evaluate(() => (document.querySelector('.chalk-modal model-viewer') ? 'dialog (tapped)' : 'in the page (live)'));
  r.model3dRotates = await p.evaluate(() => document.querySelector('model-viewer')?.hasAttribute('auto-rotate'));
  await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  await goPage(3);
  await press('button.chalk-card[aria-label="সরল দোলকের দোলন"]', { timeout: 5000 });
  await p.waitForTimeout(2500);
  r.video = await p.evaluate(() => { const v = document.querySelector('.chalk-video video'); return v ? { playing: !v.paused, t: +v.currentTime.toFixed(1), loop: v.loop, muted: v.muted } : 'no video element'; });
  await p.evaluate(() => document.querySelector('.chalk-video video')?.pause());
  await press('button.chalk-card[aria-label*="ল্যাব"]', { timeout: 5000 });
  await p.waitForFunction(() => document.querySelector('.chalk-lab iframe') && !document.querySelector('.chalk-lab-wait'), null, { timeout: 15000 }).then(() => (r.lab = 'running'), () => (r.lab = 'NOT running'));
  r.labWhere = await p.evaluate(() => (document.querySelector('.chalk-modal.is-full .chalk-lab') ? 'full screen' : document.querySelector('.chalk-modal .chalk-lab') ? 'dialog' : 'in the page'));
  if (name === 'desktop') await p.screenshot({ path: `out/presentation-lab-${name}.png` });
  await p.keyboard.press('Escape'); await p.waitForTimeout(500);
  r.labClosed = await p.evaluate(() => !document.querySelector('.chalk-modal') && !document.fullscreenElement);
  await goPage(4);
  await p.keyboard.press('Escape');
  await press('.chalk-audio-play', { timeout: 5000 });
  // the sound comes out of the book first, which can take a moment on a cold server
  await p.waitForFunction(() => (document.querySelector('.chalk-audio audio')?.currentTime ?? 0) > 1, null, { timeout: 6000 }).catch(() => {});
  r.audio = await p.evaluate(() => { const a = document.querySelector('.chalk-audio audio'); return a ? { playing: !a.paused, t: +a.currentTime.toFixed(1) } : 'no audio element'; });
  // the author's icon marker: label as its name, and its accent colour
  r.marker = await p.evaluate(() => { const m = document.querySelector('.chalk-marker[aria-label="সুরশলাকা · ৪৪০ Hz"]'); return m ? getComputedStyle(m).backgroundColor : 'missing'; });
  const ok = r.model3d === 'loaded' && r.model3dRotates && r.video?.playing && r.video.t > 1 && r.video.loop && !r.video.muted && r.lab === 'running' && r.labWhere === 'full screen' && r.labClosed
    && r.audio?.playing && r.audio.t > 0.5 && r.marker === 'rgb(194, 98, 26)' && !errs.length;
  failed ||= !ok;
  console.log(name.padEnd(8), ok ? 'OK  ' : 'FAIL', JSON.stringify(r), errs.length ? 'errors: ' + errs.join(' | ') : '');
  await p.close();
}
await b.close();
process.exit(failed ? 1 : 0);
