// A book that lives in a library (spec 1.8, "Books in a library"), opened in a real browser with nothing but the library. Publishes the
// streamed physics sample into a library as the contract's items (every media file, a page item per page, the text item, a links item
// pointing at a question, two book items: revision 1, then revision 2, both `state:current`), then opens it in the showcase with
// `?library=…&book=…` and checks: the newest current revision opens, pages are drawn, pictures come from the library's store, search reads
// the text item, the links reach the host. With `--read-token`, the library is expected to need a token for reading (PUBLIC_READ=false):
// without it the book does not open; with it, it does.
//
//   npx tsx tools/reader-library-book-e2e.ts <library-url> <write-token> [showcase-url] [--read-token <t>] [--shots <dir>]
//
// The library must accept the book media types (application/vnd.chalk.{book,page,text,links}+json). The showcase must be running
// (default http://localhost:5190/). Use a test library: this writes into it. Never point it at a production library.
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { resolutionKey, type StreamIndex, type StreamText } from '../packages/model/src/index.ts';
import { createRegistryClient, derivedUrl } from '../packages/store/src/index.ts';

const args = process.argv.slice(2);
const opt = (n: string) => { const i = args.indexOf(n); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
const READ_TOKEN = opt('--read-token');
const SHOTS = opt('--shots');
const [LIBRARY, WRITE_TOKEN, SHOWCASE = 'http://localhost:5190/'] = args;
if (!LIBRARY || !WRITE_TOKEN) { console.error('usage: reader-library-book-e2e.ts <library-url> <write-token> [showcase-url] [--read-token <t>] [--shots <dir>]'); process.exit(2); }
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

let failed = false;
const check = (name: string, ok: boolean, detail = '') => { if (!ok) failed = true; console.log(ok ? 'ok  ' : 'FAIL', name, detail); };

// ---- publish: the sample as library items, the book item last ----
const dir = path.join(import.meta.dirname, '../apps/reader/public/samples/showcase');
const index = JSON.parse(readFileSync(path.join(dir, 'book.json'), 'utf8')) as StreamIndex;
const slug = `e2e-physics-${Date.now().toString(36)}`;
const lib = createRegistryClient(LIBRARY, { token: WRITE_TOKEN });
// a book names no store that needs a token (spec 1.2 §4.4, 1.8 §3.1), and names at least one: the library's public delivery store. A
// library whose every store needs a token cannot hold a valid 1.8 book yet: say so before writing anything
const PUBLIC_STORES = (await lib.stores()).items.filter((d) => d.auth !== 'bearer');
if (!PUBLIC_STORES.length) { console.error('this library has no store that can be read without a token: a 1.8 book item must name one (spec 1.8 §3.1)'); process.exit(2); }

const enc = new TextEncoder();
const json = (v: unknown) => enc.encode(JSON.stringify(v));
const tags = (kind: string, revision: number) => ['origin:chalkbook', `book:${slug}`, `book-revision:${revision}`, `kind:${kind}`, 'state:current'];
const keys: string[] = [];
const add = async (bytes: Uint8Array, type: string, t: string[] = []) => { const r = await lib.add(bytes, { type, ...(t.length ? { tags: t } : {}) }); keys.push(r.key); return r.key; };

for (const a of index.assets) {
  // every asset is external in a library book; the sample's ids are content keys, so the library's key is the same asset
  const key = await add(readFileSync(path.join(dir, a.path!)), a.type);
  if (key !== resolutionKey(a.id)) throw new Error(`${a.id}: the library named it ${key}`);
}
const pageItems = new Map<string, string>();
const toItem = async (p: StreamIndex['pages'][number], revision: number) => {
  const key = await add(readFileSync(path.join(dir, p.file)), 'application/vnd.chalk.page+json', tags('page', revision));
  pageItems.set(key, p.id);
  const { file: _file, ...rest } = p;
  return { ...rest, key };
};
const textBytes = readFileSync(path.join(dir, index.text!.file));
const text = JSON.parse(new TextDecoder().decode(textBytes)) as StreamText;
const textKey = await add(textBytes, 'application/vnd.chalk.text+json', tags('text', 1));
// one question, and two sentences of the first two pages that it answers from
const question = await add(json({
  format: 'chalk.question', manifestVersion: 1, id: `org.example.${slug}.q1`, version: '1', kind: 'short_answer',
  stem: { bn: 'সরল দোলকের দোলনকাল কীসের উপর নির্ভর করে?', en: 'What does the period of a simple pendulum depend on?' },
}), 'application/vnd.chalk.question+json', ['kind:question']);
const sentences = index.pages.slice(0, 2).map((p, i) => {
  const run = text.pages[p.id]![2]!;
  const w = p.width ?? 1200, h = p.height ?? 1700;
  return { id: `${slug}-s${i + 1}`, page: i + 1, pageId: p.id, rects: [[run.x / w, (run.y - run.fontSize) / h, run.width / w, (run.fontSize * 1.2) / h]], text: run.text };
});

const publishBook = async (revision: number) => {
  const links = await add(json({ format: 'chalk-links', version: 1, book: slug, bookRevision: revision, sentences, links: sentences.map((s) => ({ sentence: s.id, question, role: 'answers_from' })) }), 'application/vnd.chalk.links+json', tags('links', revision));
  const { text: _text, ...rest } = index;
  const book = {
    ...rest,
    title: `${index.title} (revision ${revision})`,
    pages: await Promise.all(index.pages.map((p) => toItem(p, revision))),
    ...(index.snipPages ? { snipPages: await Promise.all(index.snipPages.map((p) => toItem(p, revision))) } : {}),
    text: { key: textKey, bytes: textBytes.byteLength },
    assets: index.assets.map(({ path: _path, ...a }) => a),
    assetSources: PUBLIC_STORES,
    links,
  };
  const key = await add(json(book), 'application/vnd.chalk.book+json', tags('book', revision));
  await lib.setBookAssets(slug, [...new Set(keys)]);
  return key;
};
const previous = await publishBook(1);
await new Promise((r) => setTimeout(r, 50));
const current = await publishBook(2);
console.log(`published ${slug}: ${new Set(keys).size} items, book item ${current}`);

// ---- open it in the browser ----
const store = (await lib.stores()).items[0]!;
const urlOf = (key: string) => derivedUrl(store, key);
const kindOf = new Map<string, string>([[urlOf(current), 'book'], [urlOf(previous), 'old-book'], [urlOf(textKey), 'text']]);
for (const [key] of pageItems) kindOf.set(urlOf(key), 'page');
for (const a of index.assets) kindOf.set(urlOf(resolutionKey(a.id)!), a.type);

const b = await chromium.launch();
const open = async (token: string | undefined) => {
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  const errors: string[] = []; p.on('pageerror', (e) => errors.push(e.message));
  const got: { kind: string; status: number }[] = [];
  p.on('response', (r) => { const kind = kindOf.get(r.url()); if (kind) got.push({ kind, status: r.status() }); });
  const q = new URLSearchParams({ library: LIBRARY, book: slug, ...(token ? { token } : {}) });
  await p.goto(`${SHOWCASE}?${q}`);
  return { p, errors, got };
};

if (READ_TOKEN) {
  const { p } = await open(undefined);
  await p.waitForSelector('.chalk-state.is-error', { timeout: 15000 }).catch(() => {});
  check('without a token, a private library does not open the book', !!(await p.$('.chalk-state.is-error')), (await p.textContent('.chalk-state'))?.trim());
  await p.close();
}

const { p, errors, got } = await open(READ_TOKEN);
await p.waitForFunction(() => document.querySelectorAll('.chalk-page').length > 0 && !document.querySelector('.chalk-state'), null, { timeout: 30000 }).catch(() => {});
await p.waitForTimeout(2000);
check('the book opens', !(await p.$('.chalk-state')), (await p.textContent('.chalk-state').catch(() => null)) ?? '');
check('the newest current revision opens, not the older one', got.some((g) => g.kind === 'book') && !got.some((g) => g.kind === 'old-book'));
check('the book item came from the library store', got.filter((g) => g.kind === 'book').every((g) => g.status === 200) && got.some((g) => g.kind === 'book'));
const pages = got.filter((g) => g.kind === 'page');
check('pages came from the library as page items', pages.length > 0 && pages.every((g) => g.status === 200), `${pages.length} of ${pageItems.size}`);
const images = got.filter((g) => g.kind.startsWith('image/'));
check('pictures came from the library store', images.length > 0 && images.every((g) => g.status === 200), `${images.length} pictures`);
const drawn = await p.evaluate((origin) => [...document.querySelectorAll<HTMLImageElement>('.chalk-page img')].filter((i) => i.src.startsWith(origin) && i.complete && i.naturalWidth > 0).length, new URL(urlOf(current)).origin);
check('the first page is drawn with a picture from the library', drawn > 0, `${drawn} drawn`);
const links = await p.evaluate(() => (window as unknown as { __bookLinks?: { bookRevision: number; sentences: { pageId: string }[]; links: { question: string }[] } }).__bookLinks ?? null);
check('the links item reaches the host', links?.bookRevision === 2 && links.sentences.length === 2 && links.links.every((l) => l.question === question), JSON.stringify(links?.sentences.map((s) => s.pageId)));
if (SHOTS) await p.screenshot({ path: `${SHOTS}/library-book${READ_TOKEN ? '-private' : ''}.png` });

// search: the text item, once
await p.click('.chalk-dock button[aria-label="খোঁজো"], .chalk-dock button[aria-label="Search"]');
await p.fill('.chalk-search input', 'দোলক');
await p.waitForTimeout(1500);
const hits = await p.evaluate(() => document.querySelectorAll('.chalk-results li').length);
check('search reads the text item and finds the word', got.some((g) => g.kind === 'text' && g.status === 200) && hits > 0, `${hits} hits`);
check('no errors in the page', errors.length === 0, errors.join(' | '));

await b.close();
console.log(failed ? '\nSOME CHECKS FAILED' : '\nall checks passed');
process.exit(failed ? 1 : 0);
