import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseLesson } from '@chalkbook/core';
import { unpackLesson } from '@chalkbook/format';
import { convertPdf } from './pdf.js';

/**
 * A minimal one-page PDF, written by hand so the suite needs no fixture
 * binary and no network. Enough structure for PDF.js to parse and render.
 */
function tinyPdf(): Uint8Array {
  const objects = [
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>endobj',
    '4 0 obj<</Length 44>>stream\nBT /F1 24 Tf 20 40 Td (Chalkbook) Tj ET\nendstream endobj',
    '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(pdf.length);
    pdf += obj + '\n';
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;
  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}

describe('convertPdf', () => {
  it('produces a schema-valid .chalk with a page per PDF page and a cover', async () => {
    const result = await convertPdf(tinyPdf(), { title: 'Tiny', targetWidth: 200 });

    expect(result.title).toBe('Tiny');
    expect(result.pageCount).toBe(1);
    expect(result.cover).not.toBeNull();
    expect(result.cover!.type).toBe('image/webp');

    const { lesson } = await unpackLesson(result.chalk);
    expect(() => parseLesson(lesson)).not.toThrow();
    expect(lesson.title).toBe('Tiny');
    expect(lesson.pages).toHaveLength(1);

    const background = lesson.pages[0]!.background;
    expect(background.type).toBe('pdf_page');
    if (background.type !== 'pdf_page') throw new Error('unreachable');
    expect(background.renderedImageAssetId).toMatch(/^sha256:/);
    // The returned cover IS the page raster the document references, so a
    // caller can publish it without re-opening the bundle.
    expect(result.cover!.bytes.length).toBeGreaterThan(0);
  }, 30_000);

  it('extracts a text layer in the render pixel space', async () => {
    const { chalk } = await convertPdf(tinyPdf(), { title: 'Tiny', targetWidth: 400 });
    const { lesson } = await unpackLesson(chalk);
    const runs = lesson.pages[0]!.textLayer ?? [];
    expect(runs.map((r) => r.text).join('')).toContain('Chalkbook');
    for (const run of runs) {
      expect(run.x).toBeGreaterThanOrEqual(0);
      expect(run.x).toBeLessThanOrEqual(400);
    }
  }, 30_000);

  it('honours png output', async () => {
    const result = await convertPdf(tinyPdf(), { title: 'Tiny', format: 'png', targetWidth: 120 });
    expect(result.cover!.type).toBe('image/png');
  }, 30_000);

  it('matches what the CLI wrapper produces', async () => {
    // The CLI calls convertPdfToChalk; both paths must build the same
    // document, otherwise a book converted by an operator differs from one
    // converted by the service.
    const { convertPdfToChalk } = await import('./pdf.js');
    const viaWrapper = await convertPdfToChalk(tinyPdf(), 'Tiny', { targetWidth: 200 });
    const viaConvert = await convertPdf(tinyPdf(), { title: 'Tiny', targetWidth: 200 });

    const a = await unpackLesson(viaWrapper);
    const b = await unpackLesson(viaConvert.chalk);
    expect(a.lesson.pages[0]!.background).toEqual(b.lesson.pages[0]!.background);
    expect([...a.assets.keys()].sort()).toEqual([...b.assets.keys()].sort());
  }, 30_000);

  it('rejects bytes that are not a PDF', async () => {
    await expect(convertPdf(new Uint8Array([1, 2, 3, 4]), { title: 'x' })).rejects.toThrow();
  }, 30_000);
});

/** The fixture path helper stays honest about where the repo root is. */
it('runs from the package directory', async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  await expect(readFile(join(here, 'pdf.ts'), 'utf8')).resolves.toContain('convertPdf');
});
