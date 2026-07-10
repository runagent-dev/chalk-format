import { describe, expect, it } from 'vitest';
import { CHALK_FORMAT_VERSION } from './schema.js';
import { migrateToLatest } from './migrate.js';

describe('migrateToLatest', () => {
  it('returns the document unchanged when already at the latest version', () => {
    const doc = { id: 'x' };
    expect(migrateToLatest(doc, CHALK_FORMAT_VERSION)).toBe(doc);
  });

  it('returns the document unchanged for a version at or above latest', () => {
    const doc = { id: 'y' };
    expect(migrateToLatest(doc, CHALK_FORMAT_VERSION + 1)).toBe(doc);
  });

  it('throws a clear error when a needed migration is missing', () => {
    // Version 0 has no registered migration to reach v1 — the harness
    // must fail loudly rather than silently pass an un-upgraded doc.
    expect(() => migrateToLatest({}, 0)).toThrow(/migration/i);
  });

  it('upgrades a v1 document to the latest without throwing', () => {
    // A v1 lesson has no textLayer on its pages; the v1→v2 migration
    // leaves it absent (optional), so the upgraded doc is valid under v2.
    const v1 = {
      id: 'l',
      title: 'Legacy',
      locale: 'en',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      pages: [{ id: 'p', title: 'Page 1', background: { type: 'blank' }, objects: [] }],
    };
    expect(() => migrateToLatest(v1, 1)).not.toThrow();
  });
});
