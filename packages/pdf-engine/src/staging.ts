import { generateId, hashBytes, type LessonPage, type TextRun } from '@chalkbook/core';

/**
 * A page already rendered to an image + its extracted text. Produced by
 * a platform-specific rasterizer (the browser one in apps/web, the Node
 * one in the content CLI) and fed into `buildPdfLesson`, which is shared.
 */
export interface RenderedPdfPage {
  pageNumber: number;
  bytes: Uint8Array;
  mime: string;
  width: number;
  height: number;
  textLayer: TextRun[];
  /** A small always-inlined preview render, distinct from `bytes` — the
   *  full-resolution render, which is resolved lazily and may not be
   *  locally resident. */
  thumbnailBytes: Uint8Array;
  thumbnailMime: string;
}

export interface StagedPdf {
  title: string;
  pages: LessonPage[];
  assets: Map<string, { type: string; bytes: Uint8Array }>;
}

export interface BuildPdfLessonOptions {
  title: string;
}

/**
 * Turn a PDF's bytes and its rendered pages into lesson pages + a
 * content-addressed asset bundle — the "PDF-page-to-lesson-page mapping"
 * this package owns. Shared by the browser import and the Node CLI so
 * both produce identical documents; only the rasterizer differs.
 *
 * Coordinates: the logical page size is the render's pixel size, and the
 * text layer is extracted in that same space, so annotations, raster,
 * and text all register 1:1.
 */
export async function buildPdfLesson(
  pdfBytes: Uint8Array,
  rendered: RenderedPdfPage[],
  options: BuildPdfLessonOptions,
): Promise<StagedPdf> {
  const pdfAssetId = await hashBytes(pdfBytes);
  const assets = new Map<string, { type: string; bytes: Uint8Array }>();
  assets.set(pdfAssetId, { type: 'application/pdf', bytes: pdfBytes });

  const pages: LessonPage[] = [];
  for (const page of rendered) {
    const renderId = await hashBytes(page.bytes);
    assets.set(renderId, { type: page.mime, bytes: page.bytes });
    const thumbnailId = await hashBytes(page.thumbnailBytes);
    assets.set(thumbnailId, { type: page.thumbnailMime, bytes: page.thumbnailBytes });
    pages.push({
      id: generateId('page'),
      title: `${options.title} — page ${page.pageNumber}`,
      background: {
        type: 'pdf_page',
        assetId: pdfAssetId,
        pageNumber: page.pageNumber,
        renderedImageAssetId: renderId,
        thumbnailAssetId: thumbnailId,
      },
      objects: [],
      width: page.width,
      height: page.height,
      ...(page.textLayer.length > 0 ? { textLayer: page.textLayer } : {}),
    });
  }

  return { title: options.title, pages, assets };
}
