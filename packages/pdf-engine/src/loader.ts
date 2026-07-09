import { getDocument, type PDFDocumentProxy } from 'pdfjs-dist';
import { isPdfWorkerConfigured } from './worker.js';

/**
 * Opaque handle around a loaded PDF. Callers pass this to
 * `renderPdfPage`; they never poke at the PDF.js proxy directly so
 * the renderer can swap the underlying library later.
 */
export interface PdfDocument {
  readonly document: PDFDocumentProxy;
  readonly numPages: number;
}

/**
 * Load a PDF from raw bytes. Throws if the PDF.js worker hasn't been
 * configured via `configurePdfWorker` — a common first-run mistake
 * that's better to surface loudly than to silently hang.
 */
export async function loadPdf(bytes: Uint8Array): Promise<PdfDocument> {
  if (!isPdfWorkerConfigured()) {
    throw new Error(
      'pdfjs worker not configured — call configurePdfWorker(workerUrl) at app startup',
    );
  }
  // Copy the buffer so PDF.js's transferable-buffer contract doesn't
  // detach the caller's Uint8Array. Cheap for typical PDFs (a few MB)
  // and avoids a class of "why is my data gone" bugs.
  const owned = new Uint8Array(bytes);
  const task = getDocument({ data: owned });
  const document = await task.promise;
  return { document, numPages: document.numPages };
}

/**
 * Release the worker-side memory held by a loaded PDF. Callers must
 * invoke this when they are done rendering (typically in a `finally`);
 * otherwise every import leaks the fully parsed document in the PDF.js
 * worker for the lifetime of the tab.
 */
export async function closePdf(pdf: PdfDocument): Promise<void> {
  await pdf.document.destroy();
}
