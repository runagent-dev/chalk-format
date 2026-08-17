export {
  ConverterRegistry,
  sniffSourceFormat,
  titleFromFilename,
  type ConvertOptions,
  type ConvertResult,
  type SourceConverter,
  type SourceFormat,
} from './registry.js';
export { convertPdf, convertPdfToChalk, pdfConverter } from './pdf.js';
export { renderPdfToPages, type NodeRenderOptions } from './node-pdf.js';

import { ConverterRegistry } from './registry.js';
import { pdfConverter } from './pdf.js';

/** Every format the service can convert today. */
export const defaultRegistry = new ConverterRegistry([pdfConverter]);
