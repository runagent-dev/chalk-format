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
    // a type that is HTML once normalised is not served as HTML either
    const { assetKeyAndSha256 } = await import('@chalk-format/model');
    const oddBytes = new TextEncoder().encode('<script>1</script>'), odd = await assetKeyAndSha256(oddBytes);
    const api = (path: string, body: object) => fetchApp(`${BASE}${path}`, { method: 'POST', headers: { Authorization: 'Bearer t-1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const { upload } = (await (await api('/v1/uploads', { ...odd, type: 'image/png', size: oddBytes.byteLength })).json()) as { upload: { url: string; headers?: Record<string, string> } };
    await fetchApp(upload.url, { method: 'PUT', headers: upload.headers ?? {}, body: oddBytes });
    expect((await api('/v1/assets', { ...odd, type: ' TEXT/HTML; charset=utf-8', size: oddBytes.byteLength })).status).toBe(200);
    expect((await fetchApp((await lib.url(odd.key))!)).headers.get('content-type')).toBe('application/octet-stream');
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
    // both revisions, then the new one alone: what the new one does not use leaves the set, what it keeps stays
    const both = [...new Set([...one.keys, ...two.keys])];
    expect(await client.setBookAssets(slug, both)).toEqual({ book: slug, keys: both.length });
    expect((await client.search({ book: slug })).items.map((i) => i.key).sort()).toEqual([...both].sort());
    await client.setBookAssets(slug, two.keys);
    expect((await client.search({ book: slug })).items.map((i) => i.key).sort()).toEqual([...two.keys].sort());
    // and the bytes come back through the delivery store as they went in
    const { registryLibrary } = await import('@chalk-format/store');
    const got = await fetchApp((await registryLibrary({ url: BASE, token: 't-1', fetch: fetchApp }).url(two.book.key))!);
    expect(libraryBookSchema.parse(await got.json()).pages[0]!.key).toBe(two.keys[1]);
  });

  it('POST /v1/assets/current: the newest available item of each tag (spec 1.2 §4.1)', async () => {
    const { createRegistryClient, RegistryError } = await import('@chalk-format/store');
    const client = createRegistryClient(BASE, { token: 't-1', fetch: fetchApp });
    const enc = (x: unknown) => new TextEncoder().encode(JSON.stringify(x));
    const tag = `question:cur-${Math.random().toString(36).slice(2, 8)}`, other = `question:oth-${Math.random().toString(36).slice(2, 8)}`;
    const add = (n: string, tags: string[]) => client.add(enc({ n, tag }), { type: 'application/vnd.chalk.question+json', tags, title: n });
    const at = (key: string, iso: string) => db.query('UPDATE assets SET created_at = $2 WHERE key = $1', [key, iso]);
    const a = await add('a', [tag, 'state:current']), b = await add('b', [tag, 'state:current', other]);
    await at(a.key, '2026-01-01T00:00:00Z'); await at(b.key, '2026-01-02T00:00:00Z');
    expect((await client.current([tag, other, 'question:nope'])).items).toEqual({ [tag]: expect.objectContaining({ key: b.key, status: 'available' }), [other]: expect.objectContaining({ key: b.key }), 'question:nope': null });
    // the record is the one GET /v1/assets/{key} gives
    expect((await client.current([tag])).items[tag]).toEqual(await client.get(b.key));
    // same time: the larger key wins, whichever was added first
    await at(a.key, '2026-01-02T00:00:00Z');
    expect((await client.current([tag])).items[tag]!.key).toBe(a.key > b.key ? a.key : b.key);
    // superseded items are not current (the default requirement); `require` can ask for them
    await at(a.key, '2026-01-03T00:00:00Z');
    await fetchApp(`${BASE}/v1/assets`, { method: 'POST', headers: { Authorization: 'Bearer t-1', 'Content-Type': 'application/json' }, body: JSON.stringify({ key: a.key, sha256: a.sha256, type: a.type, size: a.size, tags: [tag, 'state:superseded'] }) });
    expect((await client.current([tag])).items[tag]!.key).toBe(b.key);
    expect((await client.current([tag], { require: ['state:superseded'] })).items[tag]!.key).toBe(a.key);
    expect((await client.current([tag], { type: 'image/png' })).items[tag]).toBeNull();
    // pending and withdrawn items are not answered
    const pendingBytes = enc({ pending: tag }), { assetKeyAndSha256 } = await import('@chalk-format/model'), pk = await assetKeyAndSha256(pendingBytes);
    await fetchApp(`${BASE}/v1/uploads`, { method: 'POST', headers: { Authorization: 'Bearer t-1', 'Content-Type': 'application/json' }, body: JSON.stringify({ ...pk, type: 'application/vnd.chalk.question+json', size: pendingBytes.byteLength }) });
    await db.query("UPDATE assets SET tags = $2, created_at = '2030-01-01T00:00:00Z' WHERE key = $1", [pk.key, [tag, 'state:current']]);
    expect((await client.current([tag])).items[tag]!.key).toBe(b.key);
    await fetchApp(`${BASE}/v1/assets/${encodeURIComponent(b.key)}/withdraw`, { method: 'POST', headers: { Authorization: 'Bearer a-1', 'Content-Type': 'application/json' }, body: '{}' });
    expect((await client.current([tag])).items[tag]).toBeNull();
    // 1..500 tags
    expect((await client.current(Array.from({ length: 500 }, (_, i) => `question:none-${i}`))).items).toHaveProperty('question:none-499', null);
    const post = (body: unknown) => fetchApp(`${BASE}/v1/assets/current`, { method: 'POST', headers: { Authorization: 'Bearer t-1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post({ tags: Array.from({ length: 501 }, (_, i) => `question:none-${i}`) })).status).toBe(400);
    expect((await post({ tags: [] })).status).toBe(400);
    expect(await client.current(['question:x']).catch((e) => e)).not.toBeInstanceOf(RegistryError);
    expect(((await (await fetchApp(`${BASE}/`)).json()) as { endpoints: string[] }).endpoints).toContain('POST /v1/assets/current');
  });

  it('POST /v1/assets/current runs one SQL statement however many tags, and uses the tags index', async () => {
    const seen: string[] = [];
    const counting: Db = { query: (sql, params) => { seen.push(sql); return db.query(sql, params); }, close: async () => {} };
    const app2 = createLibraryApp({ db: counting, storage: diskStorage(dir, { uploadBase: BASE }), publicUrl: `${BASE}/files/`, callers: tokenCallers('teacher:t-1') });
    seen.length = 0;
    const res = await app2.fetch(new Request(`${BASE}/v1/assets/current`, { method: 'POST', headers: { Authorization: 'Bearer t-1', 'Content-Type': 'application/json' }, body: JSON.stringify({ tags: Array.from({ length: 300 }, (_, i) => `question:n-${i}`) }) }));
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    // the planner may prefer a scan on a tiny table; with scans off it must be able to use the GIN index on tags
    await db.query('SET enable_seqscan = off');
    const plan = (await db.query<{ 'QUERY PLAN': string }>(`EXPLAIN SELECT a.key FROM unnest(ARRAY['question:x']::text[]) AS t(tag) JOIN assets a ON a.tags @> ARRAY[t.tag]::text[] AND a.tags @> ARRAY['state:current']::text[] AND a.status = 'available'`)).map((r) => r['QUERY PLAN']).join('\n');
    await db.query('RESET enable_seqscan');
    expect(plan).toContain('assets_tags');
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
    // POST /v1/assets/current is a reader's call: no token, no answer
    const cur = (headers: Record<string, string>) => priv.fetch(new Request(`${BASE}/v1/assets/current`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ tags: ['kind:book'], require: [] }) }));
    expect((await cur({})).status).toBe(401);
    const got = await cur({ Authorization: 'Bearer t-1' });
    expect(got.status).toBe(200);
    expect(((await got.json()) as { items: Record<string, { type: string } | null> }).items['kind:book']?.type).toBe('application/vnd.chalk.book+json');
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
