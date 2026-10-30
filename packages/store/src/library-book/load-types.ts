import type { StoreDescriptor, StreamAsset } from '@chalk-format/model';

/**
 * The few shapes the loader needs from "Books in a library" (spec 1.8): the book item, the links item and their media types. They mirror the
 * shared contract exactly and are kept minimal on purpose: the full schemas and tag helpers live beside this file (`schema.ts`, `tags.ts`)
 * and can replace these once both are in.
 */

export const LIBRARY_BOOK_TYPE = 'application/vnd.chalk.book+json';
export const LIBRARY_PAGE_TYPE = 'application/vnd.chalk.page+json';
export const LIBRARY_TEXT_TYPE = 'application/vnd.chalk.text+json';
export const LIBRARY_LINKS_TYPE = 'application/vnd.chalk.links+json';

/** A page entry of a book item: a spec 1.4 page entry whose bytes are the library item `key` (a `file` may still be there; it is not used). */
export type BookItemPage = {
  id: string;
  key: string;
  file?: string;
  title?: string;
  label?: string;
  width?: number;
  height?: number;
  bytes?: number;
  assetBytes?: number;
  thumb?: string;
  assets?: string[];
  [field: string]: unknown;
};

/**
 * A book item (`application/vnd.chalk.book+json`): a spec 1.4 `book.json` where every page names its page item, the text layer is an item,
 * every asset is external (`assetSources` names the library's store), and `links` may name the links item.
 */
export type BookItem = {
  format: 'chalk.streamed';
  streamVersion: number;
  formatVersion: number;
  id: string;
  title: string;
  locale: string;
  createdAt: string;
  updatedAt: string;
  coverAssetId?: string;
  pages: BookItemPage[];
  snipPages?: BookItemPage[];
  assets: StreamAsset[];
  text?: { key: string; bytes?: number };
  assetSources?: StoreDescriptor[];
  links?: string;
  [field: string]: unknown;
};

/** One sentence of the book that has questions: where it is on its page (rects are page-relative, 0..1). */
export type BookLinksSentence = {
  id: string;
  page: number;
  pageId: string;
  rects: [number, number, number, number][];
  text: string;
};

/** One link: a sentence and the question manifest (its library key) that answers from it. */
export type BookLink = { sentence: string; question: string; role: string };

/** The links item (`application/vnd.chalk.links+json`): only sentences with at least one link, only questions with a library key. */
export type BookLinks = {
  format: 'chalk-links';
  version: 1;
  book: string;
  bookRevision: number;
  sentences: BookLinksSentence[];
  links: BookLink[];
};
