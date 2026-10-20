import { describe, expect, it } from 'vitest';
import { isLabEntryBytes, mediaKindOf, sniffMediaType } from './media-type.js';

const bytes = (...parts: (string | number[])[]): Uint8Array => {
  const out: number[] = [];
  for (const part of parts) {
    if (typeof part === 'string') out.push(...[...part].map((c) => c.charCodeAt(0)));
    else out.push(...part);
  }
  return new Uint8Array(out);
};

const pad = (n: number) => new Array(n).fill(0) as number[];
const iso = (brand: string) => bytes(pad(4), 'ftyp', brand, pad(16));

describe('sniffMediaType', () => {
  it('identifies images', () => {
    expect(sniffMediaType(bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(sniffMediaType(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffMediaType(bytes('GIF89a', pad(8)))).toBe('image/gif');
    expect(sniffMediaType(bytes('RIFF', pad(4), 'WEBP', pad(4)))).toBe('image/webp');
  });

  it('identifies video', () => {
    expect(sniffMediaType(iso('isom'))).toBe('video/mp4');
    expect(sniffMediaType(iso('mp42'))).toBe('video/mp4');
    // EBML header whose DocType says webm.
    expect(sniffMediaType(bytes([0x1a, 0x45, 0xdf, 0xa3], pad(20), 'webm', pad(8)))).toBe('video/webm');
  });

  it('identifies audio', () => {
    expect(sniffMediaType(bytes('ID3', pad(10)))).toBe('audio/mpeg');
    expect(sniffMediaType(bytes([0xff, 0xfb], pad(10)))).toBe('audio/mpeg'); // bare frame sync
    expect(sniffMediaType(bytes('OggS', pad(10)))).toBe('audio/ogg');
  });

  it('separates M4A audio from MP4 video, which share a container', () => {
    expect(mediaKindOf(sniffMediaType(iso('M4A '))!)).toBe('audio');
    expect(mediaKindOf(sniffMediaType(iso('isom'))!)).toBe('video');
  });

  it('reads AVIF as an image, not as video, despite the ftyp box', () => {
    expect(sniffMediaType(iso('avif'))).toBe('image/avif');
  });

  it('rejects containers browsers will not play', () => {
    // Matroska without a webm DocType is .mkv.
    expect(sniffMediaType(bytes([0x1a, 0x45, 0xdf, 0xa3], pad(40)))).toBeNull();
  });

  it('rejects anything unrecognised, including a truncated header', () => {
    expect(sniffMediaType(bytes('PK', [3, 4]))).toBeNull(); // zip
    expect(sniffMediaType(bytes('%PDF-1.7'))).toBeNull();
    expect(sniffMediaType(bytes('<html>'))).toBeNull();
    expect(sniffMediaType(new Uint8Array([0x89]))).toBeNull();
    expect(sniffMediaType(new Uint8Array())).toBeNull();
  });
});

describe('mediaKindOf', () => {
  it('groups the accepted types', () => {
    expect(mediaKindOf('image/png')).toBe('image');
    expect(mediaKindOf('video/webm')).toBe('video');
    expect(mediaKindOf('audio/ogg')).toBe('audio');
  });
});

describe('3D models', () => {
  it('identifies binary glTF and groups it as model3d', () => {
    const glb = new Uint8Array([...'glTF'].map((c) => c.charCodeAt(0)).concat([2, 0, 0, 0]));
    expect(sniffMediaType(glb)).toBe('model/gltf-binary');
    expect(mediaKindOf('model/gltf-binary')).toBe('model3d');
  });

  it('rejects text glTF and other model formats we cannot render', () => {
    // A .gltf JSON references external buffers; OBJ/STL have no materials.
    expect(sniffMediaType(new Uint8Array([...'{"asset":{'].map((c) => c.charCodeAt(0))))).toBeNull();
    expect(sniffMediaType(new Uint8Array([...'solid cube'].map((c) => c.charCodeAt(0))))).toBeNull();
  });
});

describe('lab entries (spec 1.1)', () => {
  it('are never accepted media: upload paths must not take HTML (stored XSS)', () => {
    expect(sniffMediaType(bytes('<!doctype html><script>alert(1)</script>'))).toBeNull();
    expect(sniffMediaType(bytes([0xef, 0xbb, 0xbf], '<html>'))).toBeNull();
  });

  it('are recognised by their own check: doctype or <html>, case-insensitively', () => {
    expect(isLabEntryBytes(bytes('<!doctype html><title>x</title>'))).toBe(true);
    expect(isLabEntryBytes(bytes('<!DOCTYPE HTML>\n<html>'))).toBe(true);
    expect(isLabEntryBytes(bytes('<html lang="bn">'))).toBe(true);
  });

  it('skip a UTF-8 BOM and leading whitespace', () => {
    expect(isLabEntryBytes(bytes([0xef, 0xbb, 0xbf], '\r\n  <!doctype html>'))).toBe(true);
  });

  it('do not take other markup, text or binary media for HTML', () => {
    expect(isLabEntryBytes(bytes('<?xml version="1.0"?><html>'))).toBe(false);
    expect(isLabEntryBytes(bytes('hello <html>'))).toBe(false);
    expect(isLabEntryBytes(bytes('<svg xmlns="http://www.w3.org/2000/svg">'))).toBe(false);
    expect(isLabEntryBytes(bytes('glTF', [2, 0, 0, 0], '<html>'))).toBe(false);
  });
});
