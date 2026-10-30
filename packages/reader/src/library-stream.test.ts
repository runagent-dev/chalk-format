import { describe, expect, it } from 'vitest';
import { publishStreamed } from '@chalk-format/container';
import { assetKeyAndSha256, type Lesson } from '@chalk-format/model';
import { loadBookLinks, loadQuestion } from '@chalk-format/store';
import { isLibrarySource, isStreamSource, openLibraryStreamedBook, windowAround } from './stream.js';

const enc = new TextEncoder();
const picture = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 8, 7, 6]);
const { key: pictureKey } = await assetKeyAndSha256(picture);
const page = (i: number) => ({
  id: `p${i}`, title: `Page ${i}`, background: { type: 'blank' as const }, textLayer: [{ text: `word${i}`, x: 0, y: 0, width: 50, fontSize: 12 }],
  objects: i === 3 ? [{ id: 'img', type: 'image' as const, x: 10, y: 10, width: 100, height: 80, assetId: pictureKey }] : [],
});
const lesson: Lesson = { id: 'lib-book', title: 'A book in a library', locale: 'bn', createdAt: '', updatedAt: '', snipPages: [], pages: Array.from({ length: 20 }, (_, i) => page(i)) };

const at = (key: string) => { const h = key.slice(3); return `https://cdn.example/c1/${h.slice(0, 2)}/${h.slice(2, 4)}/${h}`; };

