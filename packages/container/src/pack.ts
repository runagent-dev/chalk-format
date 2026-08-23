import JSZip from 'jszip';
import {
  CHALK_FORMAT_VERSION,
  isSha256AssetId,
  referencedAssetIds,
  validateLessonModel,
  type Lesson,
} from '@chalkbook/core';
import {
  CHALKBOOK_FORMAT,
  CHALKBOOK_VERSION,
  type Manifest,
  type ManifestAssetEntry,
} from './manifest.js';

/** Bundle of raw asset bytes keyed by asset id (e.g. content-hash). */
export type AssetBundle = Map<string, AssetPayload>;

export interface AssetPayload {
  /** MIME type, e.g. "application/pdf", "image/png" */
  type: string;
  bytes: Uint8Array;
}

export interface PackOptions {
  /**
   * `fat` (default) inlines every asset's bytes into the ZIP — a fully
   * self-contained file. `thin` externalizes content-addressed
   * (`sha256:…`) assets: they are listed in the manifest but their bytes
   * are left out, to be fetched from the AssetService by id. This yields
   * a tiny `.chalk` that links to shared/cloud assets instead of carrying
   * (often large) page rasters.
   *
   * Non-content-addressed assets are ALWAYS inlined even in `thin` mode —
   * there is no id-based way to re-fetch them, so dropping their bytes
   * would make the bundle permanently unrenderable.
   */
  mode?: 'fat' | 'thin';
  /**
   * Content-addressed ids to inline even under `mode: 'thin'` — e.g. a
   * catalog book's small page thumbnails, so a thin bundle still opens with
   * something to show instantly while its (large) full-res page renders
   * externalize. Ignored in `fat` mode, where everything already inlines.
   */
  alwaysInline?: ReadonlySet<string>;
}

/**
 * Pack a lesson into a `.chalk` ZIP.
 *
 * @param lesson  The lesson to pack.
 * @param assets  Optional bundle of asset payloads referenced by the
 *                lesson. Each entry is recorded in the manifest under
 *                `assets/<id>`; in `fat` mode its bytes are written there
 *                too. When omitted the manifest carries an empty asset
 *                list.
 * @param options Packing options — see {@link PackOptions.mode}.
 */
export async function packLesson(
  lesson: Lesson,
  assets?: AssetBundle,
  options?: PackOptions,
): Promise<Uint8Array> {
  const thin = options?.mode === 'thin';
  // Never emit an invalid document: validate the model against the same
  // schema the decoder parses with, so anything packLesson accepts,
  // unpackLesson accepts.
  const validation = validateLessonModel(lesson);
  if (!validation.ok) {
    throw new Error(`cannot pack an invalid lesson: ${validation.issues.join('; ')}`);
  }

  const zip = new JSZip();

  const assetEntries = writeAssetsToZip(zip, assets, thin, options?.alwaysInline);

  // Referenced content-addressed assets whose bytes were not provided are
  // intentional cloud references (media lives in the object store + client
  // cache, never bundled). Record them as external manifest entries so the
  // decoder resolves them from the asset service instead of "missing".
  const bundled = new Set(assetEntries.map((e) => e.id));
  for (const id of referencedAssetIds(lesson)) {
    if (bundled.has(id) || !isSha256AssetId(id)) continue;
    assetEntries.push({
      id,
      type: 'application/octet-stream',
      path: assetStorageKey(id),
      inline: false,
    });
  }

  const manifest: Manifest = {
    format: CHALKBOOK_FORMAT,
    version: CHALKBOOK_VERSION,
    formatVersion: CHALK_FORMAT_VERSION,
    id: lesson.id,
    title: lesson.title,
    locale: lesson.locale,
    ...(lesson.coverAssetId ? { coverAssetId: lesson.coverAssetId } : {}),
    pages: lesson.pages.map((page, index) => ({
      id: page.id,
      file: `pages/page-${index + 1}.json`,
    })),
    assets: assetEntries,
    bundling: thin ? 'thin' : 'fat',
    metadata: {
      createdAt: lesson.createdAt,
      updatedAt: lesson.updatedAt,
      license: 'CC BY 4.0',
    },
  };

  zip.file('manifest.json', JSON.stringify(manifest, null, 2));

  lesson.pages.forEach((page, index) => {
    zip.file(`pages/page-${index + 1}.json`, JSON.stringify(page, null, 2));
  });

  // DEFLATE the default (manifest + pages: plain JSON, compresses well).
  // Asset bytes get their own STORE override in writeAssetsToZip — they're
  // already-compressed formats (PNG/JPEG/PDF/etc.), so re-deflating them
  // burns CPU for near-zero size gain.
  return zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

/**
 * Write an asset bundle into a ZIP and return the manifest entries. In
 * `thin` mode a content-addressed asset is externalized (entry only, no
 * bytes) so it can be re-fetched by id — unless it's in `alwaysInline`.
 * Everything else is inlined. Shared by packLesson and packOverlay so both
 * write assets identically.
 */
export function writeAssetsToZip(
  zip: JSZip,
  assets: AssetBundle | undefined,
  thin: boolean,
  alwaysInline?: ReadonlySet<string>,
): ManifestAssetEntry[] {
  const assetEntries: ManifestAssetEntry[] = [];
  if (!assets) return assetEntries;
  const pathToId = new Map<string, string>();
  for (const [id, payload] of assets) {
    const path = assetStorageKey(id);
    const previous = pathToId.get(path);
    if (previous !== undefined) {
      // Escaping is lossy ('a:b' and 'a_b' both become 'a_b'); writing
      // both would silently return wrong bytes for one id on unpack.
      throw new Error(
        `asset ids collide after path escaping: '${previous}' and '${id}' both map to '${path}'`,
      );
    }
    pathToId.set(path, id);
    const inline = !thin || !isSha256AssetId(id) || (alwaysInline?.has(id) ?? false);
    // STORE, not DEFLATE: asset bytes (images/PDFs/video/3D) are already
    // compressed formats — re-deflating them costs CPU for near-zero gain.
    if (inline) zip.file(path, payload.bytes, { compression: 'STORE' });
    assetEntries.push({ id, type: payload.type, path, inline });
  }
  return assetEntries;
}

/**
 * Turn an asset id into something the ZIP can safely hold. Content-
 * addressed ids like `sha256:...` use a colon that some tooling
 * dislikes — replace with `_`. Path-traversal characters are stripped
 * defensively.
 */
function safeAssetPath(id: string): string {
  return id.replace(/[:/\\]/g, '_').replace(/\.\./g, '_');
}

/**
 * Canonical storage key for a content-addressed asset — `assets/<safe>`.
 * The single scheme shared by the .chalk packer, the cloud upload tool,
 * and the client's cloud-fallback resolver, so an asset written to a
 * bucket at this key is the same one a `.chalk` references.
 */
export function assetStorageKey(id: string): string {
  return `assets/${safeAssetPath(id)}`;
}

/**
 * Deterministic key for a book's thin variant, derived from the FAT
 * source's own content hash — not the thin bytes' own hash, which would be
 * non-reproducible (JSZip stamps each entry with the current time when no
 * explicit `date` option is given, so two packs of identical content
 * produce different zip bytes). Same source → same key, every republish; a
 * content change changes `chalkAssetId`, which changes this key too, so it
 * can never point at stale bytes. `assetStorageKey`'s output never
 * contains a dot, so this suffix can't collide with a real asset key.
 */
export function thinBundleStorageKey(chalkAssetId: string): string {
  return `${assetStorageKey(chalkAssetId)}.thin`;
}
