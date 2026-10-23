// The reference is load-bearing now that this file is imported across package
// boundaries: without it a consumer's program checks it against pdfjs-dist's
// real (browser-shaped) types instead of the local shim, and fails.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./pdfjs-legacy.d.ts" />
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import {
  getDocument,
  type PdfPageProxy,
  type PdfTextContentItem,
} from 'pdfjs-dist/legacy/build/pdf.mjs';
import { mapTextItemToRun } from '@chalk-format/pdf-engine/text-layer';
import { THUMBNAIL_QUALITY, THUMBNAIL_TARGET_WIDTH, resolveRenderFormat } from '@chalk-format/pdf-engine/renderer';
import type { RenderedPdfPage } from '@chalk-format/pdf-engine/staging';
import type { TextRun } from '@chalk-format/model';

// NOTE: @napi-rs/canvas MUST be pinned to the SAME version PDF.js depends on
// (^0.1.100). PDF.js renders vector paths as `ctx.fill(new Path2D(...))` and
// polyfills the Path2D/DOMMatrix/ImageData globals from ITS OWN bundled
// @napi-rs/canvas; if our `createCanvas` context is a different major, that
// context rejects PDF.js's Path2D with "Value is none of these types String,
// Path". Keeping one version across the dep tree avoids that mismatch.

type Matrix = [number, number, number, number, number, number];

/**
 * PDF.js needs a factory to create canvases in Node (it has no DOM). We
 * back it with @napi-rs/canvas — the same 2D API PDF.js expects.
 */
class NodeCanvasFactory {
  create(width: number, height: number) {
    const canvas = createCanvas(width, height);
    return { canvas, context: canvas.getContext('2d') };
  }
  reset(cc: { canvas: { width: number; height: number } }, width: number, height: number) {
    cc.canvas.width = width;
    cc.canvas.height = height;
  }
  destroy(cc: { canvas: { width: number; height: number } }) {
    cc.canvas.width = 0;
    cc.canvas.height = 0;
  }
}

/**
 * PDF.js ships standard fonts here, for PDFs that use the 14 standard fonts without embedding them. In Node,
 * pdf.js 5 reads them with fs.readFile(dir + name), so this is a plain directory path ending in a separator: a
 * file:// URL string is taken as a relative path, the font is not found and the glyphs are drawn wrong.
 */
function standardFontDataUrl(): string {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve('pdfjs-dist/package.json');
  return join(dirname(pkg), 'standard_fonts') + sep;
}

export interface NodeRenderOptions {
  targetWidth?: number;
  format?: 'webp' | 'png';
  quality?: number;
  onProgress?: (pageNumber: number, total: number) => void;
}

/**
 * Render every page of a PDF to an image + extracted text, in Node.
 * Mirrors the browser rasterizer's output (`RenderedPdfPage`) so both
 * feed the same `buildPdfLesson`; the text math (`mapTextItemToRun`) and
 * the encode policy (`resolveRenderFormat`) are the shared, tested code.
 */
export async function renderPdfToPages(
  pdfBytes: Uint8Array,
  options: NodeRenderOptions = {},
): Promise<RenderedPdfPage[]> {
  const targetWidth = options.targetWidth ?? 1200;
  const { mime, quality } = resolveRenderFormat({
    ...(options.format ? { format: options.format } : {}),
    ...(options.quality !== undefined ? { quality: options.quality } : {}),
  });

  // PDF.js takes ownership of (detaches) the buffer it is given. Hand it a
  // copy, as pdf-engine's browser loader does, so the caller's bytes survive
  // to be hashed and stored as the book's original PDF.
  const doc = await getDocument({
    data: new Uint8Array(pdfBytes),
    canvasFactory: new NodeCanvasFactory(),
    standardFontDataUrl: standardFontDataUrl(),
    isEvalSupported: false,
  }).promise;

  try {
    const pages: RenderedPdfPage[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      options.onProgress?.(n, doc.numPages);
      const page = await doc.getPage(n);
      try {
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: targetWidth / base.width });
        const width = Math.ceil(viewport.width);
        const height = Math.ceil(viewport.height);

        const factory = new NodeCanvasFactory();
        const { canvas, context } = factory.create(width, height);
        await page.render({ canvasContext: context, viewport, canvasFactory: factory }).promise;

        const bytes = new Uint8Array(
          mime === 'image/webp'
            ? await canvas.encode('webp', Math.round(quality * 100))
            : await canvas.encode('png'),
        );

        // Downscale the already-rendered canvas for the always-inlined
        // preview — no second PDF rasterization pass needed. Mirrors the
        // browser renderer's `renderThumbnail` (@chalk-format/pdf-engine/renderer).
        const thumbScale = THUMBNAIL_TARGET_WIDTH / width;
        const thumbWidth = Math.max(1, Math.round(width * thumbScale));
        const thumbHeight = Math.max(1, Math.round(height * thumbScale));
        const thumbCanvas = createCanvas(thumbWidth, thumbHeight);
        const thumbContext = thumbCanvas.getContext('2d');
        thumbContext.drawImage(canvas, 0, 0, thumbWidth, thumbHeight);
        const thumbnailBytes = new Uint8Array(
          await thumbCanvas.encode('webp', Math.round(THUMBNAIL_QUALITY * 100)),
        );

        pages.push({
          pageNumber: n,
          bytes,
          mime,
          width,
          height,
          textLayer: await extractText(page, viewport.transform as Matrix),
          thumbnailBytes,
          thumbnailMime: 'image/webp',
        });
      } finally {
        page.cleanup();
      }
    }
    return pages;
  } finally {
    await doc.destroy();
  }
}

/** Extract the page's text runs in the render's pixel space. */
async function extractText(page: PdfPageProxy, transform: Matrix): Promise<TextRun[]> {
  const content = await page.getTextContent();
  const runs: TextRun[] = [];
  for (const item of content.items) {
    if (typeof item.str === 'string' && item.str.trim().length > 0) {
      runs.push(mapTextItemToRun(item as PdfTextContentItem, transform));
    }
  }
  return runs;
}
