// Hide a scanned book's printed marks and let the reader number its pages (spec 1.9).
//
//   npx tsx tools/chalk-marks.ts <streamed-book-dir> <out-dir> [--hide '^ফর্মা'] [--hide '^২০[০-৯]{2}$'] [--sideways] [--no-numbers] [--dry]
//
// Reads every page's text layer and background, finds the printed page numbers (they become the page's number
// slot) and the margin lines matching --hide, and writes the book again with `hidden` areas and `numberSlot`s.
// The text file then leaves those runs out. Pages without a background picture are left alone.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { assembleStreamed, findPrintedMarks, publishStreamed } from '../packages/container/src/index.ts';

const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const hides: RegExp[] = [];
for (let i = 0; i < args.length; i++) if (args[i] === '--hide') hides.push(new RegExp(args[++i]!, 'u'));
const [from, to] = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--hide');
if (!from || !to) { console.error("usage: chalk-marks <book-dir> <out-dir> [--hide '<regexp>'] [--no-numbers] [--dry]"); process.exit(2); }

const { loadImage, createCanvas } = createRequire(join(import.meta.dirname, '../packages/convert-pdf/package.json'))('@napi-rs/canvas') as typeof import('@napi-rs/canvas');
const read = async (p: string) => new Uint8Array(readFileSync(join(from, p)));
const { lesson, assets, assetInfo, index } = await assembleStreamed(read);

let numbered = 0, areas = 0; const kinds = new Map<string, number>(); const without: number[] = [];
for (const [i, page] of lesson.pages.entries()) {
  const bg = page.background as { type: string; assetId?: string };
  const bytes = bg.type === 'image' && bg.assetId ? assets.get(bg.assetId)?.bytes : undefined;
  if (!bytes) continue;
  const img = await loadImage(Buffer.from(bytes));
  const c = createCanvas(img.width, img.height); const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const marks = findPrintedMarks(page, { width: img.width, height: img.height, data: g.getImageData(0, 0, img.width, img.height).data }, { numbers: !flag('--no-numbers'), sideways: flag('--sideways'), patterns: hides });
  delete page.hidden; delete page.numberSlot;
  if (marks.hidden.length) page.hidden = marks.hidden;
  if (marks.numberSlot) { page.numberSlot = marks.numberSlot; numbered++; } else without.push(i + 1);
  areas += marks.hidden.length;
  if (marks.found.filter((f) => f.kind === 'number').length > 1) console.log(`  page ${i + 1}: several numbers ${marks.found.filter((f) => f.kind === 'number').map((f) => f.text).join(' ')}`);
  for (const f of marks.found) kinds.set(f.kind === 'number' ? 'page number' : f.kind === 'sideways' ? 'sideways digits' : f.text.replace(/[0-9০-৯]+/gu, 'N'), (kinds.get(f.kind === 'number' ? 'page number' : f.kind === 'sideways' ? 'sideways digits' : f.text.replace(/[0-9০-৯]+/gu, 'N')) ?? 0) + 1);
}
console.log(`${lesson.pages.length} pages: ${areas} areas hidden, ${numbered} pages numbered`);
for (const [k, n] of kinds) console.log(`  ${n} × ${k}`);
console.log(`  no number slot: pages ${without.join(', ')}`);
if (flag('--dry')) process.exit(0);
const { files } = await publishStreamed(lesson, assets, { assetInfo, ...(index.assetSources ? { assetSources: index.assetSources } : {}) });
rmSync(to, { recursive: true, force: true });
for (const [p, b] of files) { mkdirSync(dirname(join(to, p)), { recursive: true }); writeFileSync(join(to, p), b); }
console.log(`${to}: written`);
