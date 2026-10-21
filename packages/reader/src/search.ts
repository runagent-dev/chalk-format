import type { Lesson } from '@chalk-format/model';

/** One match: where it is (page units) and the line it is in, for the results list. */
export type Hit = {
  page: number;
  x: number; y: number; width: number; height: number;
  /** The line around the match, and where the match sits in it. */
  line: string; start: number; end: number;
};

/**
 * Comparable form: NFC (Bengali has several encodings of the same letters), case-folded, and whitespace runs
 * as one space. Each character keeps its offset in the original, so a match maps back to it.
 */
function fold(s: string): { text: string; map: number[] } {
  let text = '';
  const map: number[] = [];
  let space = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (/\s/.test(ch)) { if (!space && text) { text += ' '; map.push(i); } space = true; continue; }
    space = false;
    const f = ch.normalize('NFC').toLocaleLowerCase();
    for (const c of f) { text += c; map.push(i); }
  }
  return { text, map };
}

/**
 * Widen [start, end) to whole grapheme clusters, so a highlight never cuts a letter from its vowel sign
 * (দোলক in দোলকের must include ে, or the sign is drawn detached).
 */
const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
export function snapToGraphemes(text: string, start: number, end: number): [number, number] {
  if (!segmenter) return [start, end];
  let s = start, e = end;
  for (const g of segmenter.segment(text)) {
    const a = g.index, b = g.index + g.segment.length;
    if (a < start && b > start) s = a;
    if (a < end && b > end) e = b;
    if (a >= end) break;
  }
  return [s, e];
}

/**
 * Every match of `query` in the book's searchable text (spec 1.0 §3.2): each page's text layer (from the
 * source PDF) and its text objects. Boxes inside a line are found by character offset, which is exact for
 * monospaced text and close enough to highlight for the rest.
 */
export function searchBook(lesson: Lesson, query: string, limit = 500): Hit[] {
  const q = fold(query.normalize('NFC')).text.trim();
  if (q.length < 1) return [];
  const hits: Hit[] = [];
  lesson.pages.forEach((page, pi) => {
    if (hits.length >= limit) return;
    const lines: { text: string; x: number; y: number; width: number; height: number }[] = [];
    for (const r of page.textLayer ?? []) lines.push({ text: r.text, x: r.x, y: r.y, width: r.width, height: r.fontSize * 1.25 });
    for (const o of page.objects) {
      if (o.type !== 'text') continue;
      // one line per text line; width estimated from the font size (no layout engine here)
      o.text.split('\n').forEach((t, li) => lines.push({ text: t, x: o.x, y: o.y + li * o.fontSize * 1.2, width: t.length * o.fontSize * 0.55, height: o.fontSize * 1.2 }));
    }
    for (const l of lines) {
      const f = fold(l.text);
      let from = 0;
      for (;;) {
        const at = f.text.indexOf(q, from);
        if (at < 0) break;
        const [start, end] = snapToGraphemes(l.text, f.map[at]!, (f.map[at + q.length - 1] ?? f.map[at]!) + 1), n = Math.max(1, l.text.length);
        hits.push({ page: pi, x: l.x + (l.width * start) / n, y: l.y, width: Math.max(4, (l.width * (end - start)) / n), height: l.height, line: l.text, start, end });
        if (hits.length >= limit) return;
        from = at + q.length;
      }
    }
  });
  return hits.sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
}
