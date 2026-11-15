import { describe, expect, it } from 'vitest';
import { localDigits, pageNumberText, runIsHidden, visibleTextLayer } from './printed-marks.js';
import { lessonPageSchema } from './schema.js';

const run = (text: string, x: number, y: number) => ({ text, x, y, width: 30, fontSize: 12 });

describe('printed marks (spec 1.9)', () => {
  const page = {
    textLayer: [run('৯৬', 128, 100), run('বল', 600, 100), run('ফর্মা-২, পদার্থবিজ্ঞান', 120, 1500)],
    hidden: [{ x: 120, y: 95, width: 45, height: 25, fill: '#e3e8f4' }, { x: 110, y: 1495, width: 300, height: 30, fill: '#ffffff' }],
  };

  it('drops the runs whose centre a hidden area covers, keeps the rest', () => {
    expect(visibleTextLayer(page).map((r) => r.text)).toEqual(['বল']);
    expect(runIsHidden(run('বল', 600, 100), page.hidden)).toBe(false);
  });

  it('returns the text layer unchanged without hidden areas', () => {
    expect(visibleTextLayer({ textLayer: page.textLayer })).toHaveLength(3);
    expect(visibleTextLayer({})).toEqual([]);
  });

  it('numbers a page by its position, in the book\'s digits', () => {
    expect(pageNumberText(99, 'bn')).toBe('১০০');
    expect(pageNumberText(0, 'bn-BD')).toBe('১');
    expect(pageNumberText(11, 'en')).toBe('12');
    expect(pageNumberText(11, 'bn', 'iv')).toBe('iv');
    expect(localDigits('hi', 42)).toBe('४२');
  });

  it('keeps hidden areas and the number slot when a page is parsed', () => {
    const parsed = lessonPageSchema.parse({ id: 'p', title: 'p', background: { type: 'blank' }, objects: [], ...page, numberSlot: { x: 128, y: 116, fontSize: 22, align: 'start', color: '#4d5861' } });
    expect(parsed.hidden).toHaveLength(2);
    expect(parsed.numberSlot).toEqual({ x: 128, y: 116, fontSize: 22, align: 'start', color: '#4d5861' });
    expect(() => lessonPageSchema.parse({ id: 'p', title: 'p', background: { type: 'blank' }, objects: [], numberSlot: { x: 1, y: 1, fontSize: 10, align: 'left' } })).toThrow();
  });
});
