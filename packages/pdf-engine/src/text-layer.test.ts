import { describe, expect, it } from 'vitest';
import { mapTextItemToRun } from './text-layer.js';

describe('mapTextItemToRun', () => {
  // A PDF.js viewport transform for an unrotated page rendered at scale
  // `s` with device height `H` flips the y-axis: [s, 0, 0, -s, 0, H].
  const s = 2;
  const H = 1000;
  const viewportTransform: [number, number, number, number, number, number] = [s, 0, 0, -s, 0, H];

  it('maps a text item into device/page coordinates matching the raster', () => {
    // A glyph run of font size 12 at PDF-space (100, 700), width 50 units.
    const item = { str: 'Hello', width: 50, height: 12, transform: [12, 0, 0, 12, 100, 700] };
    const run = mapTextItemToRun(item, viewportTransform);

    expect(run.text).toBe('Hello');
    expect(run.fontSize).toBeCloseTo(s * 12); // device font size
    expect(run.x).toBeCloseTo(s * 100); // device x
    // baseline f = H - s*700; box top = f - fontSize
    expect(run.y).toBeCloseTo(H - s * 700 - s * 12);
    expect(run.width).toBeCloseTo(50 * s); // device width
  });

  it('scales consistently with the render scale', () => {
    const item = { str: 'x', width: 10, height: 10, transform: [10, 0, 0, 10, 0, 0] };
    const run = mapTextItemToRun(item, viewportTransform);
    expect(run.fontSize).toBeCloseTo(20);
    expect(run.width).toBeCloseTo(20);
  });
});
