import { describe, expect, it } from 'vitest';
import { assetKeyAndSha256, QUESTION_MANIFEST_TYPE } from '@chalk-format/model';
import { loadBookLinks, loadQuestion, openLibraryBook, resolveQuestions } from './load.js';
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
type Link = { sentence: string; question: string; role: string };
async function publish(o: { revision?: number; title?: string; createdAt?: string; links?: Link[]; sentences?: string[] } = {}) {
  const picture = await item(new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3]), 'image/webp');
  const page = { id: 'p1', title: 'One', width: 800, height: 600, background: { type: 'image', assetId: picture.key }, objects: [] };
  const pageItem = await item(page, 'application/vnd.chalk.page+json', ['kind:page']);
  const textItem = await item({ v: 1, pages: { p1: [{ text: 'দোলক', x: 10, y: 10, width: 40, fontSize: 12 }] } }, 'application/vnd.chalk.text+json', ['kind:text']);
  const linksItem = await item({
    format: 'chalk-links', version: 1, book: 'demo', bookRevision: o.revision ?? 1,
    sentences: (o.sentences ?? ['s1']).map((id) => ({ id, page: 1, pageId: 'p1', rects: [[0.1, 0.1, 0.5, 0.05]], text: 'দোলক' })),
    links: o.links ?? [{ sentence: 's1', question: 'c1:aaaaaaaaaaaaaaaaaaaaaaaaaa', role: 'answers_from' }],
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
function fakeLibrary(items: Item[], o: { current?: 'off' | 'missing-405' | 'fail'; token?: string; tamper?: string; stores?: unknown[]; mirror?: Item[]; mirrorTamper?: string } = {}) {
  const calls: string[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const u = new URL(String(url));
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    calls.push(`${u.host}${u.pathname}${auth ? ' (token)' : ''}`);
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    if (u.host === 'lib.example') {
      if (o.token && auth !== `Bearer ${o.token}` && u.pathname !== '/v1/stores') return json({ error: { code: 'unauthorized', message: 'a token is needed' } }, 401);
      if (u.pathname === '/v1/stores') return json({ items: o.stores ?? [STORE] });
      if (u.pathname === '/v1/assets/current' && init?.method === 'POST') {
        calls.push('POST current');
        if (o.current === 'off') return json({ error: { code: 'not_found', message: 'no' } }, 404);
        if (o.current === 'missing-405') return json({ error: { code: 'method', message: 'no' } }, 405);
        if (o.current === 'fail') return json({ error: { code: 'internal', message: 'boom' } }, 500);
        const b = JSON.parse(String(init.body)) as { tags: string[]; require?: string[]; type?: string };
        const need = b.require ?? ['state:current'];
        return json({ items: Object.fromEntries(b.tags.map((t) => {
          const best = items.filter((i) => i.tags.includes(t) && need.every((n) => i.tags.includes(n)) && (!b.type || i.type === b.type)).sort((x, y) => y.createdAt.localeCompare(x.createdAt) || (x.key < y.key ? 1 : -1))[0];
          return [t, best ? { key: best.key, sha256: best.sha256, type: best.type, size: best.bytes.byteLength, tags: best.tags, status: 'available', createdAt: best.createdAt } : null];
        })) });
      }
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
    // the store the book suggests (its `assetSources`): another copy, with what it holds
    if (u.host === 'elsewhere.example') {
      const hit = (o.mirror ?? []).find((i) => u.pathname === `/c1/${hashPart(i.key).slice(0, 2)}/${hashPart(i.key).slice(2, 4)}/${hashPart(i.key)}`);
      if (!hit) return new Response('not found', { status: 404 });
      return new Response((hit.key === o.mirrorTamper ? enc.encode('something else') : hit.bytes) as unknown as BodyInit, { status: 200 });
    }
    // a store of the library that keeps only images, or only questions
    if (u.host === 'img.example' || u.host === 'q.example') {
      const hit = items.find((i) => u.pathname === `/${hashPart(i.key)}`);
      return hit ? new Response(hit.bytes as unknown as BodyInit, { status: 200 }) : new Response('not found', { status: 404 });
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

  it('refuses a book item that is not a valid book item (spec 1.8 §7 step 2): no stores, a store that needs a token, an asset it does not list', async () => {
    const p = await publish();
    const raw = () => JSON.parse(new TextDecoder().decode(p.book.bytes)) as Record<string, unknown> & { assetSources: unknown[]; pages: { assets?: string[] }[] };
    const open = async (b: unknown) => openLibraryBook({ library: LIB, slug: 'demo', fetch: fakeLibrary([await item(b, p.book.type, p.book.tags)]).fetch });
    const none = raw();
    delete (none as Record<string, unknown>).assetSources;
    await expect(open(none)).rejects.toThrow(/not a valid book item: assetSources/);
    const bearer = raw();
    bearer.assetSources = [{ id: 'private', kind: 'derived', template: 'https://x.example/{h}', auth: 'bearer' }];
    await expect(open(bearer)).rejects.toThrow(/not a valid book item: store private/);
    const unlisted = raw();
    unlisted.pages[0]!.assets = ['c1:bbbbbbbbbbbbbbbbbbbbbbbbba'];
    await expect(open(unlisted)).rejects.toThrow(/not a valid book item: page p1: c1:b+a is not in assets/);
    const path = raw();
    (path.assets as Record<string, unknown>[])[0]!.path = 'assets/picture.webp';
    await expect(open(path)).rejects.toThrow(/not a valid book item: assets\.0\.path/);
  });

  it('opens a book whose assets have sha256: ids (the page files keep the ids they were written with), and fetches them by their c1 key', async () => {
    const p = await publish();
    const sha = `sha256:${p.picture.sha256}`;
    const raw = JSON.parse(new TextDecoder().decode(p.book.bytes)) as Record<string, unknown> & { pages: Record<string, unknown>[]; assets: Record<string, unknown>[] };
    raw.pages[0]!.assets = [sha];
    raw.pages[0]!.thumb = sha;
    raw.coverAssetId = sha;
    raw.assets[0]!.id = sha;
    const bookItem = await item(raw, p.book.type, p.book.tags);
    const book = await openLibraryBook({ library: LIB, slug: 'demo', fetch: fakeLibrary([bookItem, p.pageItem, p.picture]).fetch });
    expect(book.item.assets[0]!.id).toBe(sha);
    expect(book.index.coverAssetId).toBe(sha);
    expect(book.typeOf(sha)).toBe('image/webp');
    expect(book.urlOf(sha)).toBe(at(p.picture.key));
    expect(await book.fetchItem(sha)).toEqual(p.picture.bytes);
  });

  it("fetches what the library's store does not have from the stores the book suggests, checked, and only then", async () => {
    const p = await publish();
    const lib = fakeLibrary([p.book, p.pageItem], { mirror: [p.picture, p.textItem] });
    const book = await openLibraryBook({ library: LIB, slug: 'demo', fetch: lib.fetch });
    await book.read(book.index.pages[0]!.file);
    expect(lib.calls.some((c) => c.startsWith('elsewhere.example'))).toBe(false);
    expect(await book.fetchItem(p.picture.key)).toEqual(p.picture.bytes);
    expect(JSON.parse(new TextDecoder().decode(await book.read(book.index.text!.file)))).toMatchObject({ v: 1 });
    expect(lib.calls.filter((c) => c.startsWith('elsewhere.example'))).toHaveLength(2);
    // the library's error when no store has it, and bytes that fail their key from the book's store are refused too
    await expect(book.fetchItem(p.linksItem.key)).rejects.toThrow(/could not fetch .* from the library \(404\)/);
    const bad = await openLibraryBook({ library: LIB, slug: 'demo', fetch: fakeLibrary([p.book], { mirror: [p.picture], mirrorTamper: p.picture.key }).fetch });
    await expect(bad.fetchItem(p.picture.key)).rejects.toThrow(/from the library \(404\)/);
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

  it('gives the host only the links whose role this version knows, and the sentences that still have one (spec 1.8 §3.4)', async () => {
    const q = (c: string) => `c1:${c.repeat(25)}a`;
    const p = await publish({
      sentences: ['s1', 's2', 's3'],
      links: [
        { sentence: 's1', question: q('a'), role: 'answers_from' },
        { sentence: 's1', question: q('b'), role: 'formula_source' },
        { sentence: 's2', question: q('c'), role: 'tests_concept' },
        { sentence: 's2', question: q('d'), role: 'uses_figure' },
        { sentence: 's2', question: q('e'), role: 'explains' },
        { sentence: 's3', question: q('f'), role: 'explains' },
      ],
    });
    const book = await openLibraryBook({ library: LIB, slug: 'demo', fetch: fakeLibrary([p.book, p.linksItem]).fetch });
    const links = await loadBookLinks(book);
    expect(links?.links.map((l) => l.role)).toEqual(['answers_from', 'formula_source', 'tests_concept', 'uses_figure']);
    expect(links?.sentences.map((s) => s.id)).toEqual(['s1', 's2']);
  });

  it('refuses a links item that is not one, or that names a page the book does not have', async () => {
    const p = await publish();
    const raw = JSON.parse(new TextDecoder().decode(p.linksItem.bytes)) as { sentences: { pageId: string; rects: number[][] }[] };
    const withLinks = async (l: unknown) => {
      const li = await item(l, p.linksItem.type);
      const b = JSON.parse(new TextDecoder().decode(p.book.bytes)) as Record<string, unknown>;
      const bi = await item({ ...b, links: li.key }, p.book.type, p.book.tags);
      return loadBookLinks(await openLibraryBook({ library: LIB, slug: 'demo', fetch: fakeLibrary([bi, li]).fetch }));
    };
    await expect(withLinks({ ...raw, sentences: [{ ...raw.sentences[0], rects: [[0, 0, 2, 1]] }] })).rejects.toThrow(/not a links item/);
    await expect(withLinks({ ...raw, sentences: [{ ...raw.sentences[0], pageId: 'p9' }] })).rejects.toThrow(/page p9 is not in the book/);
  });

  it('types the questions of the links and their pictures, so a store that keeps only those types serves them', async () => {
    const pic = await item(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]), 'image/png');
    const question = await item({ format: 'chalk.question', manifestVersion: 1, id: 'q1', version: '1', kind: 'short_answer', stem: `কেন? ![দোলক](${pic.key})`, assets: [pic.key] }, QUESTION_MANIFEST_TYPE);
    const p = await publish({ links: [{ sentence: 's1', question: question.key, role: 'answers_from' }] });
    const images = { id: 'pictures', kind: 'derived', template: 'https://img.example/{h}', media: ['image/png'] };
    const questions = { id: 'questions', kind: 'derived', template: 'https://q.example/{h}', media: [QUESTION_MANIFEST_TYPE] };
    const books = { ...STORE, media: ['application/vnd.chalk.book+json', 'application/vnd.chalk.page+json', 'application/vnd.chalk.links+json'] };
    const lib = fakeLibrary([p.book, p.linksItem, question, pic], { stores: [images, questions, books] });
    const book = await openLibraryBook({ library: LIB, slug: 'demo', fetch: lib.fetch });
    expect(book.typeOf(question.key)).toBe('application/octet-stream');
    await loadBookLinks(book);
    expect(book.typeOf(question.key)).toBe(QUESTION_MANIFEST_TYPE);
    expect(await book.fetchItem(question.key)).toEqual(question.bytes);
    const m = await loadQuestion(book, question.key);
    expect(m.id).toBe('q1');
    expect(book.typeOf(pic.key)).toBe('image/*');
    expect(book.urlOf(pic.key)).toBe(`https://img.example/${hashPart(pic.key)}`);
    expect(await book.fetchItem(pic.key)).toEqual(pic.bytes);
    // a picture's format is not known: every image store of the library is tried (a webp-only one first, then one that has png)
    const webpOnly = { id: 'webp', kind: 'derived', template: 'https://webp.example/{h}', media: ['image/webp'] };
    const two = await openLibraryBook({ library: LIB, slug: 'demo', fetch: fakeLibrary([p.book, p.linksItem, question, pic], { stores: [webpOnly, images, questions, books] }).fetch });
    await loadQuestion(two, question.key);
    expect(two.storesFor('image/*').map((s) => s.id)).toEqual(['webp', 'pictures', 'library']);
    expect(await two.fetchItem(pic.key)).toEqual(pic.bytes);
    // a book's own type is never changed by what is learned later
    expect(book.typeOf(p.linksItem.key)).toBe('application/vnd.chalk.links+json');
  });

  it('rejects a book item without item keys', async () => {
    const bad = await item({ format: 'chalk.streamed', streamVersion: 1, formatVersion: 11, id: 'x', title: 'x', locale: 'en', createdAt: '', updatedAt: '', pages: [{ id: 'p1', file: 'pages/1.json' }], assets: [] },
      'application/vnd.chalk.book+json', ['book:demo', 'kind:book', 'state:current']);
    await expect(openLibraryBook({ library: LIB, slug: 'demo', fetch: fakeLibrary([bad]).fetch })).rejects.toThrow(/not a valid book item: pages\.0\.key/);
  });
});

describe('questions by lasting id (spec 1.8 §3.4)', () => {
  const ID = '2f6c0b1e-5d1a-4c52-9d0e-3b8a7a1c9e11', ID2 = '9a1d2c3e-0000-4000-8000-000000000002';
  const manifest = (stem: string) => ({ format: 'chalk.question', manifestVersion: 1, id: 'q1', version: '1', kind: 'short_answer', stem });
  async function setup(opts: { token?: string } = {}) {
    const v1 = await item(manifest('old stem'), QUESTION_MANIFEST_TYPE, [`question:${ID}`, 'state:superseded'], '2026-10-01T00:00:00Z');
    const v2 = await item(manifest('new stem'), QUESTION_MANIFEST_TYPE, [`question:${ID}`, 'state:current'], '2026-10-02T00:00:00Z');
    const other = await item(manifest('other stem'), QUESTION_MANIFEST_TYPE, [`question:${ID2}`, 'state:current']);
    const p = await publish({ sentences: ['s1', 's2'], links: [
      { sentence: 's1', question: v1.key, questionId: ID, role: 'answers_from' }, { sentence: 's2', question: other.key, questionId: ID2, role: 'tests_concept' },
      { sentence: 's2', question: v1.key, role: 'future_role', questionId: ID },
    ] as never });
    return { v1, v2, other, p, items: [p.book, p.linksItem, v1, v2, other] };
  }

  it('loadBookLinks keeps questionId; unknown roles are still filtered', async () => {
    const t = await setup();
    const book = await openLibraryBook({ library: LIB, slug: 'demo', fetch: fakeLibrary(t.items).fetch });
    const links = await loadBookLinks(book);
    expect(links!.links.map((l) => [l.question, l.questionId, l.role])).toEqual([[t.v1.key, ID, 'answers_from'], [t.other.key, ID2, 'tests_concept']]);
  });

  it('resolves the CURRENT version of an id in one request, and checks it against its key', async () => {
    const t = await setup();
    const lib = fakeLibrary(t.items);
    const book = await openLibraryBook({ library: LIB, slug: 'demo', fetch: lib.fetch });
    await loadBookLinks(book);
    const { resolved, failed } = await resolveQuestions(book, [ID, ID2, ID]);
    expect([...failed]).toEqual([]);
    expect(resolved.get(ID)).toMatchObject({ key: t.v2.key, source: 'current' });
    expect(resolved.get(ID)!.manifest.stem).toBe('new stem');
    expect(resolved.get(ID2)).toMatchObject({ key: t.other.key, source: 'current' });
    expect(lib.calls.filter((c) => c === 'POST current')).toHaveLength(1);
    // loadQuestion by the link's old key gives the current version too; and by the id
    expect((await loadQuestion(book, t.v1.key)).stem).toBe('new stem');
    expect((await loadQuestion(book, ID)).stem).toBe('new stem');
    // cached by key: the manifest bytes are fetched once
    const fetched = lib.calls.filter((c) => c === `cdn.example${new URL(at(t.v2.key)).pathname}`).length;
    expect(fetched).toBe(1);
  });

  it('a tampered current manifest is refused and the link\'s key is used; the same for an id the library does not know', async () => {
    const t = await setup();
    const book = await openLibraryBook({ library: LIB, slug: 'demo', fetch: fakeLibrary(t.items, { tamper: t.v2.key }).fetch });
    await loadBookLinks(book);
    const { resolved } = await resolveQuestions(book, [ID]);
    expect(resolved.get(ID)).toMatchObject({ key: t.v1.key, source: 'link' });
    const lone = await openLibraryBook({ library: LIB, slug: 'demo', fetch: fakeLibrary([t.p.book, t.p.linksItem, t.v1]).fetch });
    await loadBookLinks(lone);
    expect((await resolveQuestions(lone, [ID])).resolved.get(ID)).toMatchObject({ key: t.v1.key, source: 'link' });
    // no link, no current version: failed, and loadQuestion says so
    const r = await resolveQuestions(lone, ['11111111-1111-4111-8111-111111111111']);
    expect(r.resolved.size).toBe(0);
    expect([...r.failed.keys()]).toEqual(['11111111-1111-4111-8111-111111111111']);
    await expect(loadQuestion(lone, '11111111-1111-4111-8111-111111111111')).rejects.toThrow(/no question/);
  });

  it.each(['off', 'missing-405', 'fail'] as const)('an older or failing server (%s): every id falls back to its link key', async (mode) => {
    const t = await setup();
    const lib = fakeLibrary(t.items, { current: mode });
    const book = await openLibraryBook({ library: LIB, slug: 'demo', fetch: lib.fetch });
    await loadBookLinks(book);
    const { resolved, failed } = await resolveQuestions(book, [ID, ID2]);
    expect(failed.size).toBe(0);
    expect(resolved.get(ID)).toMatchObject({ key: t.v1.key, source: 'link' });
    expect(resolved.get(ID2)).toMatchObject({ key: t.other.key, source: 'link' });
    // a missing endpoint is remembered; a failure is asked again
    await resolveQuestions(book, [ID]);
    expect(lib.calls.filter((c) => c === 'POST current')).toHaveLength(mode === 'fail' ? 2 : 1);
  });

  it('batches of 500 ids', async () => {
    const t = await setup();
    const lib = fakeLibrary(t.items);
    const book = await openLibraryBook({ library: LIB, slug: 'demo', fetch: lib.fetch });
    const ids = Array.from({ length: 1001 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const { resolved } = await resolveQuestions(book, [...ids, ID]);
    expect(lib.calls.filter((c) => c === 'POST current')).toHaveLength(3);
    expect([...resolved.keys()]).toEqual([ID]);
  });

  it('works with a token (a string or a function) in a library that needs one', async () => {
    const t = await setup();
    for (const token of ['tok', () => 'tok'] as const) {
      const lib = fakeLibrary(t.items, { token: 'tok' });
      const book = await openLibraryBook({ library: LIB, slug: 'demo', token, fetch: lib.fetch });
      await loadBookLinks(book);
      expect((await resolveQuestions(book, [ID])).resolved.get(ID)).toMatchObject({ key: t.v2.key, source: 'current' });
      expect(lib.calls).toContain('lib.example/v1/assets/current (token)');
    }
  });

  it('the links item is found by its tags (newest wins; the key the book names is the fallback)', async () => {
    const t = await setup();
    const fresh = await item({ ...JSON.parse(new TextDecoder().decode(t.p.linksItem.bytes)), bookRevision: 9, links: [{ sentence: 's1', question: t.v2.key, questionId: ID, role: 'answers_from' }], sentences: [{ id: 's1', page: 1, pageId: 'p1', rects: [], text: 'x' }] },
      'application/vnd.chalk.links+json', ['book:demo', 'kind:links', 'state:current'], '2026-10-05T00:00:00Z');
    const book = await openLibraryBook({ library: LIB, slug: 'demo', fetch: fakeLibrary([...t.items, fresh]).fetch });
    expect(book.links).toBe(fresh.key);
    expect((await loadBookLinks(book))!.links.map((l) => l.question)).toEqual([t.v2.key]);
    // no tagged links item: the one the book item names
    const plain = await openLibraryBook({ library: LIB, slug: 'demo', fetch: fakeLibrary(t.items).fetch });
    expect(plain.links).toBe(t.p.linksItem.key);
  });
});
