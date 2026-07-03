import type { PdfDocument } from './loader.js';

export interface RenderedPage {
  /** PNG bytes of the rendered page. */
  bytes: Uint8Array;
  /** MIME type — always `image/png` for now. */
  type: string;
  /** Rendered width in pixels. */
  width: number;
  /** Rendered height in pixels. */
  height: number;
  /** 1-indexed page number in the source PDF. */
  pageNumber: number;
}

export interface RenderOptions {
  /**
   * Target width in pixels. Scaled from the PDF's natural viewport so
   * text stays crisp at classroom-projector resolutions.
   * Default 1200 — a compromise between quality and file size.
   */
  targetWidth?: number;
}

/**
 * Render one page of a PDF to a PNG. Browser-only — uses an offscreen
 * canvas when available (worker-friendly) and falls back to a document
 * canvas otherwise.
 *
 * A future slice can add higher-resolution export, PDF-vector-preserved
 * rendering, and a lazy thumbnail path. The output type (`RenderedPage`)
 * is stable so downstream consumers don't churn.
 */
export async function renderPdfPage(
  pdf: PdfDocument,
  pageNumber: number,
  options: RenderOptions = {},
): Promise<RenderedPage> {
  if (pageNumber < 1 || pageNumber > pdf.numPages) {
    throw new Error(
      `page ${pageNumber} out of range 1..${pdf.numPages} for this PDF`,
    );
  }
  const targetWidth = options.targetWidth ?? 1200;

  const page = await pdf.document.getPage(pageNumber);
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = targetWidth / baseViewport.width;
  const viewport = page.getViewport({ scale });

  const width = Math.ceil(viewport.width);
  const height = Math.ceil(viewport.height);

  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('failed to acquire 2D canvas context for PDF render');
  }

  // PDF.js's render signature varies across versions. Cast keeps us
  // portable across a 4.x / 5.x bump without forking types.
  await page.render({
    canvas: canvas as unknown as HTMLCanvasElement,
    canvasContext: context,
    viewport,
  } as never).promise;

  const bytes = await canvasToPng(canvas);
  return { bytes, type: 'image/png', width, height, pageNumber };
}

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

function createCanvas(width: number, height: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(width, height);
  }
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

async function canvasToPng(canvas: AnyCanvas): Promise<Uint8Array> {
  if (canvas instanceof OffscreenCanvas) {
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return new Uint8Array(await blob.arrayBuffer());
  }
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/png');
  });
  if (!blob) throw new Error('canvas.toBlob returned null');
  return new Uint8Array(await blob.arrayBuffer());
}
