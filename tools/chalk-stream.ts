// Streamed books (spec 1.4): turn a .chalk into a directory a CDN can serve, and back.
//
//   npx tsx tools/chalk-stream.ts publish book.chalk out/physics-9/    a streamed book (book.json, pages/, assets/, text)
//   npx tsx tools/chalk-stream.ts pack out/physics-9/ book.chalk       the same book as a .chalk again
//
// Serve the directory as static files: every file but book.json is named by its content and can be cached for
// ever (Cache-Control: public, max-age=31536000, immutable); book.json is revalidated (no-cache + ETag).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assembleStreamed, packLesson, publishStreamed, unpackLesson } from '../packages/container/src/index.ts';

const [cmd, from, to] = process.argv.slice(2);
const kb = (n: number) => `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;

if (cmd === 'publish' && from && to) {
  const r = await unpackLesson(new Uint8Array(readFileSync(from)));
  const { files, index } = await publishStreamed(r.lesson, r.assets, { assetInfo: r.assetInfo, assetSources: r.assetSources });
  rmSync(to, { recursive: true, force: true });
  for (const [path, bytes] of files) { mkdirSync(dirname(join(to, path)), { recursive: true }); writeFileSync(join(to, path), bytes); }
  const total = [...files.values()].reduce((s, b) => s + b.byteLength, 0);
  const pageBytes = index.pages.map((p) => (p.bytes ?? 0) + (p.assetBytes ?? 0));
  console.log(`${to}: ${index.pages.length} pages, ${files.size} files, ${kb(total)} in all`);
  console.log(`  first view: book.json ${kb(files.get('book.json')!.byteLength)}; a page to draw ≈ ${kb(pageBytes.reduce((a, b) => a + b, 0) / pageBytes.length)} on average`);
} else if (cmd === 'pack' && from && to) {
  const { lesson, assets, assetInfo, index } = await assembleStreamed(async (p) => new Uint8Array(readFileSync(join(from, p))));
  writeFileSync(to, await packLesson(lesson, assets, { assetInfo, ...(index.assetSources ? { assetSources: index.assetSources } : {}) }));
  console.log(`${to}: ${lesson.pages.length} pages, ${assets.size} assets`);
} else {
  console.error('usage: chalk-stream publish <book.chalk> <out-dir>  |  chalk-stream pack <dir> <out.chalk>');
  process.exit(2);
}
