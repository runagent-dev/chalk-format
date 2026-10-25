import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, resolveConfig } from './config.js';

describe('the author mode options', () => {
  it('has the right-click menu on by default', () => {
    expect(resolveConfig().authoring.contextMenu).toBe(true);
    expect(DEFAULT_CONFIG.authoring.contextMenu).toBe(true);
  });

  it('lets a host turn it off without losing the other authoring defaults', () => {
    const a = resolveConfig({ authoring: { contextMenu: false } }).authoring;
    expect(a.contextMenu).toBe(false);
    expect({ ...a, contextMenu: true }).toEqual(DEFAULT_CONFIG.authoring);
  });
});
