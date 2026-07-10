import { describe, expect, it } from 'vitest';
import { resolveRenderFormat } from './renderer.js';

describe('resolveRenderFormat', () => {
  it('defaults to WebP for the size win', () => {
    const r = resolveRenderFormat({});
    expect(r.mime).toBe('image/webp');
    expect(r.quality).toBeGreaterThan(0);
    expect(r.quality).toBeLessThanOrEqual(1);
  });

  it('honors an explicit png format (quality irrelevant)', () => {
    expect(resolveRenderFormat({ format: 'png' }).mime).toBe('image/png');
  });

  it('honors an explicit webp quality', () => {
    expect(resolveRenderFormat({ format: 'webp', quality: 0.95 }).quality).toBe(0.95);
  });

  it('clamps quality into [0, 1]', () => {
    expect(resolveRenderFormat({ quality: 5 }).quality).toBe(1);
    expect(resolveRenderFormat({ quality: -1 }).quality).toBe(0);
  });
});
