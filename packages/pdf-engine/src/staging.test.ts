import { describe, expect, it } from 'vitest';
import { buildPdfLesson, type RenderedPdfPage } from './staging.js';

const pdfBytes = new Uint8Array([37, 80, 68, 70]); // "%PDF"

function rendered(): RenderedPdfPage[] {
  return [
    {
      pageNumber: 1,
      bytes: new Uint8Array([1, 2, 3]),
      mime: 'image/webp',
      width: 1200,
      height: 1553,
      textLayer: [{ text: 'Hi', x: 1, y: 2, width: 10, fontSize: 12 }],
      thumbnailBytes: new Uint8Array([11, 12]),
      thumbnailMime: 'image/webp',
    },
    {
      pageNumber: 2,
      bytes: new Uint8Array([4, 5, 6]),
      mime: 'image/webp',
      width: 1200,
      height: 1553,
      textLayer: [],
      thumbnailBytes: new Uint8Array([13, 14]),
      thumbnailMime: 'image/webp',
    },
  ];
}

describe('buildPdfLesson', () => {
  it('stores the original PDF plus one render and one thumbnail per page (content-addressed)', async () => {
    const staged = await buildPdfLesson(pdfBytes, rendered(), { title: 'Book' });
    expect(staged.assets.size).toBe(5); // pdf + 2 renders + 2 thumbnails
    const bg = staged.pages[0]!.background;
    if (bg.type !== 'pdf_page') throw new Error('expected pdf_page');
    expect(bg.assetId).toMatch(/^sha256:/);
    expect(bg.renderedImageAssetId).toMatch(/^sha256:/);
    expect(bg.thumbnailAssetId).toMatch(/^sha256:/);
    // Distinct assets — the thumbnail is not just an alias for the render.
    expect(bg.thumbnailAssetId).not.toBe(bg.renderedImageAssetId);
    expect(staged.assets.has(bg.assetId)).toBe(true);
    expect(staged.assets.has(bg.renderedImageAssetId!)).toBe(true);
    expect(staged.assets.has(bg.thumbnailAssetId!)).toBe(true);
  });

  it('builds one page per render with dims and the pdf_page background', async () => {
    const staged = await buildPdfLesson(pdfBytes, rendered(), { title: 'Book' });
    expect(staged.pages).toHaveLength(2);
    expect(staged.pages[0]!.width).toBe(1200);
    expect(staged.pages[0]!.height).toBe(1553);
    const bg = staged.pages[1]!.background;
    if (bg.type !== 'pdf_page') throw new Error('expected pdf_page');
    expect(bg.pageNumber).toBe(2);
  });

  it('attaches a non-empty textLayer and omits an empty one', async () => {
    const staged = await buildPdfLesson(pdfBytes, rendered(), { title: 'Book' });
    expect(staged.pages[0]!.textLayer).toEqual(rendered()[0]!.textLayer);
    expect(staged.pages[1]!.textLayer).toBeUndefined();
  });

  it('dedups the shared PDF asset across pages', async () => {
    const staged = await buildPdfLesson(pdfBytes, rendered(), { title: 'Book' });
    const a = staged.pages[0]!.background;
    const b = staged.pages[1]!.background;
    if (a.type !== 'pdf_page' || b.type !== 'pdf_page') throw new Error('expected pdf_page');
    expect(a.assetId).toBe(b.assetId);
  });

  it('produces a lesson that validates against the format', async () => {
    const { parseLesson, createLesson } = await import('@chalkbook/core');
    const staged = await buildPdfLesson(pdfBytes, rendered(), { title: 'Book' });
    const lesson = { ...createLesson('Book'), pages: staged.pages };
    expect(() => parseLesson(lesson)).not.toThrow();
  });
});
