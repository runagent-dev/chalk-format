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
  version: string;
  id: string;
  title: string;
  locale: string;
  pages: ManifestPageEntry[];
  assets: ManifestAssetEntry[];
  metadata: ManifestMetadata;
};
