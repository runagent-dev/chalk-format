import { describe, expect, it } from 'vitest';
import { assetKeyAndSha256 } from '@chalk-format/model';
import { loadBookLinks, openLibraryBook } from './load.js';
import { hashPart } from '../urls.js';

const enc = new TextEncoder();
const LIB = 'https://lib.example/';
const STORE = { id: 'library', kind: 'derived', template: 'https://cdn.example/c1/{h0}/{h1}/{h}' };
const at = (key: string) => `https://cdn.example/c1/${hashPart(key).slice(0, 2)}/${hashPart(key).slice(2, 4)}/${hashPart(key)}`;

type Item = { key: string; sha256: string; bytes: Uint8Array; type: string; tags: string[]; createdAt: string };
async function item(value: unknown, type: string, tags: string[] = [], createdAt = '2026-10-01T00:00:00Z'): Promise<Item> {
  const bytes = value instanceof Uint8Array ? value : enc.encode(JSON.stringify(value));
  const { key, sha256 } = await assetKeyAndSha256(bytes);
  return { key, sha256, bytes, type, tags, createdAt };
}

/** A small book published as the contract says: pages, text, links and a picture as items, the book item last. */
async function publish(o: { revision?: number; title?: string; createdAt?: string } = {}) {
  const picture = await item(new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3]), 'image/webp');
  const page = { id: 'p1', title: 'One', width: 800, height: 600, background: { type: 'image', assetId: picture.key }, objects: [] };
  const pageItem = await item(page, 'application/vnd.chalk.page+json', ['kind:page']);
  const textItem = await item({ v: 1, pages: { p1: [{ text: 'দোলক', x: 10, y: 10, width: 40, fontSize: 12 }] } }, 'application/vnd.chalk.text+json', ['kind:text']);
  const linksItem = await item({
    format: 'chalk-links', version: 1, book: 'demo', bookRevision: o.revision ?? 1,
    sentences: [{ id: 's1', page: 1, pageId: 'p1', rects: [[0.1, 0.1, 0.5, 0.05]], text: 'দোলক' }],
    links: [{ sentence: 's1', question: 'c1:aaaaaaaaaaaaaaaaaaaaaaaaaa', role: 'answers_from' }],
  }, 'application/vnd.chalk.links+json', ['kind:links']);
  const book = await item({
    format: 'chalk.streamed', streamVersion: 1, formatVersion: 11, id: 'demo', title: o.title ?? 'Demo', locale: 'bn',
    createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
    pages: [{ id: 'p1', key: pageItem.key, title: 'One', width: 800, height: 600, bytes: pageItem.bytes.byteLength, assets: [picture.key] }],
    assets: [{ id: picture.key, type: 'image/webp', size: picture.bytes.byteLength }],
    text: { key: textItem.key, bytes: textItem.bytes.byteLength },
    assetSources: [{ id: 'library', kind: 'derived', template: 'https://elsewhere.example/c1/{h0}/{h1}/{h}' }],
    links: linksItem.key,
  }, 'application/vnd.chalk.book+json', ['origin:chalkbook', 'book:demo', `book-revision:${o.revision ?? 1}`, 'kind:book', 'state:current'], o.createdAt);
  return { picture, pageItem, textItem, linksItem, book };
}

