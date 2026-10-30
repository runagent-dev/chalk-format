import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lessonPageSchema, streamTextSchema } from '@chalk-format/model';
import { LIBRARY_BOOK_MEDIA_TYPES, checkLibraryBook, checkLinks, libraryBookSchema, libraryLinksSchema, type LibraryBook, type LibraryLinks } from './schema.js';

// the two examples of spec 1.8 (§3.1, §3.4): the spec text and the schemas must agree
const spec = readFileSync(new URL('../../../../spec/1.8/README.md', import.meta.url), 'utf8');
const [bookJson, linksJson] = [...spec.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1]!) as unknown);
const book = () => structuredClone(bookJson) as LibraryBook;
const links = () => structuredClone(linksJson) as LibraryLinks;
const K = (c: string) => `c1:${c.repeat(25)}a`;

describe('the book item (spec 1.8 §3.1)', () => {
  it('the example in the spec is a valid book item with no problems', () => {
    const b = libraryBookSchema.parse(bookJson);
    expect(checkLibraryBook(b)).toEqual([]);
  });

  it('has keys where a streamed book has paths, and no paths', () => {
    const ok = (b: unknown) => libraryBookSchema.safeParse(b).success;
    const b = book();
    expect(ok({ ...b, pages: [{ ...b.pages[0], file: 'pages/12.json' }] })).toBe(false);
    expect(ok({ ...b, pages: [{ ...b.pages[0], key: undefined }] })).toBe(false);
    expect(ok({ ...b, pages: [{ ...b.pages[0], key: 'sha256:' + '0'.repeat(64) }] })).toBe(false);
    expect(ok({ ...b, assets: [{ ...b.assets[0], path: 'assets/x' }] })).toBe(false);
    expect(ok({ ...b, assets: [{ ...b.assets[0], id: 'img-1' }] })).toBe(false);
    expect(ok({ ...b, assets: [{ ...b.assets[0], renditions: [{ id: 'local-video', type: 'video/mp4' }] }] })).toBe(false);
    expect(ok({ ...b, assets: [{ ...b.assets[0], renditions: [{ id: K('r'), type: 'image/avif' }] }] })).toBe(true);
    expect(ok({ ...b, text: { file: 'text.json', key: b.text!.key } })).toBe(false);
    expect(ok({ ...b, text: { bytes: 3 } })).toBe(false);
    expect(ok({ ...b, links: 'links.json' })).toBe(false);
    expect(ok({ ...b, assetSources: [] })).toBe(false);
    expect(ok({ ...b, assetSources: undefined })).toBe(false);
    // what the book item does not need: text, links, snip pages
    expect(ok({ ...b, text: undefined, links: undefined })).toBe(true);
  });

  it('keeps fields it does not know (an open object, like the 1.4 index)', () => {
    const b = libraryBookSchema.parse({ ...book(), publisher: { name: 'x' }, pages: [{ ...book().pages[0], note: 1 }] });
    expect((b as Record<string, unknown>).publisher).toEqual({ name: 'x' });
    expect((b.pages[0] as Record<string, unknown>).note).toBe(1);
  });

  it('reports pages listed twice, assets a page names but the book does not list, and a store that needs a token', () => {
    const b = book();
    b.pages.push({ ...b.pages[1]!, key: K('b') });
    b.pages[0]!.assets = [...(b.pages[0]!.assets ?? []), K('c')];
    b.coverAssetId = K('d');
    b.assetSources.push({ id: 'private', kind: 'derived', template: 'https://x.example/{h}', auth: 'bearer' });
    expect(checkLibraryBook(libraryBookSchema.parse(b))).toEqual([
      'page p13: listed twice',
      `page p12: ${K('c')} is not in assets`,
      `coverAssetId ${K('d')} is not in assets`,
      'store private: a book names no store that needs a token',
    ]);
  });
});

describe('page and text items are the 1.4 files, unchanged (spec 1.8 §3.2, §3.3)', () => {
  it('a page item is checked as a page, a text item as the 1.4 text layer', () => {
    const page = { id: 'p12', title: 'সরল দোলক', objects: [], background: { type: 'color', color: '#ffffff' } };
    expect(lessonPageSchema.safeParse(page).success).toBe(true);
    expect(streamTextSchema.safeParse({ v: 1, pages: { p12: [{ text: 'সরল দোলক', x: 120, y: 88, width: 300, fontSize: 32 }] } }).success).toBe(true);
  });
  it('there are four media types, all different', () => {
    expect(new Set(LIBRARY_BOOK_MEDIA_TYPES).size).toBe(4);
    for (const t of LIBRARY_BOOK_MEDIA_TYPES) expect(t).toMatch(/^application\/vnd\.chalk\.[a-z]+\+json$/);
  });
});

describe('the links item (spec 1.8 §3.4)', () => {
  it('the example in the spec is valid, with no problems, against the pages of the example book', () => {
    const l = libraryLinksSchema.parse(linksJson);
    expect(checkLinks(l, book().pages.map((p) => p.id))).toEqual([]);
  });

  it('refuses another format, a key that is not c1, and a rectangle outside the page', () => {
    const ok = (x: unknown) => libraryLinksSchema.safeParse(x).success;
    const l = links();
    expect(ok({ ...l, format: 'chalk.links' })).toBe(false);
    expect(ok({ ...l, version: 2 })).toBe(false);
    expect(ok({ ...l, links: [{ ...l.links[0], question: 'q-17' }] })).toBe(false);
    expect(ok({ ...l, sentences: [{ ...l.sentences[0], rects: [[0, 0, 1.2, 0.1]] }] })).toBe(false);
    expect(ok({ ...l, sentences: [{ ...l.sentences[0], rects: [[0, 0, 0.5]] }] })).toBe(false);
    // a sentence whose place is not known, and a role this version does not know, are allowed
    expect(ok({ ...l, sentences: [{ ...l.sentences[0], rects: [] }], links: [{ ...l.links[0], role: 'explains' }] })).toBe(true);
  });

  it('reports sentences without a link or listed twice, links to unlisted sentences, repeated links, rects off the page, unknown pages', () => {
    const l = links();
    const s = l.sentences[0]!;
    l.sentences.push({ ...s }, { ...s, id: 's-lonely', pageId: 'p99', rects: [[0.5, 0.98, 0.4, 0.05]] });
    l.links.push({ ...l.links[0]! }, { sentence: 's-missing', question: K('e'), role: 'answers_from' });
    expect(checkLinks(l, ['p12', 'p13'])).toEqual([
      'sentence s-0412: listed twice',
      'sentence s-lonely: no link',
      'sentence s-lonely: page p99 is not in the book',
      'sentence s-lonely: rect 0 goes off the page',
      `link to ${K('e')}: sentence s-missing is not listed`,
      `link s-0412 ${l.links[0]!.question} answers_from: listed twice`,
    ]);
  });

  it('allows rounding at the edge of the page', () => {
    const l = links();
    l.sentences[0]!.rects = [[0.1, 0.2, 0.9, 0.8]];
    expect(checkLinks(l)).toEqual([]);
  });
});
