export { configurePdfWorker, isPdfWorkerConfigured } from './worker.js';
export { loadPdf, type PdfDocument } from './loader.js';
export {
  renderPdfPage,
  type RenderedPage,
  type RenderOptions,
} from './renderer.js';

export const PDF_ENGINE_VERSION = '0.1.0';
