import { describe, expect, it } from 'vitest';
import type { Lesson } from '@chalk-format/model';
import { searchBook } from './search.js';

const lesson = (pages: Lesson['pages']): Lesson => ({ id: 'l', title: 'T', locale: 'bn', pages, snipPages: [], createdAt: '', updatedAt: '' });
const page = (id: string, extra: Partial<Lesson['pages'][number]>) => ({ id, title: id, background: { type: 'blank' as const }, objects: [], ...extra });

describe('searchBook', () => {
  const book = lesson([
    page('p1', { textLayer: [{ text: 'সরল দোলকের দোলনকাল', x: 100, y: 50, width: 190, fontSize: 20 }, { text: 'Simple   pendulum', x: 100, y: 80, width: 170, fontSize: 20 }] }),
    page('p2', { objects: [{ id: 't', type: 'text', x: 10, y: 10, text: 'The PENDULUM swings\nআবার দোলক', fontSize: 20, fill: '#000' }] }),
  ]);

  it('finds Bengali in the text layer, with a box inside the line', () => {
    const hits = searchBook(book, 'দোলক');
    expect(hits.map((h) => h.page)).toEqual([0, 1]);   // দোলকের on page 1 (দোলনকাল is দোলন + কাল), দোলক on page 2
    const h = hits[0]!;
    expect(h.line.slice(h.start, h.end)).toBe('দোলকে');   // widened to the whole cluster কে
    expect(h.x).toBeGreaterThan(100); expect(h.x + h.width).toBeLessThan(290);
  });

  it('never cuts a letter from its vowel sign', () => {
    const b = lesson([page('p', { textLayer: [{ text: 'দোলকের দৈর্ঘ্য', x: 0, y: 0, width: 140, fontSize: 18 }] })]);
    const h = searchBook(b, 'দোলক')[0]!;
    expect(h.line.slice(h.start, h.end)).toBe('দোলকে');
  });

  it('ignores case and runs of whitespace', () => {
    expect(searchBook(book, 'simple pendulum')).toHaveLength(1);
    expect(searchBook(book, 'pendulum').map((h) => h.page)).toEqual([0, 1]);
  });

  it('matches Bengali written in a different Unicode form', () => {
    // য় as য + nukta (decomposed) in the book, precomposed in the query
    const b = lesson([page('p', { textLayer: [{ text: 'বিদ্যালয়', x: 0, y: 0, width: 90, fontSize: 18 }] })]);
    expect(searchBook(b, 'বিদ্যালয়')).toHaveLength(1);
  });

  it('searches text objects line by line, and returns nothing for an empty query', () => {
    const h = searchBook(book, 'আবার')[0]!;
    expect(h.page).toBe(1); expect(h.y).toBeCloseTo(34);
    expect(searchBook(book, '   ')).toEqual([]);
  });
});
