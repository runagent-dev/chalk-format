// Author mode's right-click menu: right-click on a page, pick what to add, the sidebar opens its picker, and what is added lands where the
// author clicked (the + button still places in the middle of the page). Real mouse and keyboard input, in the showcase.
//
//   node tools/reader-insert-menu-e2e.mjs [url]     (default http://localhost:5190/; the showcase must be running)
//
// Desktop only: touch has no right button (Android fires the same `contextmenu` on a long press).
import { deflateSync } from 'node:zlib';
import { chromium } from 'playwright-core';

const URL = process.argv[2] ?? 'http://localhost:5190/';

// a small valid PNG to add (240 x 160), made here so the test needs no files
function png(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const t = Buffer.from(type), len = Buffer.alloc(4), sum = Buffer.alloc(4);
    len.writeUInt32BE(data.length); sum.writeUInt32BE(crc(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, sum]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * (w * 3 + 1); raw[i] = 0; raw.set([30 + (x * 80) / w, 120, 150 + (y * 90) / h], i + 1 + x * 3); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => { if (m.type() === 'error' && !/CORS|ERR_FAILED/.test(m.text())) errs.push(m.text().slice(0, 160)); });
await p.goto(URL);
await p.waitForSelector('.chalk-dock-page');
await p.click('.app-mode button[role=radio]:has-text("Author")');
await p.waitForSelector('.chalk-surface.chalk-author', { timeout: 15000 });
await p.waitForTimeout(1500);

const r = {};
const surface = p.locator('.chalk-surface.chalk-author').first();
const pageBox = await surface.boundingBox();
const at = { x: Math.round(pageBox.x + pageBox.width * 0.5), y: Math.round(pageBox.y + pageBox.height * 0.35) };
const menu = p.locator('.chalk-insert-menu');
const items = () => p.locator('.chalk-insert-menu [role=menuitem]').allInnerTexts();
// a file into whatever the sidebar offers: the gallery's "Upload new", or the plain "Choose file"
const addFile = async (name) => {
  const buffer = png(240, 160), file = { name, mimeType: 'image/png', buffer };
  const gallery = p.locator('.chalk-gallery-upload input[type=file]');
  if (await gallery.count()) { await gallery.setInputFiles(file); return; }
  const [chooser] = await Promise.all([p.waitForEvent('filechooser'), p.click('button:has-text("Choose file")')]);
  await chooser.setFiles(file);
};
// what was just added is selected, and the editor outlines it: the middle of that outline is the middle of the new object
const placedAt = async () => {
  for (let i = 0; i < 40; i++) {
    const bb = await p.locator('.chalk-author-sel').first().boundingBox().catch(() => null);
    if (bb) return { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 };
    await p.waitForTimeout(250);
  }
  return null;
};

// 1. nothing on a page before the click, and a right-click on the rail or the sidebar leaves the browser's own menu alone
await p.click('.chalk-rail', { button: 'right', position: { x: 4, y: 4 } }).catch(() => {});
r.menuOnRail = await menu.count();

// 2. right-click on the page: a menu of the five kinds of media, inside the reader, with focus on the first
await p.mouse.click(at.x, at.y, { button: 'right' });
await menu.waitFor({ timeout: 3000 });
r.items = await items();
r.title = await p.locator('.chalk-insert-menu-title').innerText();
const mb = await menu.boundingBox(), rb = await p.locator('.chalk-reader').boundingBox();
r.insideReader = mb.x >= rb.x && mb.y >= rb.y && mb.x + mb.width <= rb.x + rb.width && mb.y + mb.height <= rb.y + rb.height;
r.opensAtPointer = Math.abs(mb.x - at.x) < 6 && Math.abs(mb.y - at.y) < 6;
r.firstFocused = await p.evaluate(() => document.activeElement?.getAttribute('role') === 'menuitem' && document.activeElement === document.querySelector('.chalk-insert-menu [role=menuitem]'));

// 3. the keyboard: arrows move between items, Escape closes
await p.keyboard.press('ArrowDown');
r.arrowMoves = await p.evaluate(() => document.activeElement?.textContent?.trim());
await p.keyboard.press('Escape');
r.escapeCloses = (await menu.count()) === 0;

// 4. a click elsewhere closes it; so does scrolling
await p.mouse.click(at.x, at.y, { button: 'right' });
await menu.waitFor({ timeout: 3000 });
await p.mouse.click(rb.x + 4, rb.y + rb.height - 4);
r.clickAwayCloses = (await menu.count()) === 0;
await p.mouse.click(at.x, at.y, { button: 'right' });
await menu.waitFor({ timeout: 3000 });
await p.mouse.wheel(0, 200); await p.waitForTimeout(300);
r.scrollCloses = (await menu.count()) === 0;
await p.mouse.wheel(0, -200); await p.waitForTimeout(300);

// 5. near the bottom right of the page it flips up and stays inside the reader
await p.mouse.click(Math.round(pageBox.x + pageBox.width - 20), rb.y + rb.height - 30, { button: 'right' });   // the bottom right of the page (the corner of the reader is the sidebar)
await menu.waitFor({ timeout: 3000 });
const cb = await menu.boundingBox();
r.cornerInside = cb.x >= rb.x && cb.y >= rb.y && cb.x + cb.width <= rb.x + rb.width + 0.5 && cb.y + cb.height <= rb.y + rb.height + 0.5;
await p.keyboard.press('Escape');

// 6. with a drawing tool active it opens too, and a right-click draws nothing
await p.keyboard.press('p');
await p.mouse.click(at.x, at.y, { button: 'right' });
await menu.waitFor({ timeout: 3000 });
r.worksWithPen = true;
await p.keyboard.press('Escape');

// 7. pick Image: the sidebar opens its picker, a mark shows where it will go, and an added file lands there
await p.mouse.click(at.x, at.y, { button: 'right' });
await menu.waitFor({ timeout: 3000 });
await p.locator('.chalk-insert-menu [role=menuitem]', { hasText: 'Image' }).click();
await p.waitForSelector('text=/Add media: Image/', { timeout: 5000 });
r.menuGone = (await menu.count()) === 0;
r.drawer = await p.locator('text=/Add media: Image/').count() > 0;
r.focusInSidebar = await p.evaluate(() => !!document.activeElement?.closest('.chalk-sidebar'));   // focus moved on to the picker
r.markerShown = await p.locator('.chalk-author-target').count();
const tb = await p.locator('.chalk-author-target').first().boundingBox().catch(() => null);
r.markerAtPoint = !!tb && Math.abs(tb.x - at.x) < 4 && Math.abs(tb.y - at.y) < 4;
await addFile('right-click.png');
const placed = await placedAt();
r.placedNearClick = !!placed && Math.abs(placed.x - at.x) <= 4 && Math.abs(placed.y - at.y) <= 4;
r.placedAt = placed && { dx: Math.round(placed.x - at.x), dy: Math.round(placed.y - at.y) };
r.markerGone = (await p.locator('.chalk-author-target').count()) === 0;

// 8. the + button is unchanged: no mark, and the file goes to the middle of the current page
await p.keyboard.press('Escape');
await p.click('button.chalk-rail-btn.is-add');
await p.locator('.chalk-rail-item', { hasText: 'Image' }).click();
await p.waitForSelector('text=/Add media: Image/', { timeout: 5000 });
r.noMarkerForPlus = (await p.locator('.chalk-author-target').count()) === 0;
await addFile('plus.png');
const mid = await placedAt();
const pb = await surface.boundingBox();
r.plusNearMiddle = !!mid && Math.abs(mid.x - (pb.x + pb.width / 2)) <= 6 && Math.abs(mid.y - (pb.y + pb.height / 2)) <= 6;

// 8b. Space presses an item (it is not the reader's "next page"), and turning the page forgets the spot: the file goes to the middle of
// the page in view, not to the page the author left
await p.keyboard.press('Escape');
await p.mouse.click(at.x, at.y, { button: 'right' });
await menu.waitFor({ timeout: 3000 });
await p.keyboard.press(' ');
r.spacePicks = await p.locator('text=/Add media: Image/').waitFor({ timeout: 3000 }).then(() => true, () => false);
r.spaceMarker = (await p.locator('.chalk-author-target').count()) === 1;
const pageBefore = await p.locator('.chalk-dock-page').first().innerText();
await p.locator('.chalk-dock button[aria-label="পরের পৃষ্ঠা"], .chalk-dock button[aria-label="Next page"]').first().click(); await p.waitForTimeout(800);   // the dock's next page
r.turned = (await p.locator('.chalk-dock-page').first().innerText()) !== pageBefore;
r.turnForgets = (await p.locator('.chalk-author-target').count()) === 0;

// 8b'. a page turned with the menu open closes the menu (so the left page's spot cannot come back)
await p.keyboard.press('Escape');
await p.mouse.click(at.x, at.y, { button: 'right' });
await menu.waitFor({ timeout: 3000 });
const pageAtMenu = await p.locator('.chalk-dock-page').first().innerText();
await p.keyboard.press('PageDown'); await p.waitForTimeout(800);
r.menuTurned = (await p.locator('.chalk-dock-page').first().innerText()) !== pageAtMenu;
r.turnClosesMenu = (await menu.count()) === 0;
await p.locator('.chalk-dock button[aria-label="আগের পৃষ্ঠা"], .chalk-dock button[aria-label="Previous page"]').first().click(); await p.waitForTimeout(800);

// 8c. right-click in a text being typed keeps the browser's menu (cut, copy, paste) and does not end the typing
await p.keyboard.press('Escape');
await p.locator('.chalk-dock button[aria-label="আগের পৃষ্ঠা"], .chalk-dock button[aria-label="Previous page"]').first().click(); await p.waitForTimeout(800);
await p.keyboard.press('t');
await p.mouse.click(at.x, at.y + 80);
const field = p.locator('.chalk-surface textarea').first();
r.typing = await field.waitFor({ timeout: 3000 }).then(() => true, () => false);
if (r.typing) {
  await field.type('hello');
  const fb = await field.boundingBox();
  await p.mouse.click(fb.x + 10, fb.y + 8, { button: 'right' }); await p.waitForTimeout(400);
  r.textKeepsNative = (await menu.count()) === 0;
  r.textStillOpen = (await field.count()) === 1 && (await field.inputValue()) === 'hello';
  await p.keyboard.press('Escape');
}
await p.keyboard.press('v');

// 9. a host can turn the menu off (Configure: "Right-click menu to add media"): the browser's own menu stays; on again, the menu is back
await p.keyboard.press('Escape');
const configureMenu = async (on) => {
  await p.click('button.app-btn:has-text("Configure")'); await p.waitForSelector('.pg-choice', { timeout: 5000 });
  await p.locator('label.pg-check', { hasText: 'Right-click menu to add media' }).locator('input').setChecked(on);
  await p.click('button.app-btn:has-text("Configure")'); await p.waitForTimeout(500);
};
// whether the page left the event alone (a menu we draw calls preventDefault; with the switch off nothing may)
await p.evaluate(() => { window.__ctx = []; addEventListener('contextmenu', (e) => window.__ctx.push(e.defaultPrevented)); });
await configureMenu(false);
await p.mouse.click(at.x, at.y, { button: 'right' }); await p.waitForTimeout(600);
r.offNoMenu = (await menu.count()) === 0;
r.offKeepsNative = await p.evaluate(() => window.__ctx.at(-1) === false);
await configureMenu(true);
await p.mouse.click(at.x, at.y, { button: 'right' });
r.onAgain = await menu.waitFor({ timeout: 3000 }).then(() => true, () => false);
r.onPrevents = await p.evaluate(() => window.__ctx.at(-1) === true);
await p.keyboard.press('Escape');

await p.screenshot({ path: 'out/insert-menu-after.png' });
const ok =
  r.menuOnRail === 0
  && r.items.length === 5 && ['Image', 'Video', 'Sound', '3D model', 'Lab'].every((n, i) => r.items[i]?.trim() === n)
  && r.title === 'Add here' && r.insideReader && r.opensAtPointer && r.firstFocused
  && r.arrowMoves === 'Video' && r.escapeCloses && r.clickAwayCloses && r.scrollCloses && r.cornerInside && r.worksWithPen
  && r.menuGone && r.drawer && r.markerShown === 1 && r.markerAtPoint && r.placedNearClick && r.markerGone
  && r.noMarkerForPlus && r.plusNearMiddle
  && r.focusInSidebar && r.menuTurned && r.turnClosesMenu
  && r.spacePicks && r.spaceMarker && r.turned && r.turnForgets && r.typing && r.textKeepsNative && r.textStillOpen
  && r.offNoMenu && r.offKeepsNative && r.onAgain && r.onPrevents && !errs.length;
console.log(ok ? 'OK  ' : 'FAIL', JSON.stringify(r), errs.length ? 'errors: ' + errs.join(' | ') : '');
await b.close();
process.exit(ok ? 0 : 1);
