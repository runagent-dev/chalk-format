import JSZip from 'jszip';
import type { Lesson, LessonPage } from '@chalkbook/core';
import { CHALKBOOK_FORMAT, type Manifest } from './manifest.js';

export type UnpackInput = Uint8Array | ArrayBuffer | Blob;

export async function unpackLesson(input: UnpackInput): Promise<Lesson> {
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

  return {
    id: manifest.id,
    title: manifest.title,
    locale: manifest.locale,
    pages,
    createdAt: manifest.metadata.createdAt,
    updatedAt: manifest.metadata.updatedAt,
  };
}
