import { describe, expect, it } from 'vitest';
import {
  ConverterRegistry,
  sniffSourceFormat,
  titleFromFilename,
  type SourceConverter,
} from './registry.js';

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // "%PDF-1.7"

const fake: SourceConverter = {
  format: 'pdf',
  mimeTypes: new Set(['application/pdf']),
  convert: async () => ({ chalk: new Uint8Array(), title: 't', pageCount: 0, cover: null }),
};

describe('sniffSourceFormat', () => {
  it('recognises a PDF by its magic bytes', () => {
    expect(sniffSourceFormat(PDF)).toBe('pdf');
  });
  it('returns null for anything else, including a truncated header', () => {
    expect(sniffSourceFormat(new Uint8Array([0x50, 0x4b, 3, 4]))).toBeNull(); // zip
    expect(sniffSourceFormat(new Uint8Array([0x25, 0x50]))).toBeNull();
    expect(sniffSourceFormat(new Uint8Array())).toBeNull();
  });
});

describe('ConverterRegistry', () => {
  it('dispatches on the bytes, not on a claimed type', () => {
    const registry = new ConverterRegistry([fake]);
    expect(registry.forBytes(PDF)).toBe(fake);
    expect(registry.forBytes(new Uint8Array([1, 2, 3, 4]))).toBeNull();
    expect(registry.formats()).toEqual(['pdf']);
  });
});

describe('titleFromFilename', () => {
  it('drops the extension and turns underscores into spaces', () => {
    expect(titleFromFilename('Department_of_Oceanography.pdf')).toBe('Department of Oceanography');
    expect(titleFromFilename('physics.PDF')).toBe('physics');
  });
  it('keeps hyphens, which are usually deliberate', () => {
    expect(titleFromFilename('physics-9-10.pdf')).toBe('physics-9-10');
  });
  it('collapses runs of separators and never returns empty', () => {
    expect(titleFromFilename('a__b  c.pdf')).toBe('a b c');
    expect(titleFromFilename('.pdf')).toBe('.pdf');
  });
});
