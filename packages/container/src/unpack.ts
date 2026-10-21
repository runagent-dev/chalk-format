import JSZip from 'jszip';
import { assetInfoSchema, isC1Key, migrateToLatest, parseLesson, storeDescriptorSchema, type AssetInfo, type Lesson, type StoreDescriptor } from '@chalk-format/model';
import { CHALKBOOK_FORMAT, type Manifest, type ManifestAssetEntry } from './manifest.js';
import type { AssetBundle, AssetPayload } from './pack.js';

/**
 * Read the assets a manifest declares out of a ZIP. Entries whose bytes
 * aren't present land in `missingAssetIds` (legal for thin bundles).
 * `countBytes` enforces the caller's inflate budget. Shared by
 * unpackLesson and unpackOverlay.
 */
export async function readAssetsFromZip(
  zip: JSZip,
  entries: ManifestAssetEntry[],
  countBytes: (n: number, path: string) => void,
): Promise<{ assets: AssetBundle; missingAssetIds: string[] }> {
  const assets: AssetBundle = new Map();
  const missingAssetIds: string[] = [];
  for (const entry of entries) {
    if (entry.path.includes('..')) {
      throw new Error(`unsafe path in manifest asset: ${entry.path}`);
    }
    const file = zip.file(entry.path);
    if (!file) {
      missingAssetIds.push(entry.id);
      continue;
    }
    const bytes = await file.async('uint8array');
    countBytes(bytes.length, entry.path);
    const payload: AssetPayload = { type: entry.type, bytes };
    assets.set(entry.id, payload);
  }
  return { assets, missingAssetIds };
}

export type UnpackInput = Uint8Array | ArrayBuffer | Blob;

/**
 * Safety limits applied while reading a `.chalk` package. Both guards
 * exist because a lesson file may come from an untrusted source: a
 * crafted ZIP with a huge central directory or highly-compressed
 * entries would otherwise DoS the importing browser tab.
 */
export interface UnpackLimits {
  /** Maximum number of ZIP entries. Default 10_000. */
  maxEntries?: number;
  /**
   * Maximum cumulative bytes inflated while reading manifest, pages,
   * and declared assets. Default 512 MiB.
   */
  maxTotalBytes?: number;
}

export const DEFAULT_MAX_ENTRIES = 10_000;
export const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;

export interface UnpackResult {
  lesson: Lesson;
  assets: AssetBundle;
  /**
   * Ids declared in the manifest whose bytes were not in the ZIP.
   * Legal for thin bundles (a server-side AssetService supplies the
   * bytes), but a standalone client should warn the user: pages
   * referencing these assets will render without their backgrounds.
   */
  missingAssetIds: string[];
  /**
   * How the file carried its assets. `thin` means the missing ids above
   * are expected (fetch them via the AssetService), not a damaged file.
   * Absent-in-manifest defaults to `fat` for backward compatibility.
   */
  bundling: 'fat' | 'thin';
  /** Facts the manifest gives per asset id: size, meta, renditions (spec 1.2 §4.2). */
  assetInfo: Map<string, AssetInfo>;
  /** Stores the book suggests for its external assets (spec 1.2 §4.4); invalid descriptors are dropped. */
  assetSources: StoreDescriptor[];
}

export function checkEntryCount(zip: JSZip, limits?: UnpackLimits): void {
  const maxEntries = limits?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const count = Object.keys(zip.files).length;
  if (count > maxEntries) {
    throw new Error(`package has ${count} entries, exceeding the limit of ${maxEntries}`);
  }
}

/**
 * Read a `.chalk` ZIP. Returns the lesson model, any bundled assets
 * (fat-bundle mode), and the ids of manifest assets that had no bytes
 * in the ZIP (thin bundles / damaged files) so callers can warn.
 */
