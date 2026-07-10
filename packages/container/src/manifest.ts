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
  id: string;
  title: string;
  locale: string;
  pages: ManifestPageEntry[];
  assets: ManifestAssetEntry[];
  metadata: ManifestMetadata;
};
