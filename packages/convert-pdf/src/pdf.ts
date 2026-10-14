import { createLesson } from '@chalk-format/model';
import { buildPdfLesson } from '@chalk-format/pdf-engine/staging';
import { packLesson } from '@chalk-format/container';
import { renderPdfToPages } from './node-pdf.js';
import type { ConvertOptions, ConvertResult, SourceConverter } from './registry.js';


/** Language tag: 2–3 letter primary subtag, optional subtags (BCP 47, simplified). */
const BCP47 = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
/**
 * Convert a PDF into a `.chalk` document: render every page (Node
 * rasterizer), extract its text layer, build the lesson model (shared
 * with the browser import), and pack it. The result validates against
 * the format schema because `packLesson` enforces it.
 */
export async function convertPdf(
  pdfBytes: Uint8Array,
  options: ConvertOptions = {},
): Promise<ConvertResult> {
  const title = options.title?.trim() || 'Untitled document';
  const locale = options.locale ?? 'en';
  if (!BCP47.test(locale)) throw new Error(`invalid locale "${locale}": expected a BCP 47 tag such as "bn" or "en"`);
  const rendered = await renderPdfToPages(pdfBytes, {
    ...(options.targetWidth !== undefined ? { targetWidth: options.targetWidth } : {}),
    ...(options.format ? { format: options.format } : {}),
    ...(options.quality !== undefined ? { quality: options.quality } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });
  const staged = await buildPdfLesson(pdfBytes, rendered, { title });
  const lesson = { ...createLesson(title), locale, pages: staged.pages };

  // The first page's rendered raster is the cover. Returned alongside the
  // bundle so a caller never has to re-open the ZIP to find one.
  const first = staged.pages[0]?.background;
  const coverId = first?.type === 'pdf_page' ? first.renderedImageAssetId ?? null : null;
  const coverPayload = coverId ? staged.assets.get(coverId) : undefined;

  return {
    chalk: await packLesson(lesson, staged.assets, {
      metadata: {
        ...(options.author ? { author: options.author } : {}),
        ...(options.license ? { license: options.license } : {}),
      },
    }),
    title,
    pageCount: staged.pages.length,
    cover: coverPayload ? { bytes: coverPayload.bytes, type: coverPayload.type } : null,
  };
}

export const pdfConverter: SourceConverter = {
  format: 'pdf',
  mimeTypes: new Set(['application/pdf']),
  convert: convertPdf,
};

/** Back-compat shape for the CLI: bytes in, packed bytes out. */
export async function convertPdfToChalk(
  pdfBytes: Uint8Array,
  title: string,
  options: Omit<ConvertOptions, 'title'> = {},
): Promise<Uint8Array> {
  return (await convertPdf(pdfBytes, { ...options, title })).chalk;
}
