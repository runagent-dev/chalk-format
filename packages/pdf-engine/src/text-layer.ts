import type { TextRun } from '@chalk-format/model';
import type { PdfDocument } from './loader.js';

type Matrix = [number, number, number, number, number, number];

/** Minimal shape of a PDF.js text-content item we consume. */
export interface PdfTextItem {
  str: string;
  width: number;
  height: number;
  transform: number[];
}

/** 2D affine matrix multiply (PDF.js `Util.transform`), m1 · m2. */
function multiply(m1: Matrix, m2: number[]): Matrix {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const a2 = m2[0]!, b2 = m2[1]!, c2 = m2[2]!, d2 = m2[3]!, e2 = m2[4]!, f2 = m2[5]!;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

/**
 * Map a PDF.js text item into a page-coordinate `TextRun`. `viewportTransform`
 * is the render viewport's transform, so the result lands in the SAME
 * pixel space as the rendered raster background — the text layer overlays
 * the image exactly (the coordinate-fidelity rule).
 *
 * The item's baseline is at (t[4], t[5]); we report the box top as
 * baseline − fontSize. Font size and width come from the combined
 * transform's scale, so they track the render scale.
 */
export function mapTextItemToRun(item: PdfTextItem, viewportTransform: Matrix): TextRun {
  const t = multiply(viewportTransform, item.transform);
  const fontSize = Math.hypot(t[2], t[3]);
  const xScale = Math.hypot(viewportTransform[0], viewportTransform[1]);
  return {
    text: item.str,
    x: t[4],
    y: t[5] - fontSize,
    width: item.width * xScale,
    fontSize,
  };
}

/**
 * Extract the searchable text layer for a page, positioned in the same
 * pixel space as `renderPdfPage` at the same `targetWidth`. Browser glue
 * around PDF.js `getTextContent`; the coordinate math is `mapTextItemToRun`.
 */
export async function extractPageText(
  pdf: PdfDocument,
  pageNumber: number,
  targetWidth = 1200,
): Promise<TextRun[]> {
  const page = await pdf.document.getPage(pageNumber);
  try {
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: targetWidth / base.width });
    const content = await page.getTextContent();
    const transform = viewport.transform as Matrix;
    const runs: TextRun[] = [];
    for (const item of content.items as PdfTextItem[]) {
      if (typeof item.str !== 'string' || item.str.trim().length === 0) continue;
      runs.push(mapTextItemToRun(item, transform));
    }
    return runs;
  } finally {
    page.cleanup();
  }
}
