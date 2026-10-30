import { QUESTION_MANIFEST_TYPE, questionAssetKeys, questionManifestSchema, resolutionKey, streamIndexSchema, verifyAssetBytes, type QuestionManifest, type StoreDescriptor, type StreamIndex, type StreamPage } from '@chalk-format/model';
import { createRegistryClient, type AssetRecord } from '../registry.js';
import { apiUrl, derivedUrl, hashPart, matchesType } from '../urls.js';
import { fetchWithToken, resolveToken, type TokenSource } from '../auth/token.js';
import {
  LIBRARY_BOOK_TYPE, LIBRARY_LINKS_TYPE, LIBRARY_PAGE_TYPE, LIBRARY_TEXT_TYPE, checkLibraryBook, checkLinks, isKnownLinkRole, libraryBookSchema, libraryLinksSchema,
  type LibraryBook, type LibraryBookPage, type LibraryLinks,
} from './schema.js';

/**
 * Opening a book that lives in a library (spec 1.8, "Books in a library"), with nothing but the library: the current book item is found by
 * its tags and checked as a book item (§3.1), and every item it names (pages, the text layer, the links, the media, the questions) is fetched
 * by its key and checked against that key: from the library's store, else from the stores the book suggests (`assetSources`, §7 step 1). What comes back is a spec 1.4 streamed book, so the reader's streamed path draws it page by page as it does any other;
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
  /** The book item as published, checked against `libraryBookSchema` and `checkLibraryBook`. */
  item: LibraryBook;
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
   * picks the store (default: `typeOf(id)`). From the library's store for the type; if it has no such store, or that store fails (not there,
   * or bytes that are not the id), from the stores the book suggests (`assetSources`) that take the type, in order.
   */
  fetchItem(id: string, init?: { signal?: AbortSignal; type?: string }): Promise<Uint8Array>;
  /**
   * The media type of an id: what the book gives an asset or one of its renditions, the links item's, a question manifest's for the questions
   * of the links (once `loadBookLinks` has read them), `image/*` for the pictures of a question (once `loadQuestion` has read it);
   * `application/octet-stream` otherwise.
   */
  typeOf(id: string): string;
  /** Where the library's store delivers an item or a media file, or null for an id the library cannot name. */
  urlOf(id: string, type?: string): string | null;
  /**
   * The library's store for a type: the first of `GET /v1/stores` (derived or api) whose `media` take it. Items and media come from these first;
   * the book's suggested stores only when the library's fails (`fetchItem`).
   */
  storeFor(type: string): StoreDescriptor | null;
  /**
   * Every store `fetchItem` tries for a type, in order: the library's (its first that takes the type; for a type whose format is not known,
   * `image/*`, each that takes it), then those the book suggests that take it. Empty: no store of the library or the book can deliver it.
   */
  storesFor(type: string): StoreDescriptor[];
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

/** A store this loader can address: derived or api (an indexed store needs its index, a bundle is not a store to fetch from by key). */
const addressable = (d: StoreDescriptor) => d.kind === 'derived' || d.kind === 'api';

/**
 * Whether a store's `media` take a type. `image/*` is a picture whose format is not known (a question's, spec 1.7: its manifest lists the key
 * only): a store that takes any image takes it.
 */
function takes(media: readonly string[] | undefined, type: string): boolean {
  const [t, s] = type.toLowerCase().split(';')[0]!.trim().split('/');
  if (s !== '*') return matchesType(media, type);
  return !media?.length || media.some((p) => { const pt = p.toLowerCase().split('/')[0]; return pt === '*' || pt === t; });
}

/** The store to read a type from: the first of the library's own (`GET /v1/stores`) that this loader can address and that takes the type. */
const pickStore = (stores: readonly StoreDescriptor[], type: string) => stores.find((d) => addressable(d) && takes(d.media, type)) ?? null;

const storeUrl = (s: StoreDescriptor, key: string) => (s.kind === 'derived' ? derivedUrl(s, key) : apiUrl(s, key));

/** What the zod issues of a refused item say, shortly. */
const issues = (e: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }) =>
  `${e.issues.slice(0, 3).map((i) => `${i.path.map(String).join('.') || '(top)'}: ${i.message}`).join('; ')}${e.issues.length > 3 ? ` (and ${e.issues.length - 3} more)` : ''}`;
