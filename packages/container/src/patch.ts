import type { Lesson, LessonPage, StreamIndex } from '@chalk-format/model';

/**
 * The patch save: what an editor sends a host instead of the whole book, and what the host answers. A conversation between an editor and its
 * host, not part of the book format (docs/design: concurrent section editing). The unit that is SENT is a changed page; the unit that is MERGED
 * is an object inside a page, so two people's edits to different objects of one page both land.
 */

/** A page as the editor opened it: the page JSON and the `hex8` of its file name in the index it opened. */
export type PageBase = { hash: string; page: LessonPage };

export type BookPatch = {
  /** What the editor started from (it already has all of it: nothing is kept on the server). */
  base: {
    /** `sha256:` + SHA-256 of the exact `book.json` bytes the editor opened. Only a fast path: a different one costs a merge, never a failure. */
    version: string;
    /** Page ids as opened (the reading pages, then the snip pages). */
    order: string[];
    snipOrder?: string[];
    title: string;
    coverAssetId?: string | null;
    /** Every page the editor changed or deleted, as it was. */
    pages: Record<string, PageBase>;
  };
  /** What the editor wants now. */
  mine: {
    order: string[];
    snipOrder?: string[];
    /** Only when changed. */
    title?: string;
    /** Only when changed (`null`: no cover). */
    coverAssetId?: string | null;
    /** Every page changed or added (reading and snip pages), as it is now. */
    pages: Record<string, LessonPage>;
    deleted: string[];
  };
  /** Media added in this session (the bytes travel beside the patch, keyed by id). */
  media: { id: string; type: string }[];
  /**
   * Assets the changed pages use that the editor believes the host carries (it saw them in the index). Another save may have taken one out of the
   * index since (its last reference was deleted); the host then restores it from its store, or says so in `PatchResult.unresolved` so the editor can send the bytes.
   */
  expects?: string[];
};

export type MergeRule =
  | 'same-property-last-saver'       // both changed one property, to different values: the last saver's value is kept, the other is in `loser`
  | 'deleted-vs-edited-kept'         // one side deleted an object or page the other edited: the edit is kept
  | 'order-both-moved'               // both moved the same page or object: the last saver's position is kept
  | 'background-replaced-text-cleared' // a page's picture was replaced: its text layer (positions on the old picture) was cleared
  | 'last-page-kept';                 // the merge would have left the book without a page: the first deleted page was kept

export type MergeNote = {
  /** The page this is about. */
  page: string;
  object?: string;
  /** A property path, e.g. `presentation.open`. */
  property?: string;
  rule: MergeRule;
  /** Whose value or position was kept: `mine` is the saver whose patch this is, `theirs` what the host already had. */
  by: 'mine' | 'theirs';
  /** The value that was not kept. */
  loser?: unknown;
  detail?: string;
};
export type MergeReport = { notes: MergeNote[] };

export type PatchResult = {
  /** `sha256:` of the new `book.json`: the editor's next base. */
  version: string;
  /**
   * Every page the host wrote: its new file name and `hex8`. `page` is present only when what was stored differs from what the editor sent
   * (it was merged with someone else's work): the editor takes it in, or its next patch would undo that work.
   */
  pages: Record<string, { file: string; hash: string; page?: LessonPage }>;
  report: MergeReport;
  /** The patch changed nothing the host had not already got. */
  unchanged?: boolean;
  /** Assets the host took out of the index because no page uses them any more: the editor must send their bytes again if it uses them again. */
  dropped?: string[];
  /**
   * The carried assets (with their file) that the merged pages in `pages` use: someone else's new media the editor has never heard of. It adds them
   * to the book it draws from, or those pictures could not be shown until it reopened the book.
   */
  assets?: { id: string; type: string; size?: number; path: string }[];
  /** Assets the patch expected the host to carry that it could not restore: they are listed without a file now. The editor sends their bytes again. */
  unresolved?: string[];
};

