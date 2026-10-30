import { C1_KEY_PATTERN, resolutionKey, streamIndexSchema, verifyAssetBytes, type StoreDescriptor, type StreamIndex, type StreamPage } from '@chalk-format/model';
import { createRegistryClient, type AssetRecord } from '../registry.js';
import { apiUrl, derivedUrl, hashPart, matchesType } from '../urls.js';
import { fetchWithToken, resolveToken, type TokenSource } from '../auth/token.js';
import { LIBRARY_BOOK_TYPE, LIBRARY_LINKS_TYPE, LIBRARY_PAGE_TYPE, LIBRARY_TEXT_TYPE, type BookItem, type BookItemPage, type BookLinks } from './load-types.js';

/**
 * Opening a book that lives in a library (spec 1.8, "Books in a library"), with nothing but the library: the current book item is found by
 * its tags, and every item it names (pages, the text layer, the links, the media) is fetched from the library's store by its key and checked
 * against that key. What comes back is a spec 1.4 streamed book, so the reader's streamed path draws it page by page as it does any other;
 * `read` also suits `assembleStreamed` (@chalk-format/container) for the whole book at once.
 */

export type OpenLibraryBookOptions = {
  /** The library server (registry API base URL). */
  library: string;
  /** The book's slug: its items carry the tag `book:<slug>`. */
  slug: string;
  /**
   * Sent as `Authorization: Bearer <token>` to the API (a library with PUBLIC_READ=false), and to a store that asks for it (`auth: 'bearer'`).
   * A token, or a function giving the current one (a sign-in: `libraryAuth(...).token`), which is asked again once after a 401.
   */
  token?: TokenSource | undefined;
  fetch?: typeof fetch;
};

export type OpenedLibraryBook = {
  library: string;
  slug: string;
  /** The book item's key and its library record (tags, createdAt). */
  key: string;
  record: AssetRecord;
  /** From the `book-revision:<n>` tag, when there is one. */
  revision: number | null;
  /** The book item as published. */
  item: BookItem;
  /** The same book as a spec 1.4 index: every page, snip page and the text layer get a `file` (a name made from its key, read with `read`). */
  index: StreamIndex;
  /** The exact bytes of the book item (its key is their hash). */
  bytes: Uint8Array;
  /** The key of the links item, or null if the book has none. */
  links: string | null;
  /** The item key behind a `file` of `index`, or undefined. */
  keyOf(path: string): string | undefined;
  /** A file of `index` (or `book.json`: `index` itself), fetched and checked against its key. */
  read(path: string, init?: { signal?: AbortSignal }): Promise<Uint8Array>;
  /**
   * Any item of the library by its content id (a c1 key, or a `sha256:` id, fetched by its c1 key), checked against that id in full. `type`
   * picks the store (default: the type the book gives the id).
   */
  fetchItem(id: string, init?: { signal?: AbortSignal; type?: string }): Promise<Uint8Array>;
  /** Where the library's store delivers an item or a media file, or null for an id the library cannot name. */
  urlOf(id: string, type?: string): string | null;
  /** The library's store for a type: the first of `GET /v1/stores` (derived or api) whose `media` take it. Items and media come from these. */
  storeFor(type: string): StoreDescriptor | null;
  /** Headers a fetch from that store needs (a bearer token for a store with `auth: 'bearer'`, the current one when the token is a function). */
  headersFor(type: string): Promise<Record<string, string>>;
};

const enc = new TextEncoder(), dec = new TextDecoder();
/** How many pages of search results are read at most while looking for the current book item. */
const MAX_SEARCH_PAGES = 10;