const some = (problems: string[]) => `${problems.slice(0, 3).join('; ')}${problems.length > 3 ? ` (and ${problems.length - 3} more)` : ''}`;

/** A book item, checked as spec 1.8 §7 step 2 says: valid against `libraryBookSchema`, and no problems from `checkLibraryBook`. */
function bookItemOf(raw: unknown): LibraryBook {
  const r = libraryBookSchema.safeParse(raw);
  if (!r.success) throw new Error(`the book item is not a valid book item: ${issues(r.error)}`);
  const problems = checkLibraryBook(r.data);
  if (problems.length) throw new Error(`the book item is not a valid book item: ${some(problems)}`);
  return r.data;
}

/** Media types learned after the book was opened (the questions of its links, their pictures): `typeOf` answers them too. */
const LEARN = Symbol('learn types');
type Learning = { [LEARN]?: (types: Iterable<readonly [string, string]>) => void };
const learn = (book: OpenedLibraryBook, types: Iterable<readonly [string, string]>) => (book as OpenedLibraryBook & Learning)[LEARN]?.(types);

/** Finds, fetches and checks the current book item of `slug`, and returns it as a streamed book whose files are library items. */
export async function openLibraryBook(o: OpenLibraryBookOptions): Promise<OpenedLibraryBook> {
  const doFetch = o.fetch ?? globalThis.fetch.bind(globalThis);
  const c = createRegistryClient(o.library, { ...(o.token ? { token: o.token } : {}), ...(o.fetch ? { fetch: o.fetch } : {}) });
  const [record, stores] = await Promise.all([findCurrentBookItem(o), c.stores().then((r) => r.items)]);
  if (!record) throw new Error(`the library has no current book "${o.slug}"`);

  // the library's own stores first (the host's, spec 1.8 §7 step 1): everything is read from the library asked for, even when the book names
  // another copy of it in `assetSources` (a mirror, a test library). Each type from the first of its stores that takes it. The book's
  // suggested stores come after, for an item that store does not have: never sent a token (a book names no store that needs one).
  const storeFor = (type: string) => pickStore(stores, type);
  let suggested: StoreDescriptor[] = [];
  // a picture whose format is not known may be in any of the library's image stores (a webp-only one, then a png-only one): each is tried
  const ownFor = (type: string) => (type.endsWith('/*') ? stores.filter((d) => addressable(d) && takes(d.media, type)) : [storeFor(type)].filter((d) => d !== null));
  const storesFor = (type: string) => [...ownFor(type), ...suggested.filter((s) => takes(s.media, type))];
  const headersOf = async (s: StoreDescriptor): Promise<Record<string, string>> => {
    const t = s.auth === 'bearer' ? await resolveToken(o.token) : undefined;
    return t ? { Authorization: `Bearer ${t}` } : {};
  };
  // a `sha256:` id is fetched by its c1 key but checked against the whole digest it names
  const get = async (id: string, type: string, signal?: AbortSignal): Promise<Uint8Array> => {
    const key = resolutionKey(id);
    if (!key) throw new Error(`${id} is not a content key`);
    const own = new Set(ownFor(type));
    const tries = storesFor(type);
    if (!tries.length) throw new Error(`the library names no store for ${type}`);
    const init = signal ? { signal } : {};
    const asked = new Set<string>();
    let first: unknown;
    for (const s of tries) {
      const url = storeUrl(s, key);
      // the book's copy of the library's own store: the same URL, asked once
      if (asked.has(url)) continue;
      asked.add(url);
      const from = own.has(s) ? 'the library' : `the book's store ${s.id}`;
      try {
        // the token only to the library's store that asks for it (a public CDN is not sent it)
        const r = own.has(s) && s.auth === 'bearer' ? await fetchWithToken(doFetch, o.token, url, init) : await doFetch(url, { headers: {}, ...init });
        if (!r.ok) throw new Error(`could not fetch ${id} from ${from} (${r.status})`);
        const bytes = new Uint8Array(await r.arrayBuffer());
        if (!(await verifyAssetBytes(id, bytes))) throw new Error(`${from} sent bytes that are not ${id}`);
        return bytes;
      } catch (e) {
        if (signal?.aborted) throw e;
        first ??= e;
      }
    }
    throw first instanceof Error ? first : new Error(`could not fetch ${id}: ${String(first)}`);
  };
  const store = storeFor(LIBRARY_BOOK_TYPE);
  if (!store) throw new Error('the library names no store to read books from');

  const bytes = await get(record.key, LIBRARY_BOOK_TYPE);
  const item = bookItemOf(JSON.parse(dec.decode(bytes)));
  suggested = item.assetSources.filter((d) => addressable(d) && d.auth !== 'bearer');

  const files = new Map<string, { key: string; type: string }>();
  const toFile = (p: LibraryBookPage): StreamPage => {
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
  });
  const indexBytes = enc.encode(JSON.stringify(index));
  const types = new Map<string, string>(index.assets.flatMap((a) => [[a.id, a.type] as const, ...(a.renditions ?? []).map((x) => [x.id, x.type] as const)]));
  if (links) types.set(links, LIBRARY_LINKS_TYPE);
  const typeOf = (id: string) => types.get(id) ?? 'application/octet-stream';

  const book: OpenedLibraryBook & Learning = {
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
    typeOf,
    fetchItem: (id, init) => get(id, init?.type ?? typeOf(id), init?.signal),
    urlOf(id, type) { const k = resolutionKey(id), s = storeFor(type ?? typeOf(id)); return k && s ? storeUrl(s, k) : null; },
    storeFor: (type) => storeFor(type),
    storesFor,
    async headersFor(type) { const s = storeFor(type); return s ? headersOf(s) : {}; },
    // what the book says comes first: a type learned later never changes one it gives
    [LEARN]: (learned) => { for (const [id, type] of learned) if (!types.has(id)) types.set(id, type); },
  };
  return book;
}

