import { QUESTION_MANIFEST_TYPE, questionAssetKeys, questionManifestSchema, resolutionKey, streamIndexSchema, verifyAssetBytes, type QuestionManifest, type StoreDescriptor, type StreamIndex, type StreamPage } from '@chalk-format/model';
import { createRegistryClient, RegistryError, type AssetRecord, type RegistryClient } from '../registry.js';
import { apiUrl, derivedUrl, hashPart, matchesType } from '../urls.js';
import { fetchWithToken, resolveToken, type TokenSource } from '../auth/token.js';
// files adopted in place (registry-api §3.1): found through the library's indexed store (spec 1.2 §5.3)
import { indexShardSchema } from '@chalk-format/model';
import { shardOf, shardUrl } from '../urls.js';
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
  /**
   * Where the library's store delivers an item or a media file, or null for an id the library cannot name. For a type whose format is not
   * known (`image/*`) it is the first store that may have it: `fetchItem` asks each of them.
   */
  urlOf(id: string, type?: string): string | null;
  /**
   * Like `urlOf`, and right for files the library adopted in place (registry-api §3.1): those are not at the derived store's URL, and the
   * library's indexed store (spec 1.2 §5.3, after the derived one in `GET /v1/stores`) names where they are (its shard kept a minute). Null
   * when the item is in an indexed store that needs a token or asks to be verified always: then its bytes are to be fetched (`fetchItem`).
   */
  urlFor(id: string, type?: string, init?: { signal?: AbortSignal }): Promise<string | null>;
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
  /**
   * Whether an id's bytes must be checked against it before they are shown, never drawn from a bare URL: a picture of a question `loadQuestion`
   * has read (spec 1.7 §4), even when the book's pages use it too.
   */
  mustCheck(id: string): boolean;
  /** Headers a fetch from that store needs (a bearer token for a store with `auth: 'bearer'`, the current one when the token is a function). */
  headersFor(type: string): Promise<Record<string, string>>;
};

const enc = new TextEncoder(), dec = new TextDecoder();
/** How many pages of search results are read at most while looking for the current book item. */
const MAX_SEARCH_PAGES = 10;

/** Search results, all pages (a few at most), for tags. */
async function searchAll(c: RegistryClient, tag: string[]): Promise<AssetRecord[]> {
  const found: AssetRecord[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < MAX_SEARCH_PAGES; i++) {
    const page = await c.search({ tag, limit: 100, ...(cursor ? { cursor } : {}) });
    found.push(...page.items);
    if (!page.next) break;
    cursor = page.next;
  }
  return found;
}

