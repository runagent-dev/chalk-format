import { describe, expect, it } from 'vitest';
import { HEAD, MARGIN, MIN_BODY, aspectFor, fit, move, openBox, overlap, resize, sheetBox, type Box } from './windowGeometry.js';

const root = { w: 1280, h: 800 };
const A = 16 / 9;
const inside = (b: Box, r = root) => b.x >= MARGIN && b.y >= MARGIN && b.x + b.w <= r.w - MARGIN && b.y + b.h <= r.h - MARGIN;
const bodyAspect = (b: Box) => b.w / (b.h - HEAD);

describe('floating window geometry (spec 1.6)', () => {
  it('opens at the media proportions, at the top right, inside the reader', () => {
    const b = openBox(root, A);
    expect(bodyAspect(b)).toBeCloseTo(A, 1);
    expect(b.w).toBe(560);
    expect(b.x + b.w).toBe(root.w - 24);
    expect(b.y).toBe(24);
    expect(inside(b)).toBe(true);
  });

  it('opens beside the object that opened it: on the side that covers less of it', () => {
    expect(openBox(root, A, { x: 900, y: 40, w: 300, h: 200 }).x).toBe(24);
    expect(openBox(root, A, { x: 100, y: 40, w: 300, h: 200 }).x).toBe(root.w - 560 - 24);
    // a wide object that reaches across the page: the side that overlaps it less, never more than the other
    const wide = { x: 267, y: 177, w: 745, h: 257 };
    const b = openBox(root, A, wide);
    const other = { ...b, x: b.x === 24 ? root.w - b.w - 24 : 24 };
    expect(overlap(b, wide)).toBeLessThanOrEqual(overlap(other, wide));
    expect(overlap(b, wide) / (wide.w * wide.h)).toBeLessThan(0.4);
  });

  it('measures how much two boxes share', () => {
    expect(overlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 })).toBe(25);
    expect(overlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 0, w: 5, h: 5 })).toBe(0);
  });

  it('a tall medium is held to 80 % of the reader height and keeps its shape', () => {
    const b = openBox(root, 0.5);
    expect(b.h).toBeLessThanOrEqual(root.h * 0.8 + 1);
    expect(bodyAspect(b)).toBeCloseTo(0.5, 1);
    expect(inside(b)).toBe(true);
  });

  it('a free shape opens at a default size', () => {
    const b = openBox(root, null);
    expect(b.w).toBe(440);
    expect(b.h).toBe(300 + HEAD);
  });

  it('moves, and cannot leave the reader', () => {
    const b = openBox(root, A);
    expect(move(b, -50, 40, root)).toMatchObject({ x: b.x - 50, y: b.y + 40 });
    const far = move(b, 5000, 5000, root);
    expect(far.x + far.w).toBe(root.w - MARGIN);
    expect(far.y + far.h).toBe(root.h - MARGIN);
    const near = move(b, -5000, -5000, root);
    expect(near).toMatchObject({ x: MARGIN, y: MARGIN });
  });

  it('resizing by the corner keeps the aspect and the opposite corner', () => {
    const b = move(openBox(root, A), -300, 100, root);
    const r = resize(b, 'se', 100, 10, root, A);
    expect(bodyAspect(r)).toBeCloseTo(A, 1);
    expect(r.w).toBe(b.w + 100);
    expect(r.x).toBe(b.x);
    expect(r.y).toBe(b.y);
    const nw = resize(b, 'nw', -80, -80, root, A);
    expect(bodyAspect(nw)).toBeCloseTo(A, 1);
    expect(nw.x + nw.w).toBe(b.x + b.w);
    expect(nw.y + nw.h).toBe(b.y + b.h);
  });

  it('an edge changes the other dimension to keep the aspect', () => {
    const b = move(openBox(root, A), -300, 100, root);
    const e = resize(b, 'w', -60, 0, root, A);
    expect(e.w).toBe(b.w + 60);
    expect(bodyAspect(e)).toBeCloseTo(A, 1);
    expect(e.x + e.w).toBe(b.x + b.w);
    const s = resize(b, 's', 0, 45, root, A);
    expect(bodyAspect(s)).toBeCloseTo(A, 1);
    expect(s.h).toBeGreaterThan(b.h);
  });

  it('a free window resizes each side on its own', () => {
    const b = move(openBox(root, null), -300, 100, root);
    const r = resize(b, 'se', 100, -50, root, null);
    expect(r.w).toBe(b.w + 100);
    expect(r.h).toBe(b.h - 50);
    expect(r.x).toBe(b.x);
  });

  it('stops at the reader edge on the side being pulled instead of sliding along it', () => {
    const b = openBox(root, A); // against the right edge
    const r = resize(b, 'se', 400, 0, root, A);
    expect(r.x).toBe(b.x);
    expect(r.x + r.w).toBeLessThanOrEqual(root.w - MARGIN);
    const l = resize(move(b, -600, 0, root), 'w', -2000, 0, root, A);
    expect(l.x).toBeGreaterThanOrEqual(MARGIN);
    expect(l.x + l.w).toBe(move(b, -600, 0, root).x + b.w);
  });

  it('never gets unusably small or larger than the reader, whatever the pull', () => {
    const b = openBox(root, A);
    const tiny = resize(b, 'se', -9999, -9999, root, A);
    expect(tiny.w).toBeGreaterThanOrEqual(MIN_BODY.w);
    expect(tiny.h - HEAD).toBeGreaterThanOrEqual(MIN_BODY.h);
    const huge = resize(b, 'se', 9999, 9999, root, A);
    expect(inside(huge)).toBe(true);
    expect(bodyAspect(huge)).toBeCloseTo(A, 1);
    const freeTiny = resize(openBox(root, null), 'se', -9999, -9999, root, null);
    expect(freeTiny.w).toBe(MIN_BODY.w);
    expect(freeTiny.h).toBe(MIN_BODY.h + HEAD);
  });

  it('a small reader still gets a window that fits', () => {
    const small = { w: 400, h: 300 };
    const b = openBox(small, A);
    expect(inside(b, small)).toBe(true);
    expect(fit({ x: 0, y: 0, w: 5000, h: 5000 }, small, null)).toMatchObject({ w: 384, h: 284 });
  });

  it('on a narrow reader it is a sheet across the bottom, as tall as the proportions ask but never more than 70 %', () => {
    const phone = { w: 390, h: 844 };
    const s = sheetBox(phone, A);
    expect(s).toMatchObject({ x: 0, w: 390 });
    expect(s.y + s.h).toBe(phone.h);
    expect(s.h).toBe(Math.round(390 / A + HEAD));
    expect(sheetBox(phone, 0.3).h).toBe(Math.round(phone.h * 0.7));
    expect(sheetBox(phone, null).h).toBeGreaterThanOrEqual(MIN_BODY.h + HEAD);
  });

  it('on a very short reader the sheet is never taller than the reader (header and close stay in view)', () => {
    for (const h of [60, 100, 128, 200, 300]) {
      const s = sheetBox({ w: 390, h }, A);
      expect(s.y, `h=${h}`).toBeGreaterThanOrEqual(0);
      expect(s.y + s.h, `h=${h}`).toBeLessThanOrEqual(h);
      expect(s.h, `h=${h}`).toBeLessThanOrEqual(h);
    }
  });

  it("takes the media's own shape, unless the host says otherwise", () => {
    expect(aspectFor({ width: 800, height: 500 }, 'media')).toBeCloseTo(1.6);
    expect(aspectFor({ width: 800, height: 500 }, 'free')).toBeNull();
    expect(aspectFor({ width: 800, height: 500 }, 4 / 3)).toBeCloseTo(4 / 3);
    expect(aspectFor({ width: 800, height: 500 }, 'media', true)).toBeNull(); // audio has no shape
    expect(aspectFor({ width: 0, height: 0 }, 'media')).toBeCloseTo(16 / 9);
    expect(aspectFor({ width: 4000, height: 10 }, 'media')).toBe(4); // an absurd box is held to a sane shape
    expect(aspectFor({ width: 800, height: 500 }, -2)).toBeNull();
    expect(aspectFor({ width: 800, height: 500 }, Number.NaN)).toBeNull();
  });
});