/** The current state of the book in the store ("theirs"): its index, and the pages `pagesNeeded` asked for. */
export type TheirsState = { index: StreamIndex; pages: ReadonlyMap<string, LessonPage> };

/** The `hex8` in a page file name (`pages/12-1a2b3c4d.json`), or null. */
export const fileHash = (file: string): string | null => /-([0-9a-f]{8})\.json$/.exec(file)?.[1] ?? null;

/**
 * The page ids a host must read from its store to merge `patch`: every page the patch changes or deletes that the store has. They are read,
 * not skipped on the strength of `hash`: the merge decides whether the store changed a page since the editor opened it by comparing the page
 * itself with the editor's base copy, because a patch is untrusted input and a claimed hash proves nothing. (A patch touches a few pages.)
 */
export function pagesNeeded(patch: BookPatch, index: StreamIndex): string[] {
  const have = new Set([...index.pages, ...(index.snipPages ?? [])].map((e) => e.id));
  return [...new Set([...Object.keys(patch.mine.pages), ...patch.mine.deleted])].filter((id) => have.has(id));
}

/** `obj[key] = value` as an OWN property, also for the keys `__proto__` and `constructor` (a plain assignment of `__proto__` sets the prototype and the value is lost). */
export function setOwn<T extends object>(obj: T, key: string, value: unknown): void {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

/** JSON with sorted keys: two values are equal when this is. */
const canon = (v: unknown): string | undefined =>
  JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));
/** Structural equality of two JSON values, independent of key order. */
export const sameValue = (a: unknown, b: unknown): boolean => canon(a) === canon(b);

/** The `hex8` of every page of an index, by page id (what `createPatch` needs as the editor's base). */
export function pageHashes(index: StreamIndex): Map<string, string> {
  return new Map([...index.pages, ...(index.snipPages ?? [])].flatMap((e) => { const h = fileHash(e.file); return h ? [[e.id, h] as [string, string]] : []; }));
}

/**
 * The editor's side: the patch that turns the book it opened (`base`: its lesson, the `hex8` of every page, the version id) into the book it has
 * now (`mine`). Pages that did not change are not in it; neither are their bytes. `media` lists what was added in the session.
 */
export function createPatch(base: { version: string; lesson: Lesson; hashes: ReadonlyMap<string, string> }, mine: Lesson, media: { id: string; type: string }[] = []): BookPatch {
  const all = (l: Lesson) => [...l.pages, ...l.snipPages];
  const was = new Map(all(base.lesson).map((p) => [p.id, p]));
  const now = new Map(all(mine).map((p) => [p.id, p]));
  const basePages: BookPatch['base']['pages'] = {};
  const minePages: Record<string, LessonPage> = {};
  for (const [id, page] of now) {
    const b = was.get(id);
    if (!b) { setOwn(minePages, id, page); continue; }
    if (page === b || sameValue(page, b)) continue;
    setOwn(minePages, id, page);
    setOwn(basePages, id, { hash: base.hashes.get(id) ?? '', page: b });
  }
  const deleted = [...was.keys()].filter((id) => !now.has(id));
  for (const id of deleted) setOwn(basePages, id, { hash: base.hashes.get(id) ?? '', page: was.get(id)! });
  const baseCover = base.lesson.coverAssetId ?? null, mineCover = mine.coverAssetId ?? null;
  return {
    base: {
      version: base.version, order: base.lesson.pages.map((p) => p.id),
      ...(base.lesson.snipPages.length ? { snipOrder: base.lesson.snipPages.map((p) => p.id) } : {}),
      title: base.lesson.title, ...(baseCover ? { coverAssetId: baseCover } : {}), pages: basePages,
    },
    mine: {
      order: mine.pages.map((p) => p.id), ...(mine.snipPages.length || base.lesson.snipPages.length ? { snipOrder: mine.snipPages.map((p) => p.id) } : {}),
      ...(mine.title !== base.lesson.title ? { title: mine.title } : {}),
      ...(mineCover !== baseCover ? { coverAssetId: mineCover } : {}),
      pages: minePages, deleted,
    },
    media,
  };
}