export async function unpackLesson(
  input: UnpackInput,
  limits?: UnpackLimits,
): Promise<UnpackResult> {
  const zip = await JSZip.loadAsync(input);
  checkEntryCount(zip, limits);
  const maxTotalBytes = limits?.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  let totalBytes = 0;
  const countBytes = (n: number, path: string) => {
    totalBytes += n;
    if (totalBytes > maxTotalBytes) {
      throw new Error(
        `package exceeds the total-size limit of ${maxTotalBytes} bytes while reading ${path}`,
      );
    }
  };

  const manifestFile = zip.file('manifest.json');
  if (!manifestFile) {
    throw new Error('missing manifest.json');
  }

  const manifestText = await manifestFile.async('string');
  countBytes(manifestText.length, 'manifest.json');
  const manifest = JSON.parse(manifestText) as Manifest;
  if (manifest.format !== CHALKBOOK_FORMAT) {
    throw new Error(`unexpected format: ${manifest.format}`);
  }
  if (
    typeof manifest.metadata !== 'object' ||
    manifest.metadata === null ||
    typeof manifest.metadata.createdAt !== 'string' ||
    typeof manifest.metadata.updatedAt !== 'string'
  ) {
    throw new Error('manifest is missing metadata (createdAt/updatedAt)');
  }

  const rawPages: unknown[] = [];
  for (const entry of manifest.pages) {
    if (entry.file.includes('..')) {
      throw new Error(`unsafe path in manifest: ${entry.file}`);
    }
    const pageFile = zip.file(entry.file);
    if (!pageFile) {
      throw new Error(`missing page file: ${entry.file}`);
    }
    const pageText = await pageFile.async('string');
    countBytes(pageText.length, entry.file);
    try {
      rawPages.push(JSON.parse(pageText));
    } catch (err) {
      throw new Error(`invalid JSON in ${entry.file}: ${(err as Error).message}`);
    }
  }

  // Satellite pages backing region-snip objects — absent in files written
  // before this field existed, same backward-compat contract as `pages`.
  const rawSnipPages: unknown[] = [];
  for (const entry of manifest.snipPages ?? []) {
    if (entry.file.includes('..')) {
      throw new Error(`unsafe path in manifest: ${entry.file}`);
    }
    const pageFile = zip.file(entry.file);
    if (!pageFile) {
      throw new Error(`missing snip page file: ${entry.file}`);
    }
    const pageText = await pageFile.async('string');
    countBytes(pageText.length, entry.file);
    try {
      rawSnipPages.push(JSON.parse(pageText));
    } catch (err) {
      throw new Error(`invalid JSON in ${entry.file}: ${(err as Error).message}`);
    }
  }

  // 1.2: a key in any form but the canonical one, and a book that asks for credentials, are not readable
  for (const e of manifest.assets ?? []) {
    for (const id of [e.id, ...(e.renditions ?? []).map((r) => r.id)]) {
      if (/^c1:/i.test(id) && !isC1Key(id)) throw new Error(`malformed c1 key: ${id}`);
    }
  }
  if (manifest.assetSources !== undefined) {
    if (!Array.isArray(manifest.assetSources)) throw new Error('manifest.assetSources must be an array');
    for (const d of manifest.assetSources) {
      const r = storeDescriptorSchema.safeParse(d);
      if (!r.success) throw new Error(`invalid store descriptor in assetSources: ${r.error.issues[0]?.message ?? 'shape'}`);
      if ((r.data.auth ?? 'none') !== 'none') throw new Error(`store ${r.data.id}: a book's suggested stores carry no credentials`);
    }
  }

  const { assets, missingAssetIds } = await readAssetsFromZip(
    zip,
    manifest.assets ?? [],
    countBytes,
  );

  // Assemble the raw document, upgrade it from its stored format version
  // to the current one, then validate it through the schema. This
  // replaces the old `as LessonPage` cast: a tampered or outdated file is
  // rejected here rather than crashing later in the renderer.
  const rawLesson = {
    id: manifest.id,
    title: manifest.title,
    locale: manifest.locale,
    pages: rawPages,
    snipPages: rawSnipPages,
    createdAt: manifest.metadata.createdAt,
    updatedAt: manifest.metadata.updatedAt,
    ...(manifest.coverAssetId ? { coverAssetId: manifest.coverAssetId } : {}),
  };
  const fromVersion =
    typeof manifest.formatVersion === 'number' ? manifest.formatVersion : 1;
  const lesson: Lesson = parseLesson(migrateToLatest(rawLesson, fromVersion));

  const bundling = manifest.bundling === 'thin' ? 'thin' : 'fat';
  const assetInfo = new Map<string, AssetInfo>();
  for (const e of manifest.assets ?? []) {
    const info = assetInfoSchema.safeParse({ size: e.size, meta: e.meta, renditions: e.renditions });
    if (info.success && (e.size !== undefined || e.meta || e.renditions)) assetInfo.set(e.id, info.data);
  }
  const assetSources = (manifest.assetSources ?? []).map((d) => storeDescriptorSchema.parse(d));   // checked above
  return { lesson, assets, missingAssetIds, bundling, assetInfo, assetSources };
}
