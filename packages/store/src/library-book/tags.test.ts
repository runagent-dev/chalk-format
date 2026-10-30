import { describe, expect, it } from 'vitest';
import { LIBRARY_BOOK_TYPE } from './schema.js';
import { bookTags, booksToSupersede, currentBookQuery, pickCurrentBook, readBookTags, withBookState } from './tags.js';

describe('the tags of a book in a library (spec 1.8 §4)', () => {
  it('names the origin, the book, the revision, the kind and the state', () => {
    expect(bookTags({ slug: 'physics-9-10-bn', revision: 7, kind: 'book', state: 'current' })).toEqual([
      'origin:chalkbook', 'book:physics-9-10-bn', 'book-revision:7', 'kind:book', 'state:current',
    ]);
    expect(bookTags({ slug: 'x', revision: 0, kind: 'links', state: 'superseded', origin: 'other-tool' })).toEqual([
      'origin:other-tool', 'book:x', 'book-revision:0', 'kind:links', 'state:superseded',
    ]);
  });

  it('refuses a slug that cannot be a tag and a path, a revision that is not a whole number, a kind or state it does not know', () => {
    const t = { slug: 'b', revision: 1, kind: 'page', state: 'current' } as const;
    for (const slug of ['', 'has space', 'a/b', '-lead', 'x'.repeat(129)]) expect(() => bookTags({ ...t, slug })).toThrow(/slug/);
    for (const revision of [-1, 1.5, Number.NaN]) expect(() => bookTags({ ...t, revision })).toThrow(/revision/);
    expect(() => bookTags({ ...t, kind: 'chapter' as never })).toThrow(/kind/);
    expect(() => bookTags({ ...t, state: 'draft' as never })).toThrow(/state/);
    expect(() => bookTags({ ...t, origin: 'a b' })).toThrow(/origin/);
  });

  it('changes the state and keeps the rest; reads the tags back', () => {
    const tags = [...bookTags({ slug: 'b', revision: 3, kind: 'page', state: 'current' }), 'chapter:2'];
    const old = withBookState(tags, 'superseded');
    expect(old).toEqual(['origin:chalkbook', 'book:b', 'book-revision:3', 'kind:page', 'chapter:2', 'state:superseded']);
    expect(readBookTags(old)).toEqual({ origin: 'chalkbook', slug: 'b', revision: 3, kind: 'page', state: 'superseded' });
    expect(readBookTags(['photo'])).toEqual({});
  });

  it('the search for the current book item', () => {
    expect(currentBookQuery('physics-9-10-bn')).toEqual({ tag: ['book:physics-9-10-bn', 'kind:book', 'state:current'] });
    expect(() => currentBookQuery('a b')).toThrow();
  });
});

describe('newest current wins (spec 1.8 §5)', () => {
  const item = (key: string, createdAt: string, state = 'current', extra: Partial<{ type: string; status: string; slug: string }> = {}) => ({
    key, createdAt, type: extra.type ?? LIBRARY_BOOK_TYPE, status: extra.status ?? 'available',
    tags: bookTags({ slug: extra.slug ?? 'b', revision: 1, kind: 'book', state: state as 'current' }),
  });

  it('takes the current book item created last', () => {
    const items = [item('c1:a', '2026-10-01T00:00:00Z'), item('c1:c', '2026-10-03T00:00:00Z'), item('c1:b', '2026-10-02T00:00:00Z')];
    expect(pickCurrentBook(items, 'b')?.key).toBe('c1:c');
  });

  it('leaves out superseded items, other media types, items not available, and other books', () => {
    const items = [
      item('c1:a', '2026-10-01T00:00:00Z'),
      item('c1:b', '2026-10-05T00:00:00Z', 'superseded'),
      item('c1:c', '2026-10-05T00:00:00Z', 'current', { type: 'image/webp' }),
      item('c1:d', '2026-10-05T00:00:00Z', 'current', { status: 'withdrawn' }),
      item('c1:e', '2026-10-05T00:00:00Z', 'current', { slug: 'other' }),
    ];
    expect(pickCurrentBook(items, 'b')?.key).toBe('c1:a');
    // without a slug, any current book item of the results
    expect(pickCurrentBook(items)?.key).toBe('c1:e');
  });

  it('two at the same time: the larger key, whatever the order of the results', () => {
    const a = item('c1:a', '2026-10-01T00:00:00Z'), b = item('c1:b', '2026-10-01T00:00:00.000Z');
    expect(pickCurrentBook([a, b])?.key).toBe('c1:b');
    expect(pickCurrentBook([b, a])?.key).toBe('c1:b');
  });

  it('none current: undefined', () => {
    expect(pickCurrentBook([item('c1:a', '2026-10-01T00:00:00Z', 'superseded')])).toBeUndefined();
    expect(pickCurrentBook([])).toBeUndefined();
  });

  it('supersedes only current book items older than the one added, so overlapping runs leave the newer one current', () => {
    const a = item('c1:a', '2026-10-01T00:00:00Z'), b = item('c1:b', '2026-10-02T00:00:00Z'), c = item('c1:c', '2026-10-03T00:00:00Z');
    const old = item('c1:o', '2026-09-01T00:00:00Z', 'superseded');
    expect(booksToSupersede([a, b, c, old], b, 'b').map((i) => i.key)).toEqual(['c1:a']);
    expect(booksToSupersede([a, b, c], c, 'b').map((i) => i.key)).toEqual(['c1:a', 'c1:b']);
    // run B supersedes what is older than b, run C what is older than c: c stays current
    const left = [a, b, c].filter((i) => ![...booksToSupersede([a, b, c], b), ...booksToSupersede([a, b, c], c)].includes(i));
    expect(left.map((i) => i.key)).toEqual(['c1:c']);
    // the same time: the item just added wins, whatever the keys
    const z = item('c1:z', '2026-10-01T00:00:00Z');
    expect(booksToSupersede([a, z], a, 'b').map((i) => i.key)).toEqual(['c1:z']);
  });
});
