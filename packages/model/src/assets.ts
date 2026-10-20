import type { Lesson, LessonObject, PageBackground } from './lesson.js';
import type { Overlay } from './overlay.js';

/** Content-addressed asset ids referenced by a page background, if any. */
function backgroundAssetIds(bg: PageBackground): string[] {
  switch (bg.type) {
    case 'blank':
    case 'color':
      return [];
    case 'pdf_page': {
      const ids = [bg.assetId];
      if (bg.renderedImageAssetId) ids.push(bg.renderedImageAssetId);
      if (bg.thumbnailAssetId) ids.push(bg.thumbnailAssetId);
      return ids;
    }
    case 'image':
      return [bg.assetId];
  }
}

/** Content-addressed asset ids referenced by an object, if any. `snip`
 *  carries no asset id of its own — the capture lives on its satellite
 *  page (lesson.snipPages), reached only via snipPageId, and is collected
 *  by referencedAssetIds' separate snipPages loop. */
function objectAssetIds(obj: LessonObject): string[] {
  switch (obj.type) {
    case 'rect':
    case 'text':
    case 'ink':
    case 'ellipse':
    case 'line':
    case 'arrow':
    case 'vector':
    case 'snip':
      return [];
    case 'image':
      return [obj.assetId];
    case 'embed': {
      // `url` embeds carry the reference in the object itself (not an
      // asset id), so they are not collected here. assetId + poster are.
      const ids: string[] = [];
      if (obj.assetId) ids.push(obj.assetId);
      if (obj.poster) ids.push(obj.poster);
      // a lab's HTML and the assets it may load (spec 1.1 §2)
      if (obj.lab) ids.push(obj.lab.entry, ...(obj.lab.assets ?? []));
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
  if (lesson.coverAssetId) seen.add(lesson.coverAssetId);
  for (const page of lesson.pages) {
    for (const id of backgroundAssetIds(page.background)) seen.add(id);
    for (const obj of page.objects) {
      for (const id of objectAssetIds(obj)) seen.add(id);
    }
  }
  // Satellite pages (region-snip captures + their annotations) aren't part
  // of lesson.pages — walk them too, or a snip's capture/media reads as
  // unreferenced and can be evicted or dropped from export.
  for (const page of lesson.snipPages) {
    for (const id of backgroundAssetIds(page.background)) seen.add(id);
    for (const obj of page.objects) {
      for (const id of objectAssetIds(obj)) seen.add(id);
    }
  }
  return [...seen];
}

/**
 * Every page-background full-resolution render id in a lesson —
 * `renderedImageAssetId`, not the thumbnail or the raw PDF. These
 * resolve via the local media-cache independent of any configured API
 * (see `apps/web`'s `pdf-import.ts`'s `cacheFullResPageRenders`), unlike
 * other content-addressed ids which need `VITE_API_URL`. Used by the
 * missing-asset classifier so it doesn't over-warn on a page background
 * simply not having been viewed (hence warmed) yet — the normal case
 * now, not an exceptional one.
 */
export function pageRenderAssetIds(lesson: Lesson): string[] {
  const ids: string[] = [];
  for (const page of lesson.pages) {
    if (page.background.type === 'pdf_page' && page.background.renderedImageAssetId) {
      ids.push(page.background.renderedImageAssetId);
    }
  }
  return ids;
}

/**
 * Every page-background thumbnail id in a lesson — small, always meant to
 * stay inline. Used to build a thin bundle's `alwaysInline` set (see
 * `packages/format`'s `PackOptions.alwaysInline`) so the page-thumbnail
 * strip works instantly even when full-res renders externalize.
 */
export function pageThumbnailAssetIds(lesson: Lesson): string[] {
  const ids: string[] = [];
  for (const page of lesson.pages) {
    if (page.background.type === 'pdf_page' && page.background.thumbnailAssetId) {
      ids.push(page.background.thumbnailAssetId);
    }
  }
  return ids;
}

/**
 * Every content-addressed asset id an OVERLAY introduces, deduplicated —
 * the assets from its new pages and its per-page upserts/background
 * overrides. (Base assets are NOT included; they come from the base
 * bundle.) Used by the overlay packer to decide which bytes to carry.
 */
export function overlayReferencedAssetIds(overlay: Overlay): string[] {
  const seen = new Set<string>();
  for (const page of overlay.newPages) {
    for (const id of backgroundAssetIds(page.background)) seen.add(id);
    for (const obj of page.objects) for (const id of objectAssetIds(obj)) seen.add(id);
  }
  for (const edit of Object.values(overlay.pages)) {
    if (edit.background) for (const id of backgroundAssetIds(edit.background)) seen.add(id);
    for (const obj of edit.upsertedObjects ?? []) for (const id of objectAssetIds(obj)) seen.add(id);
  }
  return [...seen];
}
