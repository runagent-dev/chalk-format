import { describe, expect, it } from 'vitest';
import type { LessonPage } from '@chalk-format/model';
import { findPrintedMarks, type PagePixels } from './printed-marks.js';
import { pageText } from './stream.js';

// A 600 × 800 page at 2 pixels per unit: a blue band at the top with a dark page number, white below.
const W = 600, H = 800, S = 2;
function picture(inks: { x: number; y: number; w: number; h: number }[]): PagePixels {
  const data = new Uint8ClampedArray(W * S * H * S * 4);
  for (let y = 0; y < H * S; y++) for (let x = 0; x < W * S; x++) {
    const band = y >= 30 * S && y < 60 * S, i = (y * W * S + x) * 4;
    const ink = inks.some((k) => x >= k.x * S && x < (k.x + k.w) * S && y >= k.y * S && y < (k.y + k.h) * S);
    const c = ink ? [30, 32, 43] : band ? [227, 232, 244] : [255, 255, 255];
    data[i] = c[0]!; data[i + 1] = c[1]!; data[i + 2] = c[2]!; data[i + 3] = 255;
  }
  return { width: W * S, height: H * S, data };
}
const page = (textLayer: LessonPage['textLayer']): LessonPage => ({ id: 'p', title: 'p', background: { type: 'blank' }, objects: [], width: W, height: H, textLayer });

describe('findPrintedMarks', () => {
  it('hides a page number in the band with the band colour and keeps its place as the number slot', () => {
    const m = findPrintedMarks(page([{ text: '৯৬', x: 60, y: 38, width: 16, fontSize: 9 }]), picture([{ x: 60, y: 39, w: 16, h: 10 }]));
    expect(m.hidden).toHaveLength(1);
    expect(m.hidden[0]!.fill).toBe('#e3e8f4');
    const a = m.hidden[0]!;
    expect(a.x).toBeLessThanOrEqual(60); expect(a.x + a.width).toBeGreaterThanOrEqual(76);
    expect(a.y).toBeLessThanOrEqual(39); expect(a.y + a.height).toBeGreaterThanOrEqual(49);
    expect(m.numberSlot).toMatchObject({ x: 60, y: 49, align: 'start', color: '#1e202b' });
    expect(m.numberSlot!.fontSize).toBeCloseTo(10 / 0.62, 0);
  });

  it('anchors a number on the right by its right end', () => {
    const m = findPrintedMarks(page([{ text: '১৩', x: 520, y: 38, width: 14, fontSize: 9 }]), picture([{ x: 520, y: 39, w: 14, h: 10 }]));
    expect(m.numberSlot).toMatchObject({ x: 534, align: 'end' });
  });

  it('hides margin lines that match a pattern, on white', () => {
    const m = findPrintedMarks(page([{ text: 'ফর্মা-২, পদার্থবিজ্ঞান', x: 60, y: 760, width: 140, fontSize: 9 }]), picture([{ x: 60, y: 761, w: 140, h: 10 }]), { patterns: [/^ফর্মা/u] });
    expect(m.hidden).toEqual([expect.objectContaining({ fill: '#ffffff' })]);
    expect(m.numberSlot).toBeUndefined();
  });

  it('never takes sideways digits for the page number; hides them when asked', () => {
    const year = { text: '২০২৩', x: 560, y: 715, width: 9, fontSize: 20 };
    const ink = picture([{ x: 561, y: 716, w: 8, h: 28 }]);
    expect(findPrintedMarks(page([year]), ink).hidden).toEqual([]);
    const m = findPrintedMarks(page([year]), ink, { sideways: true });
    expect(m.hidden).toHaveLength(1); expect(m.numberSlot).toBeUndefined(); expect(m.found[0]!.kind).toBe('sideways');
  });

  it('leaves body text alone, even digits and matches outside the margins', () => {
    const m = findPrintedMarks(page([{ text: '৪২', x: 60, y: 400, width: 16, fontSize: 9 }, { text: 'ফর্মা', x: 60, y: 420, width: 30, fontSize: 9 }]), picture([{ x: 60, y: 401, w: 16, h: 10 }, { x: 60, y: 421, w: 30, h: 10 }]), { patterns: [/^ফর্মা/u] });
    expect(m.hidden).toEqual([]);
  });

  it('leaves hidden runs out of the streamed text file', () => {
    const p = { ...page([{ text: '৯৬', x: 60, y: 38, width: 16, fontSize: 9 }, { text: 'বল', x: 300, y: 38, width: 16, fontSize: 9 }]), hidden: [{ x: 57, y: 36, width: 22, height: 16, fill: '#e3e8f4' }] };
    expect(pageText(p).map((r) => r.text)).toEqual(['বল']);
  });
});
