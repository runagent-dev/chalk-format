import { parseStreamIndex, parseStreamPage, parseStreamText } from '@chalk-format/container';
import { isImageType, resolutionKey, sniffMediaType, type Lesson, type LessonPage, type StreamIndex, type StreamPage, type StreamText } from '@chalk-format/model';
import { openLibraryBook, type OpenedLibraryBook, type TokenSource } from '@chalk-format/store';
import type { AssetResolver, Book } from './book.js';

/**
 * A streamed book (spec 1.4): the index first, then pages as the reader asks for them. Until its file arrives a
 * page is a placeholder of the right size showing its thumbnail, so the whole book can be laid out, numbered and
 * browsed at once. Images are drawn from their own URLs, so the browser and the CDN cache them.
 */
export type StreamedBook = Book & {
  readonly streamed: true;
  readonly index: StreamIndex;
  /**
   * `sha256:` + SHA-256 of the exact `book.json` bytes this book was opened from: the version a patch save starts from (the host compares it with
   * the book it has; a different one only means a merge, never a failure).
   */
  readonly version: string;
  /** Pages to load, most wanted first. Requests not started yet for other pages are dropped (spec 1.4 §5). */
  want(pages: number[]): void;
  isLoaded(pageId: string): boolean;
  /** Every page loaded (author mode, saving). */
  readonly complete: boolean;
  /** How many pages (and snip pages) have arrived, and how many the book has: for a progress display while `loadAll` runs. */
  readonly loadedPages: number;
  readonly totalPages: number;
  /**
   * Loads every page not loaded yet, keeping up to `concurrency` requests (default 12) in flight and starting the next as soon as one
   * finishes (a slow page holds up only itself). Rejects when some page could not be loaded; the others stay loaded.
   */
  loadAll(o?: { concurrency?: number }): Promise<void>;
  /** The search file (spec 1.4 §4), fetched once; null if the book has none. */
  searchText(): Promise<StreamText | null>;
  /** Tells the book where files the host has gained since it was opened are (a patch save's answer: media another editor added), so pages using them can be drawn. */
  addAssets(entries: readonly { id: string; type: string; path: string }[]): void;
  /** Called whenever pages arrive (`lesson` is then a new object). */
  subscribe(fn: () => void): () => void;
  /** Set for a book opened from a library (`openLibraryStreamedBook`): the book item, its key and revision, and where its items are. */
  readonly library?: OpenedLibraryBook;
};

export const isStreamed = (b: Book): b is StreamedBook => (b as Partial<StreamedBook>).streamed === true;
/** Does this source name a streamed book (an index, or a directory)? */
export const isStreamSource = (s: unknown): s is string | URL => (typeof s === 'string' || s instanceof URL) && /(\/|\/book\.json)(\?.*)?$/.test(String(s));

const MAX_REQUESTS = 6;
/** Requests in flight at once for `loadAll` (author mode needs every page); the reading window keeps MAX_REQUESTS. */
const LOAD_ALL_CONCURRENCY = 12;

