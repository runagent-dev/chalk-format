import { CHALK_FORMAT_VERSION } from './schema.js';

/**
 * Upgrades a stored document from one format version to the next.
 * Operates on the raw (pre-validation) value, since an old document may
 * not satisfy the current schema until migrated.
 */
export type Migration = (doc: unknown) => unknown;

/**
 * Registry of migrations. Key N migrates a document of formatVersion N
 * to version N+1. There are no migrations yet (v1 is the first version);
 * every future schema change adds one entry here plus a versioned
 * fixture test proving old files still open.
 */
export const MIGRATIONS: Record<number, Migration> = {
  // v1 → v2: pages gained an optional `textLayer`. A v1 page simply has
  // none, which is already valid under v2, so this is an identity
  // migration — but it must be registered so migrateToLatest can bridge
  // v1 files to the current version.
  1: (doc) => doc,
  // v2 → v3: added rich object types (image/ellipse/line/arrow/vector/
  // embed). Purely additive — a v2 document contains none of them and is
  // already valid under v3, so identity again.
  2: (doc) => doc,
  // v3 → v4: image/embed objects gained an optional `displayMode`. A v3
  // document has none, which is already valid under v4 (absent means
  // 'full', the same rendering v3 always had), so identity again.
  3: (doc) => doc,
  // v4 → v5: pdf_page backgrounds gained an optional `thumbnailAssetId`.
  // A v4 document has none, which is already valid under v5 (the page
  // panel falls back to having no thumbnail to show), so identity again.
  4: (doc) => doc,
  // v5 → v6: lessons gained snipPages (region-snip satellite pages), a
  // 'snip' object type, and an 'image' page-background variant. A v5
  // document has none of these; snipPages defaults to [] at parse time
  // (see schema.ts's z.default), so this is identity again.
  5: (doc) => doc,
  // v6 → v7: the lesson gained an optional top-level `coverAssetId`. A v6
  // document has none, which is already valid under v7 (the derived
  // "use page 1" fallback still applies), so identity again.
  6: (doc) => doc,
};

/**
 * Run the chain of migrations from `fromVersion` up to the current
 * CHALK_FORMAT_VERSION. Documents already at or beyond the latest are
 * returned unchanged. A gap in the registry throws loudly rather than
 * silently passing an un-upgraded document to the validator.
 */
export function migrateToLatest(doc: unknown, fromVersion: number): unknown {
  let version = fromVersion;
  let current = doc;
  while (version < CHALK_FORMAT_VERSION) {
    const migration = MIGRATIONS[version];
    if (!migration) {
      throw new Error(
        `no migration registered from format version ${version} (target ${CHALK_FORMAT_VERSION})`,
      );
    }
    current = migration(current);
    version += 1;
  }
  return current;
}