/** The newest of the available items of a media type: later `createdAt` first; the same time, the larger key (spec 1.8 §5, as `pickCurrentBook`). */
function newestOf(found: AssetRecord[], type: string): AssetRecord | null {
  const items = found.filter((r) => r.status === 'available' && r.type === type);
  const time = (r: AssetRecord) => { const t = Date.parse(r.createdAt); return Number.isNaN(t) ? -Infinity : t; };
  items.sort((a, b) => time(b) - time(a) || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  return items[0] ?? null;
}

const clientOf = (o: OpenLibraryBookOptions) => createRegistryClient(o.library, { ...(o.token ? { token: o.token } : {}), ...(o.fetch ? { fetch: o.fetch } : {}) });

/** The current book item of a slug: tagged `state:current`; of two current ones, the newest `createdAt` (contract "Discovery"). */
export async function findCurrentBookItem(o: OpenLibraryBookOptions): Promise<AssetRecord | null> {
  return newestOf(await searchAll(clientOf(o), [`book:${o.slug}`, 'kind:book', 'state:current']), LIBRARY_BOOK_TYPE);
}

/** The current links item of a slug (spec 1.8 §3.4): `book:<slug>`, `kind:links`, `state:current`, the same rule as the book item. Null if the library has none. */
export async function findCurrentLinksItem(o: OpenLibraryBookOptions): Promise<AssetRecord | null> {
  return newestOf(await searchAll(clientOf(o), [`book:${o.slug}`, 'kind:links', 'state:current']), LIBRARY_LINKS_TYPE);
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
type Learning = { [LEARN]?: (types: Iterable<readonly [string, string]>, mustCheck?: boolean) => void };
const learn = (book: OpenedLibraryBook, types: Iterable<readonly [string, string]>, mustCheck?: boolean) => (book as OpenedLibraryBook & Learning)[LEARN]?.(types, mustCheck);

/** What the question functions remember about an opened book: the client, the keys links name for an id, the manifests already fetched. */
type BookState = {
  client: RegistryClient;
  /** question id (lower case: ids are asked as written, but looked up here without case) -> the `question` key of a link that names it (set by `loadBookLinks`): where to fall back to. */
  fallback: Map<string, string>;
  /** the other way round: a link's `question` key -> its id. */
  idOfKey: Map<string, string>;
  /** manifests fetched and checked, by key (a key is immutable: kept for the life of the book). */
  manifests: Map<string, QuestionManifest>;
  /** The library answered 404/405 to `POST v1/assets/current` (an older server): it is not asked again. */
  noCurrentEndpoint: boolean;
};
const bookStates = new WeakMap<object, BookState>();
const stateOf = (book: OpenedLibraryBook): BookState => {
  const s = bookStates.get(book);
  if (!s) throw new Error('not a book opened with openLibraryBook');
  return s;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Finds, fetches and checks the current book item of `slug`, and returns it as a streamed book whose files are library items. */
export async function openLibraryBook(o: OpenLibraryBookOptions): Promise<OpenedLibraryBook> {
  const doFetch = o.fetch ?? globalThis.fetch.bind(globalThis);
  const c = clientOf(o);
  // the links item is found by its tags too (spec 1.8 §3.4); the key the book names is the fallback when the search finds none or fails
  const [record, stores, currentLinks] = await Promise.all([findCurrentBookItem(o), c.stores().then((r) => r.items), findCurrentLinksItem(o).catch(() => null)]);
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
  // files the library adopted in place (registry-api §3.1) are found through its indexed stores (spec 1.2 §5.3), listed after the derived one.
  // The index lists exactly the keys the derived store does not have, so it is asked first (one shard per two leading characters, fetched once
  // per book) instead of fetching a derived URL that 404s for each of them. A token goes only to an indexed store that asks for it.
  // a shard is kept as long as the library says it may be cached (a minute), and dropped at once when a URL it named fails: the library moves an
  // adopted key to another copy when its owner deletes one (registry-api §3.1), and an open book must see that
  const SHARD_MS = 60_000;
  const shards = new Map<string, { at: number; shard: Promise<Map<string, string>> }>();
  const indexedFor = (type: string) => stores.filter((d) => d.kind === 'indexed' && d.base && takes(d.media, type));
  const inIndex = async (key: string, type: string, signal?: AbortSignal): Promise<{ url: string; store: StoreDescriptor; forget: () => void } | null> => {
    for (const s of indexedFor(type)) {
      const id = `${s.id}|${shardOf(key)}`, kept = shards.get(id);
      let shard = kept && Date.now() - kept.at < SHARD_MS ? kept.shard : undefined;
      if (!shard) {
        const url = shardUrl(s, key), init = signal ? { signal } : {};
        shard = (s.auth === 'bearer' ? fetchWithToken(doFetch, o.token, url, init) : doFetch(url, init)).then(async (r) => {
          if (r.status === 404) return new Map<string, string>();
          if (!r.ok) throw new Error(`index ${r.status}`);
          const entries = indexShardSchema.parse(await r.json()).entries;
          return new Map(Object.entries(entries).map(([h, e]) => [h, /^[a-z][a-z0-9+.-]*:/i.test(e.p) ? e.p : s.base + e.p] as const));
        });
        const entry = { at: Date.now(), shard };
        shards.set(id, entry);
        shard.catch(() => { if (shards.get(id) === entry) shards.delete(id); });   // a failed shard is asked again next time
      }
      const url = await shard.then((m) => m.get(hashPart(key))).catch(() => undefined);
      if (url) return { url, store: s, forget: () => shards.delete(id) };
    }
    return null;
  };
  // a `sha256:` id is fetched by its c1 key but checked against the whole digest it names
  const get = async (id: string, type: string, signal?: AbortSignal): Promise<Uint8Array> => {
    const key = resolutionKey(id);
    if (!key) throw new Error(`${id} is not a content key`);
    const adopted = await inIndex(key, type, signal);
    const own = new Set(ownFor(type));
    if (adopted) own.add(adopted.store);
    const tries: { s: StoreDescriptor; url: string; adopted?: typeof adopted }[] = [...(adopted ? [{ s: adopted.store, url: adopted.url, adopted }] : []), ...storesFor(type).map((s) => ({ s, url: storeUrl(s, key) }))];
    if (!tries.length) throw new Error(`the library names no store for ${type}`);
    const init = signal ? { signal } : {};
    const asked = new Set<string>();
    let first: unknown, again = true;
    for (let i = 0; i < tries.length; i++) {
      const { s, url } = tries[i]!;
      // the book's copy of the library's own store: the same URL, asked once
      if (asked.has(url)) continue;
      asked.add(url);
      const from = own.has(s) ? 'the library' : `the book's store ${s.id}`;
      try {
        // the token only to the library's store that asks for it (a public CDN is not sent it)
        const r = own.has(s) && s.auth === 'bearer' ? await fetchWithToken(doFetch, o.token, url, init) : await doFetch(url, { headers: {}, ...init });
        if (!r.ok && tries[i]!.adopted && again) {
          // the copy the index named is gone: the index is asked again (once), and the library may name another copy now
          again = false;
          tries[i]!.adopted!.forget();
          const next = await inIndex(key, type, signal);
          if (next && !asked.has(next.url)) { own.add(next.store); tries.splice(i + 1, 0, { s: next.store, url: next.url, adopted: next }); }
        }
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
  const { links: namedLinks, text: textItem, ...rest } = item;
  const links = currentLinks?.key ?? namedLinks;
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
  const checked = new Set<string>();

  const state: BookState = { client: c, fallback: new Map(), idOfKey: new Map(), manifests: new Map(), noCurrentEndpoint: false };
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
    async urlFor(id, type, init) {
      const k = resolutionKey(id), t = type ?? typeOf(id);
      const adopted = k ? await inIndex(k, t, init?.signal) : null;
      // a URL is drawn with no header and its bytes are not checked: an index that needs the token, or asks to be verified always, names
      // none (null: fetch the bytes with fetchItem, which checks them)
      if (adopted) return adopted.store.auth !== 'bearer' && adopted.store.verify !== 'always' ? adopted.url : null;
      return book.urlOf(id, t);
    },
    storeFor: (type) => storeFor(type),
    storesFor,
    async headersFor(type) { const s = storeFor(type); return s ? headersOf(s) : {}; },
    // what the book says comes first: a type learned later never changes one it gives
    mustCheck: (id) => checked.has(id),
    [LEARN]: (learned, mustCheck) => { for (const [id, type] of learned) { if (!types.has(id)) types.set(id, type); if (mustCheck) checked.add(id); } },
  };
  bookStates.set(book, state);
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
  const st = stateOf(book);
  for (const l of links) if (l.questionId) { const id = l.questionId, lower = id.toLowerCase(); if (!st.fallback.has(lower)) st.fallback.set(lower, l.question); st.idOfKey.set(l.question, id); }
  return { ...r.data, sentences: r.data.sentences.filter((s) => linked.has(s.id)), links };
}

/** A question manifest by its key, fetched, checked against the key and `questionManifestSchema`; the pictures it lists are learned (must be checked). Kept for the life of the book. */
async function manifestByKey(book: OpenedLibraryBook, key: string, init?: { signal?: AbortSignal }): Promise<QuestionManifest> {
  const st = stateOf(book);
  init?.signal?.throwIfAborted();
  const kept = st.manifests.get(key);
  if (kept) return structuredClone(kept);
  const r = questionManifestSchema.safeParse(JSON.parse(dec.decode(await book.fetchItem(key, { ...init, type: QUESTION_MANIFEST_TYPE }))));
  if (!r.success) throw new Error(`${key} is not a question manifest (${QUESTION_MANIFEST_TYPE}): ${issues(r.error)}`);
  learn(book, [[key, QUESTION_MANIFEST_TYPE]]);
  // spec 1.7 §4: a question's picture is checked against its key before it is shown, even one the book's pages also use
  learn(book, [...(r.data.assets ?? []), ...questionAssetKeys(r.data)].map((k) => [k, 'image/*'] as const), true);
  st.manifests.set(key, r.data);
  return structuredClone(r.data);
}

/** One question as `resolveQuestions` answers it. */
export type ResolvedQuestion = {
  /** The question's lasting id. */
  id: string;
  /** The key of the manifest that was used. */
  key: string;
  manifest: QuestionManifest;
  /** `current`: the library's current version of the id. `link`: the key a link of the book names (the library had no answer for the id, or could not be asked). */
  source: 'current' | 'link';
  /** For `source: 'link'` after the library named a current version that could not be used (its bytes are not its key, it is not a question manifest, a store failed): why. */
  currentError?: Error;
};

/** How many ids go in one `POST v1/assets/current` (the most the endpoint takes). */
const CURRENT_BATCH = 500;
/** How many manifests are fetched at once. */
const FETCH_AT_ONCE = 8;

/**
 * The questions with these lasting ids (spec 1.8 §3.4, "Current version by id"): for each id the library's **current** version, found with
 * `POST v1/assets/current` (tags `question:<id>`, in batches of 500), fetched and checked against its key. The links item need not change
 * when a question is corrected. For an id the library has no current version of, when the library lacks the endpoint (404/405: an older
 * server, remembered for this book) or cannot be asked, and when the current manifest cannot be fetched or checked, the key of the link that
 * names the id is used instead (`loadBookLinks` must have read the links, or give `fallback`: id -> key). An id with neither, or whose
 * fallback fails too, is in `failed`. Manifests are cached by key.
 */
export async function resolveQuestions(book: OpenedLibraryBook, ids: readonly string[], init?: { signal?: AbortSignal; fallback?: Readonly<Record<string, string>> }):
  Promise<{ resolved: Map<string, ResolvedQuestion>; failed: Map<string, Error> }> {
  const st = stateOf(book);
  const signal = init?.signal;
  signal?.throwIfAborted();
  const want = [...new Set(ids)];
  const given = init?.fallback ?? {};
  const currentKey = new Map<string, string>();
  if (!st.noCurrentEndpoint) {
    for (let i = 0; i < want.length; i += CURRENT_BATCH) {
      const batch = want.slice(i, i + CURRENT_BATCH);
      try {
        const r = await st.client.current(batch.map((id) => `question:${id}`), { type: QUESTION_MANIFEST_TYPE, ...(signal ? { signal } : {}) });
        for (const id of batch) { const rec = r.items[`question:${id}`]; if (rec) currentKey.set(id, rec.key); }
      } catch (e) {
        if (signal?.aborted) throw e;
        // an older server: remember it. A refusal (401/403: the token) is an error to show, not a reason to read stale questions.
        // Any other failure (offline, 5xx): this call falls back, the next one asks again
        if (e instanceof RegistryError && (e.status === 404 || e.status === 405)) { st.noCurrentEndpoint = true; break; }
        if (e instanceof RegistryError && (e.status === 401 || e.status === 403)) throw e;
      }
    }
  }
  const resolved = new Map<string, ResolvedQuestion>(), failed = new Map<string, Error>();
  const one = async (id: string) => {
    const linkKey = given[id] ?? st.fallback.get(id.toLowerCase());
    let first: unknown;
    const cur = currentKey.get(id);
    if (cur) {
      try { resolved.set(id, { id, key: cur, manifest: await manifestByKey(book, cur, signal ? { signal } : undefined), source: 'current' }); return; }
      catch (e) { if (signal?.aborted) throw e; first = e; }
    }
    if (linkKey) {
      try { resolved.set(id, { id, key: linkKey, manifest: await manifestByKey(book, linkKey, signal ? { signal } : undefined), source: 'link', ...(first instanceof Error ? { currentError: first } : {}) }); return; }
      catch (e) { if (signal?.aborted) throw e; first ??= e; }
    }
    failed.set(id, first instanceof Error ? first : new Error(`no question with id ${id}: the library has no current version and no link names a key`));
  };
  for (let i = 0; i < want.length; i += FETCH_AT_ONCE) await Promise.all(want.slice(i, i + FETCH_AT_ONCE).map(one));
  return { resolved, failed };
}

/**
 * A question manifest (spec 1.7) of the library, fetched as `application/vnd.chalk.question+json`, checked against its key and against
 * `questionManifestSchema`. `keyOrId`: a question's lasting id (a UUID), or the `question` key of a link. A key that a link with a `questionId` names
 * (once `loadBookLinks` has read them) gives the question's **current** version through `resolveQuestions`, falling back to that key as
 * the spec says; any other key is fetched as it is. Its pictures are then fetched with `book.fetchItem` like any other id (their type is
 * `image/*`: the manifest lists their keys only). A kind this version does not know is not refused (1.7); `checkQuestion` says what else
 * may be wrong with it.
 */
export async function loadQuestion(book: OpenedLibraryBook, keyOrId: string, init?: { signal?: AbortSignal }): Promise<QuestionManifest> {
  const isId = UUID.test(keyOrId), id = isId ? keyOrId : stateOf(book).idOfKey.get(keyOrId);
  if (!id) return manifestByKey(book, keyOrId, init);
  // the key the caller named is the fallback (a question may be linked in several versions)
  const { resolved, failed } = await resolveQuestions(book, [id], { ...init, ...(isId ? {} : { fallback: { [id]: keyOrId } }) });
  const got = resolved.get(id);
  if (got) return got.manifest;
  throw failed.get(id) ?? new Error(`no question with id ${id}`);
}