export async function openStreamedBook(source: string | URL, o: { resolveAsset?: AssetResolver; fetch?: typeof fetch } = {}): Promise<StreamedBook> {
  const doFetch = o.fetch ?? globalThis.fetch.bind(globalThis);
  const indexUrl = new URL(String(source).endsWith('/') ? `${String(source)}book.json` : String(source), globalThis.location?.href);
  const res = await doFetch(indexUrl.href);
  if (!res.ok) throw new Error(`could not fetch the book (${res.status})`);
  // the index as BYTES: the version id is the hash of exactly what the host wrote, so it is hashed before it is parsed (and the same bytes are parsed)
  const indexBytes = new Uint8Array(await res.arrayBuffer());
  const at = (path: string) => new URL(path, indexUrl).href;
  return streamedBook({
    index: parseStreamIndex(JSON.parse(new TextDecoder().decode(indexBytes))),
    version: await sha256Id(indexBytes),
    async json(path, signal) {
      const r = await doFetch(at(path), { signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<unknown>;
    },
    at,
  }, { ...o, fetch: doFetch });
}

/**
 * Where a book in a library is (spec 1.8, "Books in a library"): the library server, the book's slug, and a token if the library needs one:
 * a fixed token, or a function giving the current one (a sign-in: `libraryAuth(...).token`), asked again once after a 401.
 */
export type LibrarySource = { library: string; slug: string; token?: TokenSource | undefined };
export const isLibrarySource = (s: unknown): s is LibrarySource =>
  typeof s === 'object' && s !== null && !(s instanceof URL) && typeof (s as LibrarySource).library === 'string' && typeof (s as LibrarySource).slug === 'string';

/**
 * A book in a library, opened as a streamed book: the current book item is found by its tags, and its pages, text layer and media are items
 * of the library, each fetched by its key (and checked against it) when the reader needs it. The links item is not fetched here:
 * `loadBookLinks(book.library)`, or the reader's `onBookLinks`.
 */
export async function openLibraryStreamedBook(source: LibrarySource, o: { resolveAsset?: AssetResolver; fetch?: typeof fetch } = {}): Promise<StreamedBook> {
  const lib = await openLibraryBook({ library: source.library, slug: source.slug, token: source.token, ...(o.fetch ? { fetch: o.fetch } : {}) });
  const dec = new TextDecoder();
  return streamedBook({
    index: parseStreamIndex(lib.index),
    // the hash of the book item's bytes (its key names the same bytes)
    version: await sha256Id(lib.bytes),
    json: async (path, signal) => JSON.parse(dec.decode(await lib.read(path, { signal }))) as unknown,
    at: (path) => new URL(path, lib.library.endsWith('/') ? lib.library : `${lib.library}/`).href,
    // drawn by URL, so the browser and the CDN cache it, as any streamed book's media (spec 1.2 §6: what a URL draws is not hashed). A store that
    // needs the token cannot be named by a bare URL (an <img> sends no header), and one that asks to be verified always must be: those
    // media are fetched, checked against their id, and drawn from a blob. So is a picture whose format is not known (`image/*`, a question's):
    // which of the library's image stores has it is found by asking each in turn, which a URL cannot do
    async assetUrl(id, signal) {
      const type = lib.typeOf(id);
      const store = resolutionKey(id) ? lib.storeFor(type) : null;
      if (!store) return null;
      const unknownFormat = type.endsWith('/*');
      if (store.auth !== 'bearer' && store.verify !== 'always' && !unknownFormat) return lib.urlOf(id, type);
      const bytes = await lib.fetchItem(id, { signal, type });
      // a picture whose format is not known gets the type its bytes show, among the formats a book's pictures take (spec 1.0: png, jpeg, webp,
      // gif, avif). Never image/svg+xml from a guess: an SVG in a blob: URL of this origin runs its scripts if the URL is opened
      const shown = unknownFormat ? sniffMediaType(bytes) : null;
      const sniffed = unknownFormat ? (shown && isImageType(shown) ? shown : null) : type;
      return new Blob([bytes as BlobPart], sniffed ? { type: sniffed } : {});
    },
    async assetBytes(id, signal) {
      // an id the library has no store for is not its to answer: the host's resolver may know it (as assetUrl does). One it has a store for is
      // fetched from it, else from the stores the book suggests, and checked
      if (!resolutionKey(id) || !lib.storeFor(lib.typeOf(id))) return undefined;
      return (await lib.fetchItem(id, { signal })).slice().buffer as ArrayBuffer;
    },
    // after the host's resolver (spec 1.8 §7 step 1): media the library has no store for, from the stores the book suggests, checked and drawn
    // from a blob. (Media the library's store names by a public URL are drawn from that URL, as above: a picture missing there is not looked
    // for elsewhere, since an <img> says only that it failed. The publisher puts every item of a book in the library first, spec 1.8 §6.1.)
    async fallbackUrl(id, signal) {
      const type = lib.typeOf(id);
      if (!resolutionKey(id) || lib.storeFor(type) || !lib.storesFor(type).length) return null;
      return new Blob([(await lib.fetchItem(id, { signal, type })) as BlobPart], { type });
    },
    library: lib,
  }, o);
}

const sha256Id = async (bytes: Uint8Array) => `sha256:${[...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;

/** Where a streamed book's files come from: a folder of files by URL, or the items of a library. */
type StreamFiles = {
  index: StreamIndex;
  version: string;
  /** A page or the text layer, parsed. */
  json(path: string, signal: AbortSignal): Promise<unknown>;
  /** The URL of a file of the book (its own media). */
  at(path: string): string;
  /** External media the source can name itself (a library's store), before the host's resolver: a URL, or the bytes as a Blob. */
  assetUrl?(id: string, signal: AbortSignal): Promise<string | Blob | null>;
  /** External media the source can find only after the host's resolver (a book's suggested stores): a URL, or the bytes as a Blob. */
  fallbackUrl?(id: string, signal: AbortSignal): Promise<string | Blob | null>;
  /** External media's bytes, fetched and checked by the source; undefined for an id it cannot name. */
  assetBytes?(id: string, signal: AbortSignal): Promise<ArrayBuffer | undefined>;
  library?: OpenedLibraryBook;
};

function streamedBook(src: StreamFiles, o: { resolveAsset?: AssetResolver; fetch?: typeof fetch }): StreamedBook {
  const doFetch = o.fetch ?? globalThis.fetch.bind(globalThis);
  const { index, version, at } = src;
  const assetPath = new Map(index.assets.filter((a) => a.path).map((a) => [a.id, a.path!]));
  // an asset's renditions carry their own type (spec 1.2): a webp rendition of a png is image/webp
  const assetType = new Map<string, string>(index.assets.flatMap((a) => [[a.id, a.type] as const, ...(a.renditions ?? []).map((x) => [x.id, x.type] as const)]));

  const placeholder = (p: StreamPage): LessonPage => ({
    id: p.id, title: p.title ?? '', ...(p.width ? { width: p.width } : {}), ...(p.height ? { height: p.height } : {}),
    background: p.thumb ? { type: 'image', assetId: p.thumb } : { type: 'blank' }, objects: [],
  });
  const pages: LessonPage[] = index.pages.map(placeholder);
  const snipPages: LessonPage[] = (index.snipPages ?? []).map(placeholder);
  const loaded = new Set<string>();
  let lesson: Lesson = {
    id: index.id, title: index.title, locale: index.locale, createdAt: index.createdAt, updatedAt: index.updatedAt,
    ...(index.coverAssetId ? { coverAssetId: index.coverAssetId } : {}), pages: [...pages], snipPages: [...snipPages],
  };
  const listeners = new Set<() => void>();
  const changed = () => { lesson = { ...lesson, pages: [...pages], snipPages: [...snipPages] }; listeners.forEach((f) => f()); };

  // the queue: page indices (snips as -1 - i), most wanted first; at most MAX_REQUESTS in flight
  let queue: number[] = [];
  const inflight = new Map<number, Promise<void>>();
  const abort = new AbortController();
  const entryOf = (k: number) => (k >= 0 ? index.pages[k] : index.snipPages?.[-1 - k]);
  const loadPage = (k: number): Promise<void> => {
    const running = inflight.get(k); if (running) return running;
    const e = entryOf(k); if (!e) return Promise.resolve();
    const job = (async () => {
      try {
        const page = parseStreamPage(index, await src.json(e.file, abort.signal), k < 0);
        if (k >= 0) pages[k] = page; else snipPages[-1 - k] = page;
        loaded.add(e.id); changed();
      } catch {
        // stays a placeholder; it is asked for again the next time it is wanted (spec 1.4 §5.6)
      } finally { inflight.delete(k); pump(); }
    })();
    inflight.set(k, job);
    return job;
  };
  const pump = () => {
    while (inflight.size < MAX_REQUESTS && queue.length) {
      const k = queue.shift()!;
      if (!loaded.has(entryOf(k)?.id ?? '')) void loadPage(k);
    }
  };

  // assets: the book's own files by URL (cacheable), external ones through the host
  const urls = new Map<string, Promise<string | null>>(), settled = new Map<string, string | null>(), owned: string[] = [];
  const resolveUrl = async (id: string): Promise<string | null> => {
    const p = assetPath.get(id);
    if (p) return at(p);
    const own = await src.assetUrl?.(id, abort.signal);
    const r = own ?? (o.resolveAsset ? await o.resolveAsset(id) : null) ?? (await src.fallbackUrl?.(id, abort.signal)) ?? null;
    if (r == null) return null;
    if (typeof r === 'string') return r;
    // disposed while the bytes were on their way: no URL that nothing would revoke
    if (abort.signal.aborted) return null;
    const u = URL.createObjectURL(r); owned.push(u); return u;
  };
  let text: Promise<StreamText | null> | null = null;

  const book: StreamedBook = {
    streamed: true, index, version, ...(src.library ? { library: src.library } : {}),
    get lesson() { return lesson; },
    missingAssetIds: [],
    assetUrl(id) {
      let u = urls.get(id);
      if (!u) { u = resolveUrl(id).catch(() => null).then((v) => { settled.set(id, v); return v; }); urls.set(id, u); }
      return u;
    },
    peekUrl(id) { const p = assetPath.get(id); return p ? at(p) : settled.get(id); },
    async assetBytes(id) {
      if (src.assetBytes && !assetPath.has(id)) {
        // the source's answer is final for an id it can name: bytes that failed their key check are not fetched again unchecked
        const bytes = await src.assetBytes(id, abort.signal).catch(() => null);
        if (bytes !== undefined) return bytes && { type: assetType.get(id) ?? 'application/octet-stream', bytes };
      }
      const url = await book.assetUrl(id);
      if (!url) return null;
      // a blob: URL holds bytes already here (checked ones from a store, or the host's): the host's fetch may not know the scheme
      const r = await (url.startsWith('blob:') ? globalThis.fetch(url, { signal: abort.signal }) : doFetch(url, { signal: abort.signal }));
      if (!r.ok) return null;
      return { type: assetType.get(id) ?? r.headers.get('content-type') ?? 'application/octet-stream', bytes: await r.arrayBuffer() };
    },
    want(list) {
      const keys = list.filter((i) => i >= 0 && i < index.pages.length && !loaded.has(index.pages[i]!.id));
      queue = keys.filter((k) => !inflight.has(k));
      pump();
    },
    isLoaded: (id) => loaded.has(id),
    get complete() { return loaded.size === index.pages.length + (index.snipPages?.length ?? 0); },
    get loadedPages() { return loaded.size; },
    get totalPages() { return index.pages.length + (index.snipPages?.length ?? 0); },
    async loadAll(o = {}) {
      const todo = [...index.pages.keys(), ...(index.snipPages ?? []).map((_, i) => -1 - i)].filter((k) => !loaded.has(entryOf(k)!.id));
      const limit = Math.max(1, Math.floor(o.concurrency ?? LOAD_ALL_CONCURRENCY));
      // a pool, in reading order: each worker takes the next page the moment its last one is done (no waiting for the slowest of a batch)
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(limit, todo.length) }, async () => { while (next < todo.length) await loadPage(todo[next++]!); }));
      if (!book.complete) throw new Error('some pages of this book could not be loaded');
    },
    searchText() {
      if (!index.text) return Promise.resolve(null);
      text ??= src.json(index.text.file, abort.signal).then(parseStreamText).catch(() => { text = null; return null; });
      return text;
    },
    addAssets(entries) {
      // no `changed()`: that would hand an editor a fresh copy of the book as opened (and could replace its edits); the pages that use these files ask for them as they draw
      for (const e of entries) { assetPath.set(e.id, e.path); assetType.set(e.id, e.type); urls.delete(e.id); settled.delete(e.id); }
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    dispose() { abort.abort(); owned.forEach((u) => URL.revokeObjectURL(u)); listeners.clear(); urls.clear(); queue = []; },
  };
  // snip pages are small and opened from markers anywhere: they come right after the first pages
  if (index.snipPages?.length) setTimeout(() => index.snipPages!.forEach((_, i) => { if (inflight.size < MAX_REQUESTS) void loadPage(-1 - i); }), 0);
  return book;
}

/** Page indices to load around `current`, nearest first: current, next, previous, next but one, … (spec 1.4 §5). */
export function windowAround(current: number, count: number, radius: number): number[] {
  const out = [current];
  for (let d = 1; d <= radius; d++) { out.push(current + d, current - d); }
  return out.filter((i) => i >= 0 && i < count);
}
