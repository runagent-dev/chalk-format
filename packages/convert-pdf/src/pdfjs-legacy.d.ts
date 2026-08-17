// Minimal typing for the Node-friendly legacy PDF.js build. Only the
// surface the Node rasterizer uses is declared.
declare module 'pdfjs-dist/legacy/build/pdf.mjs' {
  export const GlobalWorkerOptions: { workerSrc: string };

  export interface PdfTextContentItem {
    str: string;
    width: number;
    height: number;
    transform: number[];
  }

  export interface PdfPageProxy {
    getViewport(opts: { scale: number }): {
      width: number;
      height: number;
      transform: number[];
    };
    render(opts: unknown): { promise: Promise<void> };
    getTextContent(): Promise<{ items: PdfTextContentItem[] }>;
    cleanup(): void;
  }

  export interface PdfDocumentProxy {
    numPages: number;
    getPage(pageNumber: number): Promise<PdfPageProxy>;
    destroy(): Promise<void>;
  }

  export function getDocument(params: unknown): { promise: Promise<PdfDocumentProxy> };
}