/** The current book item of a slug: tagged `state:current`; of two current ones, the newest `createdAt` (contract "Discovery"). */
export async function findCurrentBookItem(o: OpenLibraryBookOptions): Promise<AssetRecord | null> {
  const c = createRegistryClient(o.library, { ...(o.token ? { token: o.token } : {}), ...(o.fetch ? { fetch: o.fetch } : {}) });
  const found: AssetRecord[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < MAX_SEARCH_PAGES; i++) {
    const page = await c.search({ tag: [`book:${o.slug}`, 'kind:book', 'state:current'], limit: 100, ...(cursor ? { cursor } : {}) });
    found.push(...page.items);
    if (!page.next) break;
    cursor = page.next;
  }
  const items = found.filter((r) => r.status === 'available' && r.type === LIBRARY_BOOK_TYPE);
  // later createdAt first; the same time, the larger key (spec 1.8, as pickCurrentBook)
  const time = (r: AssetRecord) => { const t = Date.parse(r.createdAt); return Number.isNaN(t) ? -Infinity : t; };
  items.sort((a, b) => time(b) - time(a) || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  return items[0] ?? null;
}

/** The store to read a type from: the first of the library's own (`GET /v1/stores`) that this loader can address (derived or api) and that takes the type. */
const pickStore = (stores: readonly StoreDescriptor[], type: string) => stores.find((d) => (d.kind === 'derived' || d.kind === 'api') && matchesType(d.media, type)) ?? null;

const storeUrl = (s: StoreDescriptor, key: string) => (s.kind === 'derived' ? derivedUrl(s, key) : apiUrl(s, key));

function bookItemOf(raw: unknown): BookItem {
  const b = raw as Partial<BookItem> | null;
  if (!b || typeof b !== 'object' || b.format !== 'chalk.streamed' || !Array.isArray(b.pages)) throw new Error('the book item is not a Chalk book');
  for (const p of [...b.pages, ...(b.snipPages ?? [])]) {
    if (typeof p?.key !== 'string' || !C1_KEY_PATTERN.test(p.key)) throw new Error(`page ${String(p?.id)} of the book item has no item key`);
  }
  if (b.text && (typeof b.text.key !== 'string' || !C1_KEY_PATTERN.test(b.text.key))) throw new Error('the text layer of the book item has no item key');
  if (b.links !== undefined && (typeof b.links !== 'string' || !C1_KEY_PATTERN.test(b.links))) throw new Error('the links of the book item are not an item key');
  return b as BookItem;
}

/** Finds, fetches and checks the current book item of `slug`, and returns it as a streamed book whose files are library items. */
export async function openLibraryBook(o: OpenLibraryBookOptions): Promise<OpenedLibraryBook> {
  const doFetch = o.fetch ?? globalThis.fetch.bind(globalThis);
  const c = createRegistryClient(o.library, { ...(o.token ? { token: o.token } : {}), ...(o.fetch ? { fetch: o.fetch } : {}) });
  const [record, stores] = await Promise.all([findCurrentBookItem(o), c.stores().then((r) => r.items)]);
  if (!record) throw new Error(`the library has no current book "${o.slug}"`);

  // everything is read from the library asked for, even when the book names another copy of it in `assetSources` (a mirror, a test library):
  // the publisher put every item of the book here before the book item, so it is all here. Each type from the first of its stores that takes it.
  const storeFor = (type: string) => pickStore(stores, type);
  const headersOf = async (s: StoreDescriptor): Promise<Record<string, string>> => {
    const t = s.auth === 'bearer' ? await resolveToken(o.token) : undefined;
    return t ? { Authorization: `Bearer ${t}` } : {};
  };
  // a `sha256:` id is fetched by its c1 key but checked against the whole digest it names
  const get = async (id: string, type: string, signal?: AbortSignal): Promise<Uint8Array> => {
    const key = resolutionKey(id);
    if (!key) throw new Error(`${id} is not a content key`);
    const s = storeFor(type);
    if (!s) throw new Error(`the library names no store for ${type}`);
    const init = signal ? { signal } : {};
    // the token only to a store that asks for it (a public CDN is not sent it)
    const r = s.auth === 'bearer' ? await fetchWithToken(doFetch, o.token, storeUrl(s, key), init) : await doFetch(storeUrl(s, key), { headers: {}, ...init });
    if (!r.ok) throw new Error(`could not fetch ${id} from the library (${r.status})`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (!(await verifyAssetBytes(id, bytes))) throw new Error(`the library sent bytes that are not ${id}`);
    return bytes;
  };
  const store = storeFor(LIBRARY_BOOK_TYPE);
  if (!store) throw new Error('the library names no store to read books from');

  const bytes = await get(record.key, LIBRARY_BOOK_TYPE);
  const item = bookItemOf(JSON.parse(dec.decode(bytes)));

  const files = new Map<string, { key: string; type: string }>();
  const toFile = (p: BookItemPage): StreamPage => {
    const file = `items/${hashPart(p.key)}.json`;
    files.set(file, { key: p.key, type: LIBRARY_PAGE_TYPE });
    const entry: Record<string, unknown> = { ...p, file };
    delete entry.key;
    return entry as StreamPage;
  };
  const { links, text: textItem, ...rest } = item;
  if (textItem) files.set(`items/${hashPart(textItem.key)}.json`, { key: textItem.key, type: LIBRARY_TEXT_TYPE });
  const index = streamIndexSchema.parse({
    ...rest,
    pages: item.pages.map(toFile),
    ...(item.snipPages ? { snipPages: item.snipPages.map(toFile) } : {}),
    ...(textItem ? { text: { file: `items/${hashPart(textItem.key)}.json`, ...(textItem.bytes !== undefined ? { bytes: textItem.bytes } : {}) } } : {}),
    // every asset is external in a library book: a `path` would name nothing
    assets: item.assets.map(({ path: _path, ...a }) => a),
    assetSources: item.assetSources?.length ? item.assetSources : [store],
  });
  const indexBytes = enc.encode(JSON.stringify(index));
  const assetTypes = new Map(index.assets.map((a) => [a.id, a.type]));
  const typeOf = (id: string) => (id === links ? LIBRARY_LINKS_TYPE : assetTypes.get(id) ?? 'application/octet-stream');

  const book: OpenedLibraryBook = {
    library: o.library, slug: o.slug, key: record.key, record, item, index, bytes,
    revision: (() => { const t = record.tags?.find((x) => x.startsWith('book-revision:')); const n = t ? Number(t.slice('book-revision:'.length)) : NaN; return Number.isInteger(n) ? n : null; })(),
    links: links ?? null,
    keyOf: (path) => files.get(path)?.key,
    async read(path, init) {
      if (path === 'book.json') return indexBytes;
      const f = files.get(path);
      if (!f) throw new Error(`${path} is not a file of this book`);
      return get(f.key, f.type, init?.signal);
    },
    fetchItem: (id, init) => get(id, init?.type ?? typeOf(id), init?.signal),
    urlOf(id, type) { const k = resolutionKey(id), s = storeFor(type ?? typeOf(id)); return k && s ? storeUrl(s, k) : null; },
    storeFor: (type) => storeFor(type),
    async headersFor(type) { const s = storeFor(type); return s ? headersOf(s) : {}; },
  };
  return book;
}

/** The links item of a library book (which sentence has which questions), fetched and checked; null if the book has none. */
export async function loadBookLinks(book: OpenedLibraryBook, init?: { signal?: AbortSignal }): Promise<BookLinks | null> {
  if (!book.links) return null;
  const raw = JSON.parse(dec.decode(await book.fetchItem(book.links, { ...init, type: LIBRARY_LINKS_TYPE }))) as Partial<BookLinks> | null;
  if (!raw || raw.format !== 'chalk-links' || raw.version !== 1 || !Array.isArray(raw.sentences) || !Array.isArray(raw.links)) {
    throw new Error(`${book.links} is not a links item (${LIBRARY_LINKS_TYPE})`);
  }
  return raw as BookLinks;
}

