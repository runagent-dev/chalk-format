import { createLesson } from '@chalkbook/core';
import { buildPdfLesson } from '@chalkbook/pdf-engine/staging';
import { packLesson } from '@chalkbook/format';
import { renderPdfToPages, type NodeRenderOptions } from './node-pdf.js';

/**
 * Convert a PDF into a `.chalk` document: render every page (Node
 * rasterizer), extract its text layer, build the lesson model (shared
 * with the browser import), and pack it. The result validates against
 * the format schema because `packLesson` enforces it.
 */
export async function convertPdfToChalk(
  pdfBytes: Uint8Array,
  title: string,
  options: NodeRenderOptions = {},
): Promise<Uint8Array> {
  const rendered = await renderPdfToPages(pdfBytes, options);
  const staged = await buildPdfLesson(pdfBytes, rendered, { title });
  const lesson = { ...createLesson(title), pages: staged.pages };
  return packLesson(lesson, staged.assets);
}
