import JSZip from 'jszip';
import {
  CHALK_FORMAT_VERSION,
  isSha256AssetId,
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

  const assetEntries: ManifestAssetEntry[] = [];
  if (assets) {
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
      // In thin mode, externalize only assets that can be re-fetched by id
      // (content-addressed). Everything else is inlined regardless of mode.
      const inline = !thin || !isSha256AssetId(id);
      if (inline) zip.file(path, payload.bytes);
      assetEntries.push({ id, type: payload.type, path, inline });
    }
  }

  const manifest: Manifest = {
    format: CHALKBOOK_FORMAT,
    version: CHALKBOOK_VERSION,
    formatVersion: CHALK_FORMAT_VERSION,
    id: lesson.id,
    title: lesson.title,
    locale: lesson.locale,
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

  return zip.generateAsync({ type: 'uint8array' });
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