/** A streamed book published into a fake library as the contract says (items by key, the book item last), and that library's fetch. */
async function library(o: { token?: string; bearerStore?: boolean; verifyAlways?: boolean; tamper?: string; storeMedia?: string[]; rendition?: Uint8Array; firstStore?: object; question?: string; adopted?: boolean; adoptedStore?: object } = {}) {
  const { index, files } = await publishStreamed(lesson, new Map([[pictureKey, { type: 'image/png', bytes: picture }]]));
  const items = new Map<string, { bytes: Uint8Array; type: string; tags: string[] }>();
  const put = async (bytes: Uint8Array, type: string, tags: string[] = []) => { const { key } = await assetKeyAndSha256(bytes); items.set(key, { bytes, type, tags }); return key; };
  for (const a of index.assets) if (a.path) await put(files.get(a.path)!, a.type);
  const pageKey = new Map<string, string>();
  for (const p of index.pages) pageKey.set(p.id, await put(files.get(p.file)!, 'application/vnd.chalk.page+json', ['kind:page']));
  const textKey = await put(files.get(index.text!.file)!, 'application/vnd.chalk.text+json', ['kind:text']);
  const links = await put(enc.encode(JSON.stringify({ format: 'chalk-links', version: 1, book: 'demo', bookRevision: 3, sentences: [{ id: 's', page: 4, pageId: 'p3', rects: [[0.1, 0.2, 0.3, 0.04]], text: 'word3' }], links: [{ sentence: 's', question: o.question ? await put(enc.encode(o.question), 'application/vnd.chalk.question+json') : pictureKey, role: 'answers_from' }] })), 'application/vnd.chalk.links+json', ['kind:links']);
  const book = {
    ...index,
    pages: index.pages.map(({ file: _file, ...p }) => ({ ...p, key: pageKey.get(p.id)! })),
    text: { key: textKey, bytes: index.text!.bytes },
    assets: await Promise.all(index.assets.map(async ({ path: _path, ...a }) => (o.rendition ? { ...a, renditions: [{ id: await put(o.rendition, 'image/webp'), type: 'image/webp' }] } : a))),
    assetSources: [{ id: 'library', kind: 'derived', template: 'https://cdn.example/c1/{h0}/{h1}/{h}' }],
    links,
  };
  const bookKey = await put(enc.encode(JSON.stringify(book)), 'application/vnd.chalk.book+json', ['origin:chalkbook', 'book:demo', 'book-revision:3', 'kind:book', 'state:current']);
  const asked: string[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const u = new URL(String(url));
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    if (u.host === 'lib.example') {
      if (o.token && (init?.headers as Record<string, string> | undefined)?.Authorization !== `Bearer ${o.token}` && u.pathname !== '/v1/stores') return json({ error: { code: 'unauthorized', message: 'a token is needed' } }, 401);
      if (u.pathname === '/v1/stores') return json({ items: [...(o.firstStore ? [o.firstStore] : []), { ...book.assetSources[0], ...(o.bearerStore ? { auth: 'bearer' } : {}), ...(o.verifyAlways ? { verify: 'always' } : {}), ...(o.storeMedia ? { media: o.storeMedia } : {}) },
        ...(o.adopted ? [{ id: 'library-adopted', kind: 'indexed', base: 'https://lib.example/', ...o.adoptedStore }] : [])] });
      // files adopted in place (registry-api §3.1): everything but the book item, at the book's own paths, named by the index
      const shard = /^\/index\/([a-z2-7]{2})\.json$/.exec(u.pathname)?.[1];
      if (shard) {
        asked.push(`index ${shard}`);
        const entries = Object.fromEntries([...items].filter(([key]) => o.adopted && key !== bookKey && key.slice(3, 5) === shard).map(([key, i]) => [key.slice(3), { p: adoptedAt(key), t: i.type }]));
        return Object.keys(entries).length ? json({ v: 1, entries }) : new Response(null, { status: 404 });
      }
      const tags = u.searchParams.getAll('tag');
      const hits = [...items].filter(([, i]) => tags.every((t) => i.tags.includes(t)));
      return json({ items: hits.map(([key, i]) => ({ key, sha256: '0'.repeat(64), type: i.type, size: i.bytes.byteLength, tags: i.tags, status: 'available', createdAt: '2026-10-30T00:00:00Z' })) });
    }
    if (o.bearerStore && (init?.headers as Record<string, string> | undefined)?.Authorization !== `Bearer ${o.token}`) return new Response(null, { status: 401 });
    const hit = [...items].find(([key]) => (o.adopted && key !== bookKey ? adoptedAt(key) : at(key)) === u.href);
    asked.push(hit ? (hit[0] === bookKey ? 'book' : hit[1].type.split('/')[1]!.replace('vnd.chalk.', '').replace('+json', '')) : u.href);
    if (hit && hit[0] === o.tamper) return new Response(enc.encode('not the picture') as unknown as BodyInit, { status: 200 });
    return hit ? new Response(hit[1].bytes as unknown as BodyInit, { status: 200, headers: { 'content-type': hit[1].type } }) : new Response(null, { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, asked, pageKey, bookKey, put };
}
const adoptedAt = (key: string) => `https://cdn.example/chalk-books/demo/items/${key.slice(3)}`;
const settle = () => new Promise((r) => setTimeout(r, 20));

describe('books in a library, in the reader', () => {
  it('tells a library source from the others', () => {
    expect(isLibrarySource({ library: 'https://lib.example/', slug: 'demo' })).toBe(true);
    expect(isLibrarySource('https://cdn.example/books/big/')).toBe(false);
    expect(isLibrarySource(new URL('https://cdn.example/x/'))).toBe(false);
    expect(isLibrarySource(new Uint8Array(3))).toBe(false);
    expect(isStreamSource({ library: 'https://lib.example/', slug: 'demo' })).toBe(false);
  });

  it('opens from the book item alone, then loads only the pages wanted, each by its key', async () => {
    const lib = await library();
    const b = await openLibraryStreamedBook({ library: 'https://lib.example/', slug: 'demo' }, { fetch: lib.fetch });
    expect(b.library?.key).toBe(lib.bookKey);
    expect(b.library?.revision).toBe(3);
    expect(b.lesson.pages).toHaveLength(20);
    expect(lib.asked).toEqual(['book']);
    b.want(windowAround(3, 20, 1));
    await settle();
    expect(lib.asked.filter((a) => a === 'page')).toHaveLength(3);
    expect(b.isLoaded('p3') && b.isLoaded('p2') && b.isLoaded('p4') && !b.isLoaded('p10')).toBe(true);
    expect(b.lesson.pages[3]!.objects[0]).toMatchObject({ type: 'image', assetId: pictureKey });
  });

  it('draws media from the library store, and hands out their bytes checked', async () => {
    const lib = await library();
    const b = await openLibraryStreamedBook({ library: 'https://lib.example/', slug: 'demo' }, { fetch: lib.fetch });
    expect(await b.assetUrl(pictureKey)).toBe(at(pictureKey));
    const bytes = await b.assetBytes(pictureKey);
    expect(bytes?.type).toBe('image/png');
    expect(new Uint8Array(bytes!.bytes)).toEqual(picture);
    // an id the library cannot name goes to the host's resolver
    const withHost = await openLibraryStreamedBook({ library: 'https://lib.example/', slug: 'demo' }, { fetch: lib.fetch, resolveAsset: (id) => `https://host.example/${id}` });
    expect(await withHost.assetUrl('img-1')).toBe('https://host.example/img-1');
  });

  it('a book whose pages, text and media were adopted in place: read through the library\'s indexed store, never from a derived URL that 404s', async () => {
    const lib = await library({ adopted: true });
    const b = await openLibraryStreamedBook({ library: 'https://lib.example/', slug: 'demo' }, { fetch: lib.fetch });
    expect(lib.asked.filter((a) => !a.startsWith('index '))).toEqual(['book']);
    expect(await b.assetUrl(pictureKey)).toBe(adoptedAt(pictureKey));
    expect(new Uint8Array((await b.assetBytes(pictureKey))!.bytes)).toEqual(picture);
    b.want(windowAround(0, 20, 20));
    await settle();
    expect(b.lesson.pages.every((p) => b.isLoaded(p.id))).toBe(true);
    expect(b.lesson.pages[3]!.objects[0]).toMatchObject({ type: 'image', assetId: pictureKey });
    // every item from its adopted path; no derived URL was asked (each would 404)
    expect(lib.asked.filter((a) => a.startsWith('https://'))).toEqual([]);
    expect(lib.asked.filter((a) => a === 'page')).toHaveLength(20);
  });

  it('adopted media of an indexed store that asks to be verified always are drawn from checked bytes, not a bare URL', async () => {
    const lib = await library({ adopted: true, adoptedStore: { verify: 'always' } });
    const b = await openLibraryStreamedBook({ library: 'https://lib.example/', slug: 'demo' }, { fetch: lib.fetch });
    expect((await b.assetUrl(pictureKey))?.startsWith('blob:')).toBe(true);
    b.dispose();
    const bad = await openLibraryStreamedBook({ library: 'https://lib.example/', slug: 'demo' }, { fetch: (await library({ adopted: true, adoptedStore: { verify: 'always' }, tamper: pictureKey })).fetch });
    expect(await bad.assetUrl(pictureKey)).toBeNull();
    bad.dispose();
  });

  it('leaves media the library has no store for to the host, for their bytes as for their URL', async () => {
    const lib = await library({ storeMedia: ['application/*'] });
    const b = await openLibraryStreamedBook({ library: 'https://lib.example/', slug: 'demo' }, { fetch: lib.fetch, resolveAsset: (id) => at(id) });
    expect(await b.assetUrl(pictureKey)).toBe(at(pictureKey));
    const bytes = await b.assetBytes(pictureKey);
    expect(new Uint8Array(bytes!.bytes)).toEqual(picture);
  });

  it('after the host, finds media the library has no store for in the stores the book suggests, checked', async () => {
    const lib = await library({ storeMedia: ['application/*'] });
    const b = await openLibraryStreamedBook({ library: 'https://lib.example/', slug: 'demo' }, { fetch: lib.fetch });
    const url = await b.assetUrl(pictureKey);
    expect(url?.startsWith('blob:')).toBe(true);
    expect(new Uint8Array(await (await fetch(url!)).arrayBuffer())).toEqual(picture);
    expect(new Uint8Array((await b.assetBytes(pictureKey))!.bytes)).toEqual(picture);
    b.dispose();
    const bad = await openLibraryStreamedBook({ library: 'https://lib.example/', slug: 'demo' }, { fetch: (await library({ storeMedia: ['application/*'], tamper: pictureKey })).fetch });
    expect(await bad.assetUrl(pictureKey)).toBeNull();
  });

  it("draws a question's picture (its format not known) from whichever image store of the library has it, not the first one's URL", async () => {
    const qpic = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 4, 4]);
    const { key: qpicKey } = await assetKeyAndSha256(qpic);
    const question = JSON.stringify({ format: 'chalk.question', manifestVersion: 1, id: 'q1', version: '1', kind: 'short_answer', stem: `![](${qpicKey})`, assets: [qpicKey] });
    const lib = await library({ question, firstStore: { id: 'webp', kind: 'derived', template: 'https://webp.example/{h}', media: ['image/webp'] } });
    await lib.put(qpic, 'image/png');
    const b = await openLibraryStreamedBook({ library: 'https://lib.example/', slug: 'demo' }, { fetch: lib.fetch });
    const links = await loadBookLinks(b.library!);
    await loadQuestion(b.library!, links!.links[0]!.question);
    const url = await b.assetUrl(qpicKey);
    expect(url?.startsWith('blob:')).toBe(true);
    const got = await fetch(url!);
    expect(got.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(qpic);
    b.dispose();
  });

  it("checks a question's picture before it is shown (spec 1.7 §4), even one the book's pages also use", async () => {
    const question = JSON.stringify({ format: 'chalk.question', manifestVersion: 1, id: 'q2', version: '1', kind: 'short_answer', stem: `![](${pictureKey})`, assets: [pictureKey] });
    const open = async (tamper?: string) => {
      const lib = await library({ question, ...(tamper ? { tamper } : {}) });
      const b = await openLibraryStreamedBook({ library: 'https://lib.example/', slug: 'demo' }, { fetch: lib.fetch });
      await loadQuestion(b.library!, (await loadBookLinks(b.library!))!.links[0]!.question);
      return b;
    };
    const ok = await open();
    expect(ok.library!.mustCheck(pictureKey)).toBe(true);
    const url = await ok.assetUrl(pictureKey);
    expect(url?.startsWith('blob:')).toBe(true);
    ok.dispose();
    expect(await (await open(pictureKey)).assetUrl(pictureKey)).toBeNull();
  });

  it('hands out the bytes of a rendition with the type the book declares for it', async () => {
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 5, 5]);
    const lib = await library({ rendition: webp });
    const b = await openLibraryStreamedBook({ library: 'https://lib.example/', slug: 'demo' }, { fetch: lib.fetch });
    const { key } = await assetKeyAndSha256(webp);
    const bytes = await b.assetBytes(key);
    expect(bytes?.type).toBe('image/webp');
    expect(new Uint8Array(bytes!.bytes)).toEqual(webp);
  });

  it('never hands out media bytes that fail their key check (no unchecked second try)', async () => {
    const lib = await library({ tamper: pictureKey });
    const b = await openLibraryStreamedBook({ library: 'https://lib.example/', slug: 'demo' }, { fetch: lib.fetch });
    expect(await b.assetBytes(pictureKey)).toBeNull();
    expect(lib.asked.filter((a) => a === 'png')).toHaveLength(1);
  });

  it('draws media of a store that needs the token from checked bytes (an <img> sends no header)', async () => {
    const lib = await library({ token: 'sesame', bearerStore: true });
    const b = await openLibraryStreamedBook({ library: 'https://lib.example/', slug: 'demo', token: 'sesame' }, { fetch: lib.fetch });
    const url = await b.assetUrl(pictureKey);
    expect(url?.startsWith('blob:')).toBe(true);
    expect(new Uint8Array(await (await fetch(url!)).arrayBuffer())).toEqual(picture);
    b.dispose();
  });

  it('draws media of a store that asks to be verified always from checked bytes, and refuses bytes that fail', async () => {
    const ok = await openLibraryStreamedBook({ library: 'https://lib.example/', slug: 'demo' }, { fetch: (await library({ verifyAlways: true })).fetch });
    expect((await ok.assetUrl(pictureKey))?.startsWith('blob:')).toBe(true);
    ok.dispose();
    const bad = await openLibraryStreamedBook({ library: 'https://lib.example/', slug: 'demo' }, { fetch: (await library({ verifyAlways: true, tamper: pictureKey })).fetch });
    expect(await bad.assetUrl(pictureKey)).toBeNull();
  });

  it('searches through the text item, and gives the links item', async () => {
    const lib = await library();
    const b = await openLibraryStreamedBook({ library: 'https://lib.example/', slug: 'demo' }, { fetch: lib.fetch });
    const text = await b.searchText();
    expect(text?.pages.p7?.[0]?.text).toBe('word7');
    expect(lib.asked.filter((a) => a === 'page')).toHaveLength(0);
    const links = await loadBookLinks(b.library!);
    expect(links?.sentences[0]).toMatchObject({ pageId: 'p3', text: 'word3' });
  });

  it('loads every page for author mode', async () => {
    const lib = await library();
    const b = await openLibraryStreamedBook({ library: 'https://lib.example/', slug: 'demo' }, { fetch: lib.fetch });
    await b.loadAll();
    expect(b.complete).toBe(true);
  });

  it('sends the token to a library that keeps its books private', async () => {
    const lib = await library({ token: 'sesame' });
    await expect(openLibraryStreamedBook({ library: 'https://lib.example/', slug: 'demo' }, { fetch: lib.fetch })).rejects.toThrow(/token/);
    const b = await openLibraryStreamedBook({ library: 'https://lib.example/', slug: 'demo', token: 'sesame' }, { fetch: lib.fetch });
    expect(b.lesson.title).toBe('A book in a library');
  });

  it('takes the token as a function (a sign-in): asked for each request, and again after a 401', async () => {
    const lib = await library({ token: 'sesame', bearerStore: true });
    const asked: (string | undefined)[] = [];
    // the first token it gives has gone stale at the library; asked again (`rejected`), it gives the right one
    const token = async (r?: { rejected?: string }) => { asked.push(r?.rejected); return r?.rejected ? 'sesame' : asked.length > 3 ? 'sesame' : 'stale'; };
    const b = await openLibraryStreamedBook({ library: 'https://lib.example/', slug: 'demo', token }, { fetch: lib.fetch });
    expect(b.lesson.title).toBe('A book in a library');
    expect(asked).toContain('stale');
    const url = await b.assetUrl(pictureKey);
    expect(url?.startsWith('blob:')).toBe(true);
    expect(new Uint8Array(await (await fetch(url!)).arrayBuffer())).toEqual(picture);
    b.dispose();
  });
});
