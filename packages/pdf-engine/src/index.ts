export { configurePdfWorker, isPdfWorkerConfigured } from './worker.js';
export { loadPdf, closePdf, type PdfDocument } from './loader.js';
export {
  renderPdfPage,
  resolveRenderFormat,
  type RenderedPage,
  type RenderOptions,
  type RenderImageFormat,
} from './renderer.js';
export {
  extractPageText,
  mapTextItemToRun,
  type PdfTextItem,
} from './text-layer.js';
export {
  buildPdfLesson,
  type RenderedPdfPage,
  type StagedPdf,
  type BuildPdfLessonOptions,
} from './staging.js';

export const PDF_ENGINE_VERSION = '0.1.0';
