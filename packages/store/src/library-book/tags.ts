import { LIBRARY_BOOK_TYPE } from './schema.js';

/**
 * The tags a library lists the items of a book under (spec 1.8 §4), and the rule that says which book item is current. Items are
 * immutable; a new revision adds new items tagged `state:current` and re-tags the old book item `state:superseded`.
 */

export const LIBRARY_BOOK_KINDS = ['book', 'page', 'text', 'links'] as const;
export type LibraryBookKind = (typeof LIBRARY_BOOK_KINDS)[number];
export const LIBRARY_BOOK_STATES = ['current', 'superseded'] as const;
export type LibraryBookState = (typeof LIBRARY_BOOK_STATES)[number];

/** What a book's slug may be: it is part of a tag and of a URL path (`v1/books/<slug>/assets`). */
export const BOOK_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ORIGIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type BookTagsInput = { slug: string; revision: number; kind: LibraryBookKind; state: LibraryBookState; origin?: string };

/** `origin:<origin>`, `book:<slug>`, `book-revision:<n>`, `kind:<kind>`, `state:<state>`. The origin defaults to `chalkbook`. */
export function bookTags({ slug, revision, kind, state, origin = 'chalkbook' }: BookTagsInput): string[] {
  if (!BOOK_SLUG_PATTERN.test(slug)) throw new Error(`not a book slug: ${JSON.stringify(slug)}`);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error(`not a book revision: ${revision}`);
  if (!(LIBRARY_BOOK_KINDS as readonly string[]).includes(kind)) throw new Error(`not a kind of book item: ${kind}`);
  if (!(LIBRARY_BOOK_STATES as readonly string[]).includes(state)) throw new Error(`not a state: ${state}`);
  if (!ORIGIN_PATTERN.test(origin)) throw new Error(`not an origin: ${JSON.stringify(origin)}`);
  return [`origin:${origin}`, `book:${slug}`, `book-revision:${revision}`, `kind:${kind}`, `state:${state}`];
}

/** The same tags with the state changed (to supersede an item: register its key again with these tags). Other tags are kept. */
export function withBookState(tags: readonly string[], state: LibraryBookState): string[] {
  return [...tags.filter((t) => !t.startsWith('state:')), `state:${state}`];
}

/** The search that finds a book's current book item: `GET v1/search?tag=book:<slug>&tag=kind:book&tag=state:current`. */
export function currentBookQuery(slug: string): { tag: string[] } {
  if (!BOOK_SLUG_PATTERN.test(slug)) throw new Error(`not a book slug: ${JSON.stringify(slug)}`);
  return { tag: [`book:${slug}`, 'kind:book', 'state:current'] };
}

/** What `bookTags` wrote, read back; `undefined` for a field the tags do not have. */
export function readBookTags(tags: readonly string[]): { origin?: string; slug?: string; revision?: number; kind?: string; state?: string } {
  const v = (prefix: string) => tags.find((t) => t.startsWith(prefix))?.slice(prefix.length);
  const [origin, slug, rev, kind, state] = [v('origin:'), v('book:'), v('book-revision:'), v('kind:'), v('state:')];
  return {
    ...(origin !== undefined ? { origin } : {}),
    ...(slug !== undefined ? { slug } : {}),
    ...(rev !== undefined && /^\d+$/.test(rev) ? { revision: Number(rev) } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(state !== undefined ? { state } : {}),
  };
}

type Candidate = { key: string; type: string; tags?: readonly string[] | undefined; createdAt: string; status?: string | undefined };

/**
 * The current book item among search results (spec 1.8 §5): of the available items with the book's media type and `state:current`
 * (and, when `slug` is given, `book:<slug>` and `kind:book`), the one created last. Two with the same time: the larger key, so that
 * every reader picks the same one. `undefined`: the library has no current book item.
 */
export function pickCurrentBook<T extends Candidate>(items: readonly T[], slug?: string): T | undefined {
  const want = ['state:current', ...(slug === undefined ? [] : [`book:${slug}`, 'kind:book'])];
  const ok = items.filter((i) => i.type === LIBRARY_BOOK_TYPE && (i.status ?? 'available') === 'available' && want.every((t) => i.tags?.includes(t)));
  const time = (i: T) => { const t = Date.parse(i.createdAt); return Number.isNaN(t) ? -Infinity : t; };
  return ok.reduce<T | undefined>((best, i) => (!best || time(i) > time(best) || (time(i) === time(best) && i.key > best.key) ? i : best), undefined);
}
