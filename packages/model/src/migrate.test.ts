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

  it('upgrades a v3 document (image object, no displayMode) to the latest without throwing', () => {
    // A v3 image object has no `displayMode` — the v3→v4 migration leaves
    // it absent (optional, meaning 'full'), so the upgraded doc is valid
    // under v4 and renders exactly as it did under v3.
    const v3 = {
      id: 'l',
      title: 'Legacy',
      locale: 'en',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      pages: [
        {
          id: 'p',
          title: 'Page 1',
          background: { type: 'blank' },
          objects: [{ id: 'i', type: 'image', x: 0, y: 0, assetId: 'sha256:abc', width: 100, height: 50 }],
        },
      ],
    };
    expect(() => migrateToLatest(v3, 3)).not.toThrow();
  });

  it('upgrades a v4 document (pdf_page background, no thumbnailAssetId) to the latest without throwing', () => {
    // A v4 pdf_page background has no `thumbnailAssetId` — the v4→v5
    // migration leaves it absent (optional), so the upgraded doc is
    // valid under v5 and simply has no thumbnail to show yet.
    const v4 = {
      id: 'l',
      title: 'Legacy',
      locale: 'en',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      pages: [
        {
          id: 'p',
          title: 'Page 1',
          background: { type: 'pdf_page', assetId: 'sha256:pdf', pageNumber: 1, renderedImageAssetId: 'sha256:render' },
          objects: [],
        },
      ],
    };
    expect(() => migrateToLatest(v4, 4)).not.toThrow();
  });

  it('upgrades a v5 document (no coverAssetId) to the latest without throwing', () => {
    // A v5 lesson has no top-level `coverAssetId` — the v5→v6 migration
    // leaves it absent (optional), so the upgraded doc is valid under v6
    // and simply falls back to the derived "use page 1" cover.
    const v5 = {
      id: 'l',
      title: 'Legacy',
      locale: 'en',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      pages: [{ id: 'p', title: 'Page 1', background: { type: 'blank' }, objects: [] }],
    };
    expect(() => migrateToLatest(v5, 5)).not.toThrow();
  });
});