/**
 * The links item of a library book (which sentence has which questions), fetched and checked (`libraryLinksSchema`, `checkLinks` against the
 * book's pages); null if the book has none. Only the links whose role this version knows (`LINK_ROLES`) are kept, and the sentences that
 * still have one: spec 1.8 §3.4 says a reader skips a link whose role it does not know, so a host never sees one.
 */
export async function loadBookLinks(book: OpenedLibraryBook, init?: { signal?: AbortSignal }): Promise<LibraryLinks | null> {
  if (!book.links) return null;
  const r = libraryLinksSchema.safeParse(JSON.parse(dec.decode(await book.fetchItem(book.links, { ...init, type: LIBRARY_LINKS_TYPE }))));
  if (!r.success) throw new Error(`${book.links} is not a links item (${LIBRARY_LINKS_TYPE}): ${issues(r.error)}`);
  const problems = checkLinks(r.data, [...book.item.pages, ...(book.item.snipPages ?? [])].map((p) => p.id));
  if (problems.length) throw new Error(`${book.links} is not a valid links item: ${some(problems)}`);
  const links = r.data.links.filter((l) => isKnownLinkRole(l.role));
  const linked = new Set(links.map((l) => l.sentence));
  learn(book, links.map((l) => [l.question, QUESTION_MANIFEST_TYPE] as const));
  return { ...r.data, sentences: r.data.sentences.filter((s) => linked.has(s.id)), links };
}

/**
 * A question manifest (spec 1.7) of the library by its key (a `question` of the links item), fetched as `application/vnd.chalk.question+json`,
 * checked against its key and against `questionManifestSchema`. Its pictures are then fetched with `book.fetchItem` like any other id (their
 * type is `image/*`: the manifest lists their keys only). A kind this version does not know is not refused (1.7); `checkQuestion` says what
 * else may be wrong with it.
 */
export async function loadQuestion(book: OpenedLibraryBook, key: string, init?: { signal?: AbortSignal }): Promise<QuestionManifest> {
  const r = questionManifestSchema.safeParse(JSON.parse(dec.decode(await book.fetchItem(key, { ...init, type: QUESTION_MANIFEST_TYPE }))));
  if (!r.success) throw new Error(`${key} is not a question manifest (${QUESTION_MANIFEST_TYPE}): ${issues(r.error)}`);
  learn(book, [[key, QUESTION_MANIFEST_TYPE], ...[...(r.data.assets ?? []), ...questionAssetKeys(r.data)].map((k) => [k, 'image/*'] as const)]);
  return r.data;
}
