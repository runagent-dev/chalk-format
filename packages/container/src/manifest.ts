import type { AssetMeta, OverlayBaseRef, Rendition, StoreDescriptor } from '@chalk-format/model';

export const CHALKBOOK_FORMAT = 'chalkbook.lesson' as const;
export const CHALKBOOK_VERSION = '0.1.0' as const;

export type ManifestPageEntry = {
  id: string;
  file: string;
  thumbnail?: string;
};

export type ManifestAssetEntry = {
  id: string;
  type: string;
  path: string;
  /**
   * Whether the bytes live in this ZIP (fat) or must be fetched from the
   * AssetService by id (thin). Absent = inline, so files written before
   * this field are read as fat — backward compatible.
   */
  inline?: boolean;
  /** Bytes (spec 1.2 §4.2). Writers give it for every asset; MUST for external ones. */
  size?: number;
  /** Width, height, duration, pages (spec 1.2 §4.2). */
  meta?: AssetMeta;
  /** Other versions of the same media item (spec 1.2 §4.3). */
  renditions?: Rendition[];
};

export type ManifestMetadata = {
  createdAt: string;
  updatedAt: string;
  author?: string;
  license?: string;
};

export type Manifest = {
  format: typeof CHALKBOOK_FORMAT;
  /** Human-readable display version (semver-ish). */
  version: string;
  /**
   * Integer model version that drives migration on decode. Files written
   * before this field existed are treated as version 1 (the model shape
   * was identical), so it is backward compatible.
   */
  formatVersion: number;
  /** `lesson` (default/absent) vs an overlay — see OverlayManifest. */
  kind?: 'lesson';
  id: string;
  title: string;
  locale: string;
  /** Explicit cover override — see `Lesson.coverAssetId`. Absent = derive
   *  from page 1. */
  coverAssetId?: string;
  pages: ManifestPageEntry[];
  /**
   * Satellite pages backing region-snip objects (see
   * `@chalk-format/model`'s `lesson.snipPages`). Absent = [] — files written
   * before this field existed have none, so this is backward compatible.
   */
  snipPages?: ManifestPageEntry[];
  assets: ManifestAssetEntry[];
  /**
   * How assets are carried. `fat` (default) inlines every asset's bytes;
   * `thin` externalizes cloud-resolvable assets, listing them in the
   * manifest for an AssetService to fetch by id. Absent = fat.
   */
  bundling?: 'fat' | 'thin';
  /** Stores the publisher suggests for external assets, tried last (spec 1.2 §4.4). No credentials. */
  assetSources?: StoreDescriptor[];
  metadata: ManifestMetadata;
};

/**
 * Manifest of an OVERLAY `.chalk` — a delta over a read-only base. The
 * overlay body lives in `overlay.json`; only the base pointer, the new
 * assets, and metadata live here. `kind: 'overlay'` distinguishes it from
 * a lesson bundle on decode.
 */
export type OverlayManifest = {
  format: typeof CHALKBOOK_FORMAT;
  version: string;
  formatVersion: number;
  kind: 'overlay';
  base: OverlayBaseRef;
  assets: ManifestAssetEntry[];
  bundling?: 'fat' | 'thin';
  metadata: ManifestMetadata;
};
