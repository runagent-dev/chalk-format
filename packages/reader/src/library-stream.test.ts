import { describe, expect, it } from 'vitest';
import { publishStreamed } from '@chalk-format/container';
import { assetKeyAndSha256, type Lesson } from '@chalk-format/model';
import { loadBookLinks } from '@chalk-format/store';
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
async function library(o: { token?: string; bearerStore?: boolean; tamper?: string } = {}) {
  const { index, files } = await publishStreamed(lesson, new Map([[pictureKey, { type: 'image/png', bytes: picture }]]));
  const items = new Map<string, { bytes: Uint8Array; type: string; tags: string[] }>();
  const put = async (bytes: Uint8Array, type: string, tags: string[] = []) => { const { key } = await assetKeyAndSha256(bytes); items.set(key, { bytes, type, tags }); return key; };
  for (const a of index.assets) if (a.path) await put(files.get(a.path)!, a.type);
  const pageKey = new Map<string, string>();
  for (const p of index.pages) pageKey.set(p.id, await put(files.get(p.file)!, 'application/vnd.chalk.page+json', ['kind:page']));
  const textKey = await put(files.get(index.text!.file)!, 'application/vnd.chalk.text+json', ['kind:text']);
  const links = await put(enc.encode(JSON.stringify({ format: 'chalk-links', version: 1, book: 'demo', bookRevision: 3, sentences: [{ id: 's', page: 4, pageId: 'p3', rects: [[0.1, 0.2, 0.3, 0.04]], text: 'word3' }], links: [{ sentence: 's', question: pictureKey, role: 'answers_from' }] })), 'application/vnd.chalk.links+json', ['kind:links']);
  const book = {
    ...index,
    pages: index.pages.map(({ file: _file, ...p }) => ({ ...p, key: pageKey.get(p.id)! })),
    text: { key: textKey, bytes: index.text!.bytes },
    assets: index.assets.map(({ path: _path, ...a }) => a),
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
      if (u.pathname === '/v1/stores') return json({ items: [{ ...book.assetSources[0], ...(o.bearerStore ? { auth: 'bearer' } : {}) }] });
      const tags = u.searchParams.getAll('tag');
      const hits = [...items].filter(([, i]) => tags.every((t) => i.tags.includes(t)));
      return json({ items: hits.map(([key, i]) => ({ key, sha256: '0'.repeat(64), type: i.type, size: i.bytes.byteLength, tags: i.tags, status: 'available', createdAt: '2026-10-30T00:00:00Z' })) });
    }
    if (o.bearerStore && (init?.headers as Record<string, string> | undefined)?.Authorization !== `Bearer ${o.token}`) return new Response(null, { status: 401 });
    const hit = [...items].find(([key]) => at(key) === u.href);
    asked.push(hit ? (hit[0] === bookKey ? 'book' : hit[1].type.split('/')[1]!.replace('vnd.chalk.', '').replace('+json', '')) : u.href);
    if (hit && hit[0] === o.tamper) return new Response(enc.encode('not the picture') as unknown as BodyInit, { status: 200 });
    return hit ? new Response(hit[1].bytes as unknown as BodyInit, { status: 200, headers: { 'content-type': hit[1].type } }) : new Response(null, { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, asked, pageKey, bookKey };
}
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
});
