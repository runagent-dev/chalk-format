import { GlobalWorkerOptions } from 'pdfjs-dist';

let configured = false;

/**
 * PDF.js needs its worker script served from somewhere the browser can
 * fetch. The URL depends on the bundler, so consumers configure it
 * once at startup.
 *
 * With Vite:
 *   import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
 *   configurePdfWorker(workerUrl);
 *
 * Without configuration, `loadPdf` will throw the first time it runs.
 */
export function configurePdfWorker(workerSrc: string): void {
  GlobalWorkerOptions.workerSrc = workerSrc;
  configured = true;
}

export function isPdfWorkerConfigured(): boolean {
  return configured;
}
