import { describe, expect, it } from 'vitest';
import { CHALK_FORMAT_VERSION, parseLesson } from './schema.js';
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

  it('upgrades a v5 document (no snipPages, no snip objects) to the latest and defaults snipPages to []', () => {
    // A v5 lesson has no snipPages field at all — the v5→v6 migration is
    // identity, and schema.ts's z.default([]) fills it in at parse time.
    const v5 = {
      id: 'l',
      title: 'Legacy',
      locale: 'en',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      pages: [{ id: 'p', title: 'Page 1', background: { type: 'blank' }, objects: [] }],
    };
    const migrated = migrateToLatest(v5, 5);
    expect(() => parseLesson(migrated)).not.toThrow();
    expect(parseLesson(migrated).snipPages).toEqual([]);
  });

  it('upgrades a v6 document (no coverAssetId) to the latest without throwing', () => {
    // A v6 lesson has no top-level `coverAssetId` — the v6→v7 migration
    // leaves it absent (optional), so the upgraded doc is valid under v7
    // and simply falls back to the derived "use page 1" cover.
    const v6 = {
      id: 'l',
      title: 'Legacy',
      locale: 'en',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      pages: [{ id: 'p', title: 'Page 1', background: { type: 'blank' }, objects: [] }],
    };
    expect(() => migrateToLatest(v6, 6)).not.toThrow();
  });

  it('upgrades a v7 document (no plugin ids, no labs) to the latest unchanged', () => {
    const v7 = {
      id: 'l',
      title: 'Legacy',
      locale: 'en',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      snipPages: [],
      pages: [{ id: 'p', title: 'Page 1', background: { type: 'blank' }, objects: [
        { id: 'w', x: 0, y: 0, type: 'embed', embed: 'plugin', width: 10, height: 10 },
      ] }],
    };
    expect(migrateToLatest(v7, 7)).toBe(v7);
    expect(() => parseLesson(migrateToLatest(v7, 7))).not.toThrow();
  });

  it('upgrades a v8 document (sha256 ids only) to the latest unchanged', () => {
    const v8 = { id: 'l', title: 'T', locale: 'bn', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', snipPages: [],
      pages: [{ id: 'p', title: 'P', background: { type: 'image', assetId: 'sha256:' + 'a'.repeat(64) }, objects: [] }] };
    expect(migrateToLatest(v8, 8)).toBe(v8);
    expect(() => parseLesson(migrateToLatest(v8, 8))).not.toThrow();
  });

  it('upgrades a v9 document (no presentation) to the latest unchanged', () => {
    const v9 = { id: 'l', title: 'T', locale: 'bn', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', snipPages: [],
      pages: [{ id: 'p', title: 'P', background: { type: 'blank' }, objects: [
        { id: 'i', type: 'image', x: 0, y: 0, width: 10, height: 10, assetId: 'c1:' + 'a'.repeat(25) + 'a', displayMode: 'icon' }] }] };
    expect(migrateToLatest(v9, 9)).toBe(v9);
    expect(() => parseLesson(migrateToLatest(v9, 9))).not.toThrow();
  });
});
