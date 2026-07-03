import JSZip from 'jszip';
import type { Lesson, LessonPage } from '@chalkbook/core';
import { CHALKBOOK_FORMAT, type Manifest } from './manifest.js';
import type { AssetBundle, AssetPayload } from './pack.js';

export type UnpackInput = Uint8Array | ArrayBuffer | Blob;

export interface UnpackResult {
  lesson: Lesson;
  assets: AssetBundle;
}

/**
 * Read a `.chalk` ZIP. Returns both the lesson model and any bundled
 * assets (fat-bundle mode). Assets referenced in the manifest but
 * missing from the ZIP are silently skipped — a thin bundle may
 * reference them by id only and rely on a server-side AssetService
 * to fetch bytes.
 */
export async function unpackLesson(input: UnpackInput): Promise<UnpackResult> {
  const zip = await JSZip.loadAsync(input);
  const manifestFile = zip.file('manifest.json');
  if (!manifestFile) {
    throw new Error('missing manifest.json');
  }

  const manifest = JSON.parse(await manifestFile.async('string')) as Manifest;
  if (manifest.format !== CHALKBOOK_FORMAT) {
    throw new Error(`unexpected format: ${manifest.format}`);
  }

  const pages: LessonPage[] = [];
  for (const entry of manifest.pages) {
    if (entry.file.includes('..')) {
      throw new Error(`unsafe path in manifest: ${entry.file}`);
    }
    const pageFile = zip.file(entry.file);
    if (!pageFile) {
      throw new Error(`missing page file: ${entry.file}`);
    }
    pages.push(JSON.parse(await pageFile.async('string')) as LessonPage);
  }

  const assets: AssetBundle = new Map();
  for (const entry of manifest.assets ?? []) {
    if (entry.path.includes('..')) {
      throw new Error(`unsafe path in manifest asset: ${entry.path}`);
    }
    const file = zip.file(entry.path);
    if (!file) continue;
    const bytes = await file.async('uint8array');
    const payload: AssetPayload = { type: entry.type, bytes };
    assets.set(entry.id, payload);
  }

  return {
    lesson: {
      id: manifest.id,
      title: manifest.title,
      locale: manifest.locale,
      pages,
      createdAt: manifest.metadata.createdAt,
      updatedAt: manifest.metadata.updatedAt,
    },
    assets,
  };
}
