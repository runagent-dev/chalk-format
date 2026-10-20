import { describe, expect, it } from 'vitest';
import type { LessonObject } from '@chalk-format/model';
import { bounds, hits, inkFrom, moved, topHit, translucent } from './ops.js';

const ink: LessonObject = { id: 'i', type: 'ink', x: 100, y: 100, points: [0, 0, 50, 0, 50, 50], color: '#000', size: 6 };
const rect: LessonObject = { id: 'r', type: 'rect', x: 0, y: 0, width: 80, height: 40, fill: 'transparent', stroke: '#000', strokeWidth: 2 };
const line: LessonObject = { id: 'l', type: 'arrow', x: 0, y: 200, x2: 100, y2: 200, stroke: '#000', strokeWidth: 4 };

describe('annotation geometry', () => {
  it('hits a stroke near its path, not inside its bounding box', () => {
    expect(hits(ink, { x: 125, y: 102 }, 2)).toBe(true);
    expect(hits(ink, { x: 120, y: 130 }, 2)).toBe(false);   // inside the box, away from the stroke
  });

  it('hits lines by distance and boxes by area', () => {
    expect(hits(line, { x: 50, y: 203 }, 2)).toBe(true);
    expect(hits(line, { x: 50, y: 210 }, 2)).toBe(false);
    expect(hits(rect, { x: 40, y: 20 }, 0)).toBe(true);
  });

  it('picks the topmost editable object', () => {
    const over: LessonObject = { ...rect, id: 'r2' };
    expect(topHit([rect, over], { x: 10, y: 10 }, 0, () => true)?.id).toBe('r2');
    expect(topHit([rect, over], { x: 10, y: 10 }, 0, (o) => o.id === 'r')?.id).toBe('r');
    expect(topHit([rect], { x: 500, y: 500 }, 0, () => true)).toBeNull();
  });

  it('moves every kind of object, lines by both ends', () => {
    expect(moved(rect, 5, -5)).toMatchObject({ x: 5, y: -5 });
    expect(moved(line, 10, 0)).toMatchObject({ x: 10, x2: 110 });
    expect(moved(ink, 1, 1).points).toBe(ink.type === 'ink' ? ink.points : []);
  });

  it('stores ink as offsets from its first point', () => {
    expect(inkFrom([{ x: 10, y: 20 }, { x: 15, y: 25.04 }])).toEqual({ x: 10, y: 20, points: [0, 0, 5, 5] });
    expect(bounds(ink)).toEqual({ x: 97, y: 97, width: 56, height: 56 });
  });

  it('makes highlighter colours translucent', () => {
    expect(translucent('#ffe066')).toBe('#ffe0666b');
    expect(translucent('#abc', 1)).toBe('#aabbccff');
    expect(translucent('rgb(1,2,3)')).toBe('rgb(1,2,3)');
  });
});
