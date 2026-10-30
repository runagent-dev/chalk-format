import { z } from 'zod';
import { C1_KEY_PATTERN, storeDescriptorSchema, streamAssetSchema, streamIndexSchema, streamPageSchema } from '@chalk-format/model';

/**
 * Books in a library (spec 1.8): a streamed book (spec 1.4) kept as items of a library (spec 1.2, the registry API), so
 * that an app loads the whole book through the library and nothing else. Four media types:
 *
 * - the **book item**: the 1.4 index, with library keys where 1.4 has paths (`libraryBookSchema`);
 * - a **page item**: exactly the bytes of a 1.4 page file (the page JSON of spec 1.0 §3.2);
 * - the **text item**: exactly the bytes of the 1.4 text layer (`streamTextSchema`);
 * - the **links item**: which sentences of the book a question is answered from (`libraryLinksSchema`).
 *
 * Every item is content-addressed and immutable. Which one is current is said by tags (`./tags.ts`).
 */

export const LIBRARY_BOOK_TYPE = 'application/vnd.chalk.book+json';
export const LIBRARY_PAGE_TYPE = 'application/vnd.chalk.page+json';
export const LIBRARY_TEXT_TYPE = 'application/vnd.chalk.text+json';
export const LIBRARY_LINKS_TYPE = 'application/vnd.chalk.links+json';
/** The four media types of a book in a library, for a library server's list of accepted types. */
export const LIBRARY_BOOK_MEDIA_TYPES = [LIBRARY_BOOK_TYPE, LIBRARY_PAGE_TYPE, LIBRARY_TEXT_TYPE, LIBRARY_LINKS_TYPE] as const;

const c1 = z.string().regex(C1_KEY_PATTERN);
/** A library has no paths: a field that names a file in a 1.4 book MUST be absent here. */
const noPath = z.never().optional();

/** A page entry: the 1.4 entry, with the key of its page item instead of a file. */
export const libraryBookPageSchema = streamPageSchema.omit({ file: true }).extend({ key: c1, file: noPath });

/** Every asset is external: found through the stores (spec 1.2 §6), never at a path in the book. */
export const libraryBookAssetSchema = streamAssetSchema.extend({ id: c1, path: noPath });

export const libraryBookSchema = streamIndexSchema.extend({
  pages: z.array(libraryBookPageSchema).min(1),
  snipPages: z.array(libraryBookPageSchema).optional(),
  assets: z.array(libraryBookAssetSchema),
  /** The text item, by key. */
  text: z.looseObject({ key: c1, bytes: z.number().int().nonnegative().optional(), file: noPath }).optional(),
  /** The library's delivery store (`GET v1/stores`), and any other store the publisher suggests (spec 1.2 §4.4). */
  assetSources: z.array(storeDescriptorSchema).min(1),
  /** The links item, by key. */
  links: c1.optional(),
});

/** A rectangle on a page, as fractions of the page's width and height (0 to 1): `[x, y, width, height]`. */
const fraction = z.number().min(0).max(1);
export const linksRectSchema = z.tuple([fraction, fraction, fraction, fraction]);

/** A sentence of the book that at least one question is linked to. */
export const linksSentenceSchema = z.looseObject({
  /** The sentence's lasting name on the authoring side. */
  id: z.string().min(1).max(200),
  /** The page's number on the authoring side, for people. */
  page: z.number().int().nonnegative(),
  /** The `id` of the page entry in the book item: where the sentence is. */
  pageId: z.string().min(1),
  /** Where it is on the page. Empty when that is not known: the link is shown without a highlight. */
  rects: z.array(linksRectSchema),
  text: z.string(),
});

/** The roles this version knows. A reader skips a link whose role it does not know. */
export const LINK_ROLES = ['answers_from'] as const;
export type LinkRole = (typeof LINK_ROLES)[number];

export const linksLinkSchema = z.looseObject({
  sentence: z.string().min(1).max(200),
  /** The key of the question's manifest (spec 1.7) in the library. */
  question: c1,
  role: z.string().min(1).max(40),
});

export const libraryLinksSchema = z.looseObject({
  format: z.literal('chalk-links'),
  version: z.literal(1),
  book: z.string().min(1),
  bookRevision: z.number().int().nonnegative(),
  sentences: z.array(linksSentenceSchema),
  links: z.array(linksLinkSchema),
});

export type LibraryBook = z.infer<typeof libraryBookSchema>;
export type LibraryBookPage = z.infer<typeof libraryBookPageSchema>;
export type LibraryBookAsset = z.infer<typeof libraryBookAssetSchema>;
export type LibraryLinks = z.infer<typeof libraryLinksSchema>;
export type LinksSentence = z.infer<typeof linksSentenceSchema>;
export type LinksLink = z.infer<typeof linksLinkSchema>;

const dup = (xs: string[]): string[] => [...new Set(xs.filter((x, i) => xs.indexOf(x) !== i))];

/**
 * Problems with a book item beyond its shape (empty: all good): page ids appear once, every asset a page names is listed, a
 * suggested store carries no credentials (spec 1.2 §4.4).
 */
export function checkLibraryBook(b: LibraryBook): string[] {
  const problems: string[] = [];
  const entries = [...b.pages, ...(b.snipPages ?? [])];
  for (const id of dup(entries.map((p) => p.id))) problems.push(`page ${id}: listed twice`);
  for (const id of dup(b.assets.map((a) => a.id))) problems.push(`asset ${id}: listed twice`);
  const listed = new Set(b.assets.map((a) => a.id));
  for (const p of entries) {
    for (const k of [...(p.assets ?? []), ...(p.thumb ? [p.thumb] : [])]) if (!listed.has(k)) problems.push(`page ${p.id}: ${k} is not in assets`);
  }
  if (b.coverAssetId && !listed.has(b.coverAssetId)) problems.push(`coverAssetId ${b.coverAssetId} is not in assets`);
  for (const s of b.assetSources) if (s.auth === 'bearer') problems.push(`store ${s.id}: a book names no store that needs a token`);
  return problems;
}

/**
 * Problems with a links item beyond its shape (empty: all good): a sentence appears once and has at least one link, a link names
 * a listed sentence and is not repeated, a rectangle stays on its page. `pageIds`, when given, are the page ids of the book item
 * the links belong to.
 */
export function checkLinks(l: LibraryLinks, pageIds?: Iterable<string>): string[] {
  const problems: string[] = [];
  const ids = l.sentences.map((s) => s.id), known = new Set(ids), linked = new Set(l.links.map((x) => x.sentence));
  const pages = pageIds ? new Set(pageIds) : null;
  for (const id of dup(ids)) problems.push(`sentence ${id}: listed twice`);
  for (const s of l.sentences) {
    if (!linked.has(s.id)) problems.push(`sentence ${s.id}: no link`);
    if (pages && !pages.has(s.pageId)) problems.push(`sentence ${s.id}: page ${s.pageId} is not in the book`);
    // a little room for rounding: 0.1 + 0.9 is not exactly 1 in floating point
    s.rects.forEach(([x, y, w, h], i) => { if (x + w > 1 + 1e-6 || y + h > 1 + 1e-6) problems.push(`sentence ${s.id}: rect ${i} goes off the page`); });
  }
  for (const x of l.links) if (!known.has(x.sentence)) problems.push(`link to ${x.question}: sentence ${x.sentence} is not listed`);
  for (const k of dup(l.links.map((x) => `${x.sentence} ${x.question} ${x.role}`))) problems.push(`link ${k}: listed twice`);
  return problems;
}
