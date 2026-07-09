import { describe, expect, it } from 'vitest';
import { hitInk, hitObject, hitRect, hitTest, hitText } from './hit-test.js';
import type { InkObject, RectObject, TextObject } from './lesson.js';

const rect: RectObject = {
  id: 'r1',
  type: 'rect',
  x: 10,
  y: 20,
  width: 100,
  height: 50,
  fill: '#f00',
  stroke: '#000',
  strokeWidth: 1,
};

const text: TextObject = {
  id: 't1',
  type: 'text',
  x: 0,
  y: 0,
  text: 'Hello',
  fontSize: 20,
  fill: '#000',
};

const ink: InkObject = {
  id: 'i1',
  type: 'ink',
  x: 0,
  y: 0,
  points: [0, 0, 100, 0, 100, 100],
  color: '#111',
  size: 4,
};

describe('hitRect', () => {
  it('accepts a point strictly inside', () => {
    expect(hitRect(rect, 50, 40)).toBe(true);
  });
  it('accepts a point on the edge', () => {
    expect(hitRect(rect, 10, 20)).toBe(true);
    expect(hitRect(rect, 110, 70)).toBe(true);
  });
  it('rejects a point outside', () => {
    expect(hitRect(rect, 5, 40)).toBe(false);
    expect(hitRect(rect, 200, 40)).toBe(false);
    expect(hitRect(rect, 50, 5)).toBe(false);
    expect(hitRect(rect, 50, 100)).toBe(false);
  });
});

describe('hitText', () => {
  it('hits within the approximate bounding box', () => {
    // width = 5 * 20 * 0.55 = 55, height = 20
    expect(hitText(text, 10, 10)).toBe(true);
    expect(hitText(text, 54, 19)).toBe(true);
  });
  it('rejects points outside the approximation', () => {
    expect(hitText(text, 100, 10)).toBe(false);
    expect(hitText(text, 10, 30)).toBe(false);
  });
  it('empty text still has a minimum 1-char-worth of hit-area', () => {
    const empty: TextObject = { ...text, text: '' };
    // With Math.max(1, ...), width = 1 * 20 * 0.55 = 11
    expect(hitText(empty, 5, 10)).toBe(true);
  });
});

describe('hitInk', () => {
  it('hits a point directly on a segment', () => {
    // Segment from (0,0) to (100,0); point (50,0) is on it.
    expect(hitInk(ink, 50, 0)).toBe(true);
  });
  it('hits within threshold (size/2 + tolerance)', () => {
    // Threshold = 4/2 + 2 = 4; a point 3 units off the segment still hits.
    expect(hitInk(ink, 50, 3)).toBe(true);
  });
  it('misses beyond threshold', () => {
    expect(hitInk(ink, 50, 20)).toBe(false);
  });
  it('single-point ink acts like a small circle', () => {
    const dot: InkObject = { ...ink, points: [50, 50] };
    expect(hitInk(dot, 51, 51)).toBe(true);
    expect(hitInk(dot, 100, 100)).toBe(false);
  });
  it('empty ink is never hit', () => {
    const nothing: InkObject = { ...ink, points: [] };
    expect(hitInk(nothing, 0, 0)).toBe(false);
  });
  it('honors the object x/y offset (points are relative to it)', () => {
    // Same stroke translated by (200, 300): hit at translated location,
    // miss at the untranslated one.
    const moved: InkObject = { ...ink, x: 200, y: 300 };
    expect(hitInk(moved, 250, 300)).toBe(true);
    expect(hitInk(moved, 50, 0)).toBe(false);
    // Single-point dot also honors the offset.
    const dot: InkObject = { ...ink, x: 200, y: 300, points: [50, 50] };
    expect(hitInk(dot, 251, 351)).toBe(true);
    expect(hitInk(dot, 51, 51)).toBe(false);
  });
});

describe('hitObject', () => {
  it('dispatches by object type', () => {
    expect(hitObject(rect, 50, 40)).toBe(true);
    expect(hitObject(text, 10, 10)).toBe(true);
    expect(hitObject(ink, 50, 0)).toBe(true);
  });
});

describe('hitTest', () => {
  it('returns empty when no objects hit', () => {
    expect(hitTest([rect, text, ink], 1000, 1000)).toEqual([]);
  });
  it('returns the top-most first when multiple hit', () => {
    // rect covers (10..110, 20..70); ink passes through (50,0)-(100,0)-(100,100)
    // At (100, 50): rect (yes), ink (yes at bottom leg).
    // In source order [rect, ink], ink is "above". hitTest should return [ink, rect].
    const hits = hitTest([rect, ink], 100, 50);
    expect(hits.map((o) => o.id)).toEqual(['i1', 'r1']);
  });
  it('returns only the objects actually hit', () => {
    // At (5, 5): text hits (0..55, 0..20); rect misses; ink misses.
    const hits = hitTest([rect, ink, text], 5, 5);
    expect(hits.map((o) => o.id)).toEqual(['t1']);
  });

  // Regression for PR #8 review finding P1: hit-test used to reverse
  // source order and ignored that ink renders above rect/text
  // (annotationLayer above contentLayer). Now stacking rank wins over
  // source order.
  it('ranks annotationLayer objects (ink) above contentLayer objects (rect/text)', () => {
    // Both hit (50, 40): rect covers (10..110, 20..70); ink stroke
    // passes through (40, 40)-(60, 40).
    const inkAcross: InkObject = { ...ink, id: 'i-across', points: [40, 40, 60, 40] };

    // Source order [ink, rect] — ink first in the array — still returns [ink, rect]
    const hitsInkFirst = hitTest([inkAcross, rect], 50, 40);
    expect(hitsInkFirst.map((o) => o.id)).toEqual(['i-across', 'r1']);

    // Source order [rect, ink] — rect first — must also return [ink, rect]
    // (this is the case the old reverse-order implementation got wrong).
    const hitsRectFirst = hitTest([rect, inkAcross], 50, 40);
    expect(hitsRectFirst.map((o) => o.id)).toEqual(['i-across', 'r1']);
  });

  it('within one layer, later source index wins the tie', () => {
    const r1: RectObject = { ...rect, id: 'r1' };
    const r2: RectObject = { ...rect, id: 'r2' };
    const hits = hitTest([r1, r2], 50, 40);
    expect(hits.map((o) => o.id)).toEqual(['r2', 'r1']);
  });
});
