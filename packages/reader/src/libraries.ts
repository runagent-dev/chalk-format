import { libraryResolver, type Library } from '@chalk-format/store';
import type { Book } from './book.js';

/**
 * A book that finds what it does not carry in the connected libraries, in their order (the first that has an item
 * wins). What none has is "not found": recorded, so the reader can say what is missing; connecting or reordering
 * libraries asks again. Wraps any book (a .chalk, a streamed one, the author's working copy) without copying it.
 */
export type LibraryLookup = {
  /** Answers so far, by key: a URL, or null for not found. Cleared when the libraries change. */
  urls: Map<string, Promise<string | null>>;
  settled: Map<string, string | null>;
  /** Keys no library had. */
  missing: Set<string>;
  blobUrls: string[];
  listeners: Set<() => void>;
};

export const newLookup = (): LibraryLookup => ({ urls: new Map(), settled: new Map(), missing: new Set(), blobUrls: [], listeners: new Set() });
export function resetLookup(l: LibraryLookup) {
  l.urls.clear(); l.settled.clear(); l.missing.clear();
  l.blobUrls.forEach((u) => URL.revokeObjectURL(u)); l.blobUrls.length = 0;
  l.listeners.forEach((f) => f());
}

export function withLibraries(book: Book, libraries: readonly Library[], lookup: LibraryLookup): Book {
  if (!libraries.length) return book;
  const resolve = libraryResolver(() => libraries);
  const fromLibraries = (id: string): Promise<string | null> => {
    let p = lookup.urls.get(id);
    if (!p) {
      p = resolve(id).then((r) => {
        if (r == null) return null;
        if (typeof r === 'string') return r;
        const u = URL.createObjectURL(r); lookup.blobUrls.push(u); return u;
      }).catch(() => null).then((u) => {
        lookup.settled.set(id, u);
        if (u == null && !lookup.missing.has(id)) { lookup.missing.add(id); lookup.listeners.forEach((f) => f()); }
        return u;
      });
      lookup.urls.set(id, p);
    }
    return p;
  };
  // the book's own first (carried bytes, its resolver); libraries for the rest. Object.create keeps the book's
  // getters (a streamed book's lesson changes as pages arrive) and everything it has that is not overridden here.
  const wrapped: Book = Object.create(book, {
    assetUrl: { value: async (id: string) => (await book.assetUrl(id)) ?? fromLibraries(id) },
    // what is known already: the book's URL, else a library's answer (a URL, or null for not found), else nothing yet
    peekUrl: { value: (id: string) => book.peekUrl(id) || (lookup.settled.has(id) ? lookup.settled.get(id) : undefined) },
    assetBytes: {
      value: async (id: string) => {
        const own = await book.assetBytes(id).catch(() => null);
        if (own) return own;
        for (const lib of libraries) {
          const b = await lib.get(id).catch(() => null);
          if (b) return { type: b.type, bytes: b.bytes.slice().buffer as ArrayBuffer };
        }
        return null;
      },
    },
  });
  return wrapped;
}
