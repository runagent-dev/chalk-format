import JSZip from 'jszip';
import { CHALK_FORMAT_VERSION, validateLessonModel, type Lesson } from '@chalkbook/core';
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

/**
 * Pack a lesson into a `.chalk` ZIP.
 *
 * @param lesson  The lesson to pack.
 * @param assets  Optional bundle of asset payloads referenced by the
 *                lesson. Each entry is written under `assets/<id>` in
 *                the ZIP and recorded in the manifest. When omitted
 *                the manifest carries an empty asset list.
 */
export async function packLesson(lesson: Lesson, assets?: AssetBundle): Promise<Uint8Array> {
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
      const safeName = safeAssetPath(id);
      const path = `assets/${safeName}`;
      const previous = pathToId.get(path);
      if (previous !== undefined) {
        // Escaping is lossy ('a:b' and 'a_b' both become 'a_b'); writing
        // both would silently return wrong bytes for one id on unpack.
        throw new Error(
          `asset ids collide after path escaping: '${previous}' and '${id}' both map to '${path}'`,
        );
      }
      pathToId.set(path, id);
      zip.file(path, payload.bytes);
      assetEntries.push({ id, type: payload.type, path });
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
