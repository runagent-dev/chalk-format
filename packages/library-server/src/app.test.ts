import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkLibrary, createLibraryApp, diskStorage, openDb, scanStorage, tokenCallers, type Db } from './index.js';

// a whole library in this process: PGlite for Postgres, a temporary folder for the bucket, and a fetch that
// sends http://library.test/… to the app (uploads, the API and the delivery store all go through it)
const BASE = 'http://library.test';
let db: Db, dir: string, app: ReturnType<typeof createLibraryApp>;
const fetchApp = (async (input: RequestInfo | URL, init?: RequestInit) => app.fetch(new Request(input, init))) as typeof fetch;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'chalk-library-'));
  db = await openDb('pglite:');
  app = createLibraryApp({ db, storage: diskStorage(dir, { uploadBase: BASE }), publicUrl: `${BASE}/files/`, callers: tokenCallers('teacher:t-1,admin!:a-1') });
}, 60_000); // starting the in-memory database takes over vitest's 10 s default on a busy machine (every package's tests run at once in `pnpm check`)
afterAll(async () => { await db?.close(); rmSync(dir, { recursive: true, force: true }); });

describe('the reference library (disk + PGlite)', () => {
  it('passes the conformance checks of the registry API', async () => {
    const results = await checkLibrary(BASE, { token: 't-1', adminToken: 'a-1', fetch: fetchApp });
    const failed = results.filter((r) => !r.ok);
    expect(failed, JSON.stringify(failed, null, 1)).toEqual([]);
    expect(results.length).toBeGreaterThanOrEqual(15);
  });

  it('delivers files cacheable for ever, with ranges for video, never as a web page', async () => {
    const { registryLibrary } = await import('@chalk-format/store');
    const lib = registryLibrary({ url: BASE, token: 't-1', fetch: fetchApp });
    const item = await lib.put!({ bytes: new TextEncoder().encode('<!doctype html><p>a lab</p>'), type: 'text/html', title: 'lab' });
    const url = (await lib.url(item.key))!;
    const r = await fetchApp(url);
    expect(r.headers.get('cache-control')).toContain('immutable');
    expect(r.headers.get('content-type')).toBe('application/octet-stream');
    expect(r.headers.get('content-security-policy')).toBe('sandbox');
    const part = await fetchApp(url, { headers: { Range: 'bytes=2-8' } });
    expect(part.status).toBe(206);
    expect(await part.text()).toBe('doctype');
  });

  it('refuses types it does not take, and sizes over the limit', async () => {
    const post = (b: object) => fetchApp(`${BASE}/v1/uploads`, { method: 'POST', headers: { Authorization: 'Bearer t-1', 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    const { assetKeyAndSha256 } = await import('@chalk-format/model');
    const k = await assetKeyAndSha256(new TextEncoder().encode('x'));
    expect((await post({ ...k, type: 'application/x-msdownload', size: 1 })).status).toBe(415);
    expect((await post({ ...k, type: 'video/mp4', size: 10 * 1024 * 1024 * 1024 })).status).toBe(413);
  });

  it('keeps question manifests: found by their tags, their type and their code, and delivered as they were published', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { createRegistryClient } = await import('@chalk-format/store');
    const { QUESTION_MANIFEST_TYPE, questionManifestSchema, questionRegistryTags } = await import('@chalk-format/model');
    const examples = new URL('../../../examples/questions/', import.meta.url);
    const client = createRegistryClient(BASE, { token: 't-1', fetch: fetchApp });
    const published: Record<string, string> = {};
    for (const f of readdirSync(examples).filter((x) => x.endsWith('.question.json'))) {
      const bytes = new Uint8Array(readFileSync(new URL(f, examples)));
      const m = questionManifestSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
      const rec = await client.add(bytes, { type: QUESTION_MANIFEST_TYPE, filename: f, title: m.code ?? m.id, tags: questionRegistryTags(m), ...(m.subject ? { subject: m.subject } : {}) });
      published[m.kind] = rec.key;
    }
    const keys = async (q: Parameters<typeof client.search>[0]) => (await client.search(q)).items.map((i) => i.key).sort();
    expect(await keys({ type: [QUESTION_MANIFEST_TYPE] })).toEqual(Object.values(published).sort());
    expect(await keys({ tag: ['kind:question'] })).toEqual(Object.values(published).sort());
    expect(await keys({ tag: ['question-kind:cq'] })).toEqual([published.cq]);
    expect(await keys({ tag: ['kind:question', 'question-kind:numeric'] })).toEqual([published.numeric]);
    // a code is looked up by its tag (free text splits EX-2-M1 into words, and would find all three)
    expect(await keys({ tag: ['code:EX-2-M1'] })).toEqual([published.mcq]);
    expect(await keys({ tag: ['code:EX-9-X9'] })).toEqual([]);
    // what comes back is what went in, and it is not served as a web page
    const { registryLibrary } = await import('@chalk-format/store');
    const url = (await registryLibrary({ url: BASE, token: 't-1', fetch: fetchApp }).url(published.mcq!))!;
    const got = await fetchApp(url);
    expect(questionManifestSchema.parse(await got.json()).code).toBe('EX-2-M1');
    expect(got.headers.get('content-security-policy')).toBe('sandbox');
  });

  it('keeps books (spec 1.8): the four item types, found by their tags, the newest current book item, the record of use', async () => {
    const { createRegistryClient, bookTags, currentBookQuery, pickCurrentBook, withBookState, libraryBookSchema, LIBRARY_BOOK_TYPE, LIBRARY_PAGE_TYPE, LIBRARY_TEXT_TYPE, LIBRARY_LINKS_TYPE } = await import('@chalk-format/store');
    const client = createRegistryClient(BASE, { token: 't-1', fetch: fetchApp });
    const enc = (x: unknown) => new TextEncoder().encode(JSON.stringify(x));
    const slug = 'test-book-1-8';
    const tags = (revision: number, kind: 'book' | 'page' | 'text' | 'links') => bookTags({ slug, revision, kind, state: 'current' });
    const [stores] = (await client.stores()).items;
    // revision 1, in the commit-point order: media, then page, text and links items, then the book item
    // registering a key again replaces its tags; `add` of bytes the library already has does not register, so a publisher does
    const register = (r: { key: string; sha256: string; type: string; size: number }, t: string[]) => fetchApp(`${BASE}/v1/assets`, {
      method: 'POST', headers: { Authorization: 'Bearer t-1', 'Content-Type': 'application/json' }, body: JSON.stringify({ key: r.key, sha256: r.sha256, type: r.type, size: r.size, tags: t }),
    }).then(async (res) => { expect(res.status).toBe(200); return res.json() as Promise<{ key: string; tags: string[] }>; });
    const putItem = async (x: unknown, type: string, t: string[]) => register(await client.add(enc(x), { type, tags: t }), t);
    const publish = async (revision: number, pageText: string) => {
      const picture = await client.add(enc({ picture: pageText }), { type: 'image/webp', title: 'a picture' });
      const page = await putItem({ id: 'p1', title: pageText, objects: [] }, LIBRARY_PAGE_TYPE, tags(revision, 'page'));
      // the same text in both revisions: one item, re-tagged with the new revision
      const text = await putItem({ v: 1, pages: { p1: [] } }, LIBRARY_TEXT_TYPE, tags(revision, 'text'));
      const links = await putItem({ format: 'chalk-links', version: 1, book: slug, bookRevision: revision, sentences: [], links: [] }, LIBRARY_LINKS_TYPE, tags(revision, 'links'));
      const item = libraryBookSchema.parse({
        format: 'chalk.streamed', streamVersion: 1, formatVersion: 11, id: slug, title: 'Test', locale: 'en', createdAt: 'x', updatedAt: 'x',
        pages: [{ id: 'p1', key: page.key, assets: [picture.key] }], assets: [{ id: picture.key, type: 'image/webp' }],
        text: { key: text.key }, links: links.key, assetSources: [stores],
      });
      const book = await client.add(enc(item), { type: LIBRARY_BOOK_TYPE, title: `Test, revision ${revision}`, tags: tags(revision, 'book') });
      return { book, keys: [book.key, page.key, text.key, links.key, picture.key] };
    };
    const one = await publish(1, 'one');
    const find = async () => pickCurrentBook((await client.search(currentBookQuery(slug))).items, slug)?.key;
    expect(await find()).toBe(one.book.key);
    // revision 2: until the old book item is superseded both are current, and the newer one wins
    await new Promise((r) => setTimeout(r, 5));
    const two = await publish(2, 'two');
    expect((await client.search(currentBookQuery(slug))).items.map((i) => i.key).sort()).toEqual([one.book.key, two.book.key].sort());
    expect(await find()).toBe(two.book.key);
    // superseding: register the old key again with its state changed (tags are replaced)
    await register(one.book, withBookState(one.book.tags ?? [], 'superseded'));
    expect((await client.search(currentBookQuery(slug))).items.map((i) => i.key)).toEqual([two.book.key]);
    expect((await client.get(one.book.key)).tags).toContain('state:superseded');
    // every kind is found by its tag; the record of use replaces the book's set
    for (const kind of ['page', 'text', 'links'] as const) expect((await client.search({ tag: [`book:${slug}`, `kind:${kind}`, 'book-revision:2'] })).items).toHaveLength(1);
    expect((await client.search({ tag: [`book:${slug}`, 'kind:text'] })).items).toHaveLength(1);
    // a textbook's set is thousands of keys (spec 1.8 §6.3); keys the library does not have are left out
    const many = Array.from({ length: 5000 }, (_, i) => `c1:${i.toString(32).padStart(25, 'a').replace(/[0-1]/g, 'a').replace(/[8-9]/g, 'b')}a`);
    expect(await client.setBookAssets(slug, [...two.keys, ...many])).toEqual({ book: slug, keys: two.keys.length });
    await client.setBookAssets(slug, two.keys);
    expect((await client.search({ book: slug })).items.map((i) => i.key).sort()).toEqual([...two.keys].sort());
    // and the bytes come back through the delivery store as they went in
    const { registryLibrary } = await import('@chalk-format/store');
    const got = await fetchApp((await registryLibrary({ url: BASE, token: 't-1', fetch: fetchApp }).url(two.book.key))!);
    expect(libraryBookSchema.parse(await got.json()).pages[0]!.key).toBe(two.keys[1]);
  });

  it('a private library: reading needs a token too', async () => {
    const priv = createLibraryApp({ db, storage: diskStorage(dir, { uploadBase: BASE }), publicUrl: `${BASE}/files/`, callers: tokenCallers('teacher:t-1'), publicRead: false });
    expect((await priv.fetch(new Request(`${BASE}/v1/search?q=x`))).status).toBe(401);
    expect((await priv.fetch(new Request(`${BASE}/v1/search?q=x`, { headers: { Authorization: 'Bearer t-1' } }))).status).toBe(200);
    // readers' list of stores stays public: books must be readable
    expect((await priv.fetch(new Request(`${BASE}/v1/stores`))).status).toBe(200);
    // a book in a library (spec 1.8 §7): its book item is found with the token, and only with it
    const find = `${BASE}/v1/search?tag=book:test-book-1-8&tag=kind:book&tag=state:current`;
    expect((await priv.fetch(new Request(find))).status).toBe(401);
    const found = await (await priv.fetch(new Request(find, { headers: { Authorization: 'Bearer t-1' } }))).json() as { items: { type: string }[] };
    expect(found.items.map((i) => i.type)).toEqual(['application/vnd.chalk.book+json']);
  });

  it('scans a bucket that already has media: adopted once, found by its file name', async () => {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'old', 'class9'), { recursive: true });
    writeFileSync(join(dir, 'old', 'class9', 'free-fall.mp4'), 'pretend video');
    writeFileSync(join(dir, 'old', 'notes.txt'), 'not media');
    const store = diskStorage(dir, { uploadBase: BASE });
    expect(await scanStorage(db, store, { prefix: 'old/' })).toEqual({ found: 1, added: 1 });
    expect(await scanStorage(db, store, { prefix: 'old/' })).toEqual({ found: 1, added: 0 });
    const r = await (await fetchApp(`${BASE}/v1/search?q=free%20fall`)).json() as { items: { filename: string; type: string }[] };
    expect(r.items[0]).toMatchObject({ filename: 'free-fall.mp4', type: 'video/mp4' });
  });
});
