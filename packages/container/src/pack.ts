import JSZip from 'jszip';
import type { Lesson } from '@chalkbook/core';
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
  const zip = new JSZip();

  const assetEntries: ManifestAssetEntry[] = [];
  if (assets) {
    for (const [id, payload] of assets) {
      const safeName = safeAssetPath(id);
      const path = `assets/${safeName}`;
      zip.file(path, payload.bytes);
      assetEntries.push({ id, type: payload.type, path });
    }
  }

  const manifest: Manifest = {
    format: CHALKBOOK_FORMAT,
    version: CHALKBOOK_VERSION,
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