/** A fake library: the registry API (search, stores) and its store, with an optional token for reading. */
function fakeLibrary(items: Item[], o: { token?: string; tamper?: string; stores?: unknown[] } = {}) {
  const calls: string[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const u = new URL(String(url));
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    calls.push(`${u.host}${u.pathname}${auth ? ' (token)' : ''}`);
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    if (u.host === 'lib.example') {
      if (o.token && auth !== `Bearer ${o.token}` && u.pathname !== '/v1/stores') return json({ error: { code: 'unauthorized', message: 'a token is needed' } }, 401);
      if (u.pathname === '/v1/stores') return json({ items: o.stores ?? [STORE] });
      if (u.pathname === '/v1/search') {
        const tags = u.searchParams.getAll('tag');
        const hits = items.filter((i) => tags.every((t) => i.tags.includes(t))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return json({ items: hits.map((i) => ({ key: i.key, sha256: i.sha256, type: i.type, size: i.bytes.byteLength, tags: i.tags, status: 'available', createdAt: i.createdAt })) });
      }
    }
    if (u.host === 'cdn.example') {
      const hit = items.find((i) => at(i.key) === u.href);
      if (!hit) return new Response('not found', { status: 404 });
      return new Response((hit.key === o.tamper ? enc.encode('something else') : hit.bytes) as unknown as BodyInit, { status: 200, headers: { 'content-type': hit.type } });
    }
    return new Response('no', { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe('openLibraryBook (books in a library)', () => {
  it('finds the current book item, checks it and gives a streamed index whose files are items', async () => {
    const p = await publish();
    const lib = fakeLibrary([p.picture, p.pageItem, p.textItem, p.linksItem, p.book]);
    const book = await openLibraryBook({ library: LIB, slug: 'demo', fetch: lib.fetch });
    expect(book.key).toBe(p.book.key);
    expect(book.revision).toBe(1);
    expect(book.index.format).toBe('chalk.streamed');
    const file = book.index.pages[0]!.file;
    expect(book.keyOf(file)).toBe(p.pageItem.key);
    expect(JSON.parse(new TextDecoder().decode(await book.read(file)))).toMatchObject({ id: 'p1' });
    expect(JSON.parse(new TextDecoder().decode(await book.read(book.index.text!.file)))).toMatchObject({ v: 1 });
    // book.json reads back as the index (what assembleStreamed starts from)
    expect(JSON.parse(new TextDecoder().decode(await book.read('book.json')))).toEqual(book.index);
    // media and items come from the library's own store, not from the copy the book names
    expect(book.urlOf(p.picture.key)).toBe(at(p.picture.key));
    expect(book.urlOf('img-1')).toBeNull();
    expect(lib.calls.some((c) => c.startsWith('elsewhere.example'))).toBe(false);
    // no token given: none sent
    expect(lib.calls.every((c) => !c.endsWith('(token)'))).toBe(true);
  });

  it('the newest current book item wins', async () => {
    const old = await publish({ title: 'Old', createdAt: '2026-09-01T00:00:00Z' });
    const now = await publish({ title: 'New', revision: 2, createdAt: '2026-10-20T00:00:00Z' });
    const lib = fakeLibrary([old.book, now.book, now.pageItem, now.textItem, now.linksItem, now.picture]);
    const book = await openLibraryBook({ library: LIB, slug: 'demo', fetch: lib.fetch });
    expect(book.index.title).toBe('New');
    expect(book.revision).toBe(2);
  });

  it('of two current items made at the same time, the larger key wins', async () => {
    const a = await publish({ title: 'A', createdAt: '2026-10-20T00:00:00Z' });
    const b = await publish({ title: 'B', createdAt: '2026-10-20T00:00:00Z' });
    const [, larger] = [a, b].sort((x, y) => (x.book.key < y.book.key ? -1 : 1));
    const book = await openLibraryBook({ library: LIB, slug: 'demo', fetch: fakeLibrary([a.book, b.book]).fetch });
    expect(book.key).toBe(larger!.book.key);
  });

  it('reads each type from the first store that takes it (an image-only store listed first is skipped for the book)', async () => {
    const p = await publish();
    const images = { id: 'pictures', kind: 'derived', template: 'https://img.example/{h}', media: ['image/*'] };
    const lib = fakeLibrary([p.book, p.pageItem, p.picture], { stores: [images, STORE] });
    const book = await openLibraryBook({ library: LIB, slug: 'demo', fetch: lib.fetch });
    expect(book.urlOf(p.picture.key)).toBe(`https://img.example/${hashPart(p.picture.key)}`);
    expect(book.keyOf(book.index.pages[0]!.file)).toBe(p.pageItem.key);
    expect(lib.calls.some((c) => c.startsWith('img.example'))).toBe(false);
    await book.read(book.index.pages[0]!.file);
  });

  it('gives renditions the type the book declares for them, so a store that takes only that type serves them', async () => {
    const p = await publish();
    const webp = await item(new Uint8Array([0x52, 0x49, 0x46, 0x46, 9, 9]), 'image/webp');
    const raw = JSON.parse(new TextDecoder().decode(p.book.bytes)) as { assets: { renditions?: unknown[] }[] };
    raw.assets[0]!.renditions = [{ id: webp.key, type: 'image/webp' }];
    const bookItem = await item(raw, p.book.type, p.book.tags);
    const images = { id: 'pictures', kind: 'derived', template: 'https://img.example/{h}', media: ['image/*'] };
    const book = await openLibraryBook({ library: LIB, slug: 'demo', fetch: fakeLibrary([bookItem, webp], { stores: [images, STORE] }).fetch });
    expect(book.typeOf(webp.key)).toBe('image/webp');
    expect(book.urlOf(webp.key)).toBe(`https://img.example/${hashPart(webp.key)}`);
  });

  it('a book that names no store gets every store of the library it can read, not only the one for books', async () => {
    const p = await publish();
    const raw = JSON.parse(new TextDecoder().decode(p.book.bytes)) as Record<string, unknown>;
    delete raw.assetSources;
    const bookItem = await item(raw, p.book.type, p.book.tags);
    const images = { id: 'pictures', kind: 'derived', template: 'https://img.example/{h}', media: ['image/*'] };
    const indexed = { id: 'idx', kind: 'indexed', base: 'https://idx.example/' };
    const book = await openLibraryBook({ library: LIB, slug: 'demo', fetch: fakeLibrary([bookItem], { stores: [images, indexed, STORE] }).fetch });
    expect(book.index.assetSources?.map((s) => s.id)).toEqual(['pictures', 'library']);
  });

  it('a superseded or other book is not opened', async () => {
    const p = await publish();
    const superseded = { ...p.book, tags: p.book.tags.map((t) => (t === 'state:current' ? 'state:superseded' : t)) };
    await expect(openLibraryBook({ library: LIB, slug: 'demo', fetch: fakeLibrary([superseded]).fetch })).rejects.toThrow(/no current book/);
    await expect(openLibraryBook({ library: LIB, slug: 'other', fetch: fakeLibrary([p.book]).fetch })).rejects.toThrow(/no current book/);
  });

  it('refuses bytes that are not what their key names', async () => {
    const p = await publish();
    await expect(openLibraryBook({ library: LIB, slug: 'demo', fetch: fakeLibrary([p.book], { tamper: p.book.key }).fetch })).rejects.toThrow(/not c1:/);
    const book = await openLibraryBook({ library: LIB, slug: 'demo', fetch: fakeLibrary([p.book, p.pageItem], { tamper: p.pageItem.key }).fetch });
    await expect(book.read(book.index.pages[0]!.file)).rejects.toThrow(/not c1:/);
    await expect(book.read('pages/1-0000.json')).rejects.toThrow(/not a file/);
  });

  it('checks a sha256: id against its whole digest, not only the part its c1 key keeps', async () => {
    const p = await publish();
    const book = await openLibraryBook({ library: LIB, slug: 'demo', fetch: fakeLibrary([p.book, p.picture]).fetch });
    expect(await book.fetchItem(`sha256:${p.picture.sha256}`)).toEqual(p.picture.bytes);
    // the same c1 key (the first 130 bits), another digest: fetched from the same place, refused
    const last = p.picture.sha256.at(-1) === '0' ? '1' : '0';
    await expect(book.fetchItem(`sha256:${p.picture.sha256.slice(0, -1)}${last}`)).rejects.toThrow(/not sha256:/);
  });

  it('sends the token to a library that needs one (PUBLIC_READ=false)', async () => {
    const p = await publish();
    const items = [p.book, p.pageItem, p.textItem, p.linksItem, p.picture];
    await expect(openLibraryBook({ library: LIB, slug: 'demo', fetch: fakeLibrary(items, { token: 'sesame' }).fetch })).rejects.toThrow(/token is needed/);
    const lib = fakeLibrary(items, { token: 'sesame' });
    const book = await openLibraryBook({ library: LIB, slug: 'demo', token: 'sesame', fetch: lib.fetch });
    expect(book.key).toBe(p.book.key);
    expect(lib.calls).toContain('lib.example/v1/search (token)');
  });

  it('loads the links item, checked, or null when the book has none', async () => {
    const p = await publish();
    const lib = fakeLibrary([p.book, p.linksItem]);
    const book = await openLibraryBook({ library: LIB, slug: 'demo', fetch: lib.fetch });
    const links = await loadBookLinks(book);
    expect(links?.sentences[0]).toMatchObject({ id: 's1', pageId: 'p1' });
    expect(links?.links[0]?.role).toBe('answers_from');
    expect(await loadBookLinks({ ...book, links: null })).toBeNull();
  });

  it('rejects a book item without item keys', async () => {
    const bad = await item({ format: 'chalk.streamed', streamVersion: 1, formatVersion: 11, id: 'x', title: 'x', locale: 'en', createdAt: '', updatedAt: '', pages: [{ id: 'p1', file: 'pages/1.json' }], assets: [] },
      'application/vnd.chalk.book+json', ['book:demo', 'kind:book', 'state:current']);
    await expect(openLibraryBook({ library: LIB, slug: 'demo', fetch: fakeLibrary([bad]).fetch })).rejects.toThrow(/no item key/);
  });
});
