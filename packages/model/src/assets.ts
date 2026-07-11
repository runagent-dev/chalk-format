import type { Lesson, LessonObject, PageBackground } from './lesson.js';

/** Content-addressed asset ids referenced by a page background, if any. */
function backgroundAssetIds(bg: PageBackground): string[] {
  switch (bg.type) {
    case 'blank':
    case 'color':
      return [];
    case 'pdf_page':
      return bg.renderedImageAssetId ? [bg.assetId, bg.renderedImageAssetId] : [bg.assetId];
  }
}

/** Content-addressed asset ids referenced by an object, if any. */
function objectAssetIds(obj: LessonObject): string[] {
  switch (obj.type) {
    case 'rect':
    case 'text':
    case 'ink':
    case 'ellipse':
    case 'line':
    case 'arrow':
    case 'vector':
      return [];
    case 'image':
      return [obj.assetId];
    case 'embed': {
      // `url` embeds carry the reference in the object itself (not an
      // asset id), so they are not collected here. assetId + poster are.
      const ids: string[] = [];
      if (obj.assetId) ids.push(obj.assetId);
      if (obj.poster) ids.push(obj.poster);
      return ids;
    }
  }
}

/**
 * Every content-addressed asset id a lesson references, deduplicated.
 *
 * Single source of truth for "what assets does this lesson need" — used
 * by the packer (which bytes to inline) and, later, by the AssetService
 * (which bytes to pin/prefetch). The switches are exhaustive over the
 * background/object unions, so adding a new asset-bearing type is a
 * compile error until it is handled here — no silent drops (the export
 * bug where image/embed assets were missed came from a pdf_page-only
 * hand-rolled walk).
 */
export function referencedAssetIds(lesson: Lesson): string[] {
  const seen = new Set<string>();
  for (const page of lesson.pages) {
    for (const id of backgroundAssetIds(page.background)) seen.add(id);
    for (const obj of page.objects) {
      for (const id of objectAssetIds(obj)) seen.add(id);
    }
  }
  return [...seen];
}
