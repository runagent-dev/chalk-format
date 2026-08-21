import { describe, expect, it } from 'vitest';
import { trimInkByCircle } from './ink-trim.js';
import type { InkObject } from './lesson.js';

function horizontalStroke(x1: number, x2: number, size = 4): InkObject {
  return { id: 'ink1', type: 'ink', x: 0, y: 0, points: [x1, 0, x2, 0], color: '#111', size };
}

describe('trimInkByCircle', () => {
  it('splits a stroke into two fragments when the circle cuts through the middle', () => {
    const ink = horizontalStroke(0, 100);
    // radius 10 + size/2 (2) = effRadius 12, centered at x=50 -> removes [38, 62]
    const fragments = trimInkByCircle(ink, 50, 0, 10);
    expect(fragments).toHaveLength(2);
    const [left, right] = fragments;
    expect(left!.points[0]).toBe(0);
    expect(left!.points[left!.points.length - 2]).toBeLessThanOrEqual(38);
    expect(right!.points[0]).toBeGreaterThanOrEqual(62);
    expect(right!.points[right!.points.length - 2]).toBe(100);
    // Fragments get fresh ids, not the original stroke's.
    expect(left!.id).not.toBe(ink.id);
    expect(right!.id).not.toBe(ink.id);
    expect(left!.id).not.toBe(right!.id);
  });

  it('clips one end into a single shorter fragment', () => {
    const ink = horizontalStroke(0, 100);
    // Circle centered at the very start of the stroke.
    const fragments = trimInkByCircle(ink, 0, 0, 10);
    expect(fragments).toHaveLength(1);
    expect(fragments[0]!.points[0]).toBeGreaterThan(0);
    expect(fragments[0]!.points[fragments[0]!.points.length - 2]).toBe(100);
  });

  it('fully covers a short stroke, leaving no fragments', () => {
    const ink = horizontalStroke(0, 10);
    const fragments = trimInkByCircle(ink, 5, 0, 20);
    expect(fragments).toEqual([]);
  });

  it('leaves a stroke entirely outside the circle as a single unchanged-shape fragment', () => {
    const ink = horizontalStroke(0, 100);
    const fragments = trimInkByCircle(ink, 1000, 1000, 5);
    expect(fragments).toHaveLength(1);
    expect(fragments[0]!.points[0]).toBe(0);
    expect(fragments[0]!.points[fragments[0]!.points.length - 2]).toBe(100);
  });

  it('honors the ink object x/y offset', () => {
    const ink = { ...horizontalStroke(0, 100), x: 200, y: 300 };
    // Absolute center at (250, 300) -> local x=50, same as the un-offset case.
    const fragments = trimInkByCircle(ink, 250, 300, 10);
    expect(fragments).toHaveLength(2);
  });

  it('a single-point dot stroke disappears when covered, survives otherwise', () => {
    const dot: InkObject = { id: 'd', type: 'ink', x: 0, y: 0, points: [50, 50], color: '#111', size: 4 };
    expect(trimInkByCircle(dot, 50, 50, 10)).toEqual([]);
    const survived = trimInkByCircle(dot, 500, 500, 10);
    expect(survived).toHaveLength(1);
    expect(survived[0]!.points).toEqual([50, 50]);
  });

  it('an empty-points stroke yields no fragments', () => {
    const empty: InkObject = { id: 'e', type: 'ink', x: 0, y: 0, points: [], color: '#111', size: 4 };
    expect(trimInkByCircle(empty, 0, 0, 10)).toEqual([]);
  });
});
