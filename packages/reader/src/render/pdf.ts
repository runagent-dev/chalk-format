import type { Book } from '../book.js';

/**
 * Pages whose background is a PDF page without a rendered image (spec 1.0 §3.3: readers that can render PDF
 * MAY render it directly): drawn here with pdf.js, which loads only when such a page first appears. The host
 * says where pdf.js's worker is (`config.pdfWorkerSrc`), since that depends on its bundler.
 */
type Engine = typeof import('@chalk-format/pdf-engine');
let engine: Promise<Engine> | null = null;
const docs = new WeakMap<Book, Map<string, ReturnType<Engine['loadPdf']>>>();
const renders = new WeakMap<Book, Map<string, Promise<string | null>>>();

export function renderPdfPage(book: Book, assetId: string, pageNumber: number, width: number, workerSrc: string): Promise<string | null> {
  const key = `${assetId}#${pageNumber}@${width}`;
  let byBook = renders.get(book); if (!byBook) renders.set(book, (byBook = new Map()));
  const hit = byBook.get(key); if (hit) return hit;
  const p = (async () => {
    engine ??= import('@chalk-format/pdf-engine');
    const e = await engine;
    if (!e.isPdfWorkerConfigured()) e.configurePdfWorker(workerSrc);
    let d = docs.get(book); if (!d) docs.set(book, (d = new Map()));
    let doc = d.get(assetId);
    if (!doc) {
      const bytes = await book.assetBytes(assetId);
      if (!bytes) return null;
      doc = e.loadPdf(new Uint8Array(bytes.bytes));
      d.set(assetId, doc);
    }
    const page = await e.renderPdfPage(await doc, pageNumber, { targetWidth: width, format: 'png' });
    return URL.createObjectURL(new Blob([page.bytes as BlobPart], { type: page.type }));
  })().catch(() => null);
  byBook.set(key, p);
  return p;
}
