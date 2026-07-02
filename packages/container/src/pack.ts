import JSZip from 'jszip';
import type { Lesson } from '@chalkbook/core';
import { CHALKBOOK_FORMAT, CHALKBOOK_VERSION, type Manifest } from './manifest.js';

export async function packLesson(lesson: Lesson): Promise<Uint8Array> {
  const zip = new JSZip();

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
    assets: [],
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
