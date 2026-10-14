import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { createLesson } from '@chalk-format/model';
import { packLesson, type AssetBundle } from './pack.js';
import { unpackLesson } from './unpack.js';
import { validateLessonPackage } from './validate.js';
import { CHALKBOOK_FORMAT, CHALKBOOK_VERSION, type Manifest } from './manifest.js';

function baseManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    format: CHALKBOOK_FORMAT,
    version: CHALKBOOK_VERSION,
    formatVersion: 1,
    id: 'lesson_1',
    title: 'T',
    locale: 'en',
    pages: [],
    assets: [],
    metadata: { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    ...overrides,
  };
}

async function zipWith(
  manifest: unknown,
  files: Record<string, string | Uint8Array> = {},
): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify(manifest));
  for (const [path, content] of Object.entries(files)) {
    zip.file(path, content);
  }
  return zip.generateAsync({ type: 'uint8array' });
}

describe('packLesson integrity', () => {
  it('throws when two asset ids collide after path escaping', async () => {
    // 'a:b' and 'a_b' both escape to assets/a_b — silently keeping one
    // would return wrong bytes for the other id on unpack.
    const bundle: AssetBundle = new Map([
      ['a:b', { type: 'application/octet-stream', bytes: new Uint8Array([1]) }],
      ['a_b', { type: 'application/octet-stream', bytes: new Uint8Array([2]) }],
    ]);
    await expect(packLesson(createLesson(), bundle)).rejects.toThrow(/collide|conflict/i);
  });
});

describe('unpackLesson integrity', () => {
  it('gives a clear error when manifest.metadata is missing (not a TypeError)', async () => {
    const manifest = baseManifest();
    delete (manifest as Partial<Manifest>).metadata;
    const bytes = await zipWith(manifest);
    await expect(unpackLesson(bytes)).rejects.toThrow(/metadata/);
  });

  it('reports manifest assets that have no bytes in the ZIP', async () => {
    const manifest = baseManifest({
      assets: [{ id: 'sha256:gone', type: 'image/png', path: 'assets/sha256_gone' }],
    });
    const bytes = await zipWith(manifest);
    const result = await unpackLesson(bytes);
    expect(result.missingAssetIds).toEqual(['sha256:gone']);
  });

  it('reports an empty missing list for a fat bundle', async () => {
    const bundle: AssetBundle = new Map([
      ['sha256:ok', { type: 'image/png', bytes: new Uint8Array([1, 2]) }],
    ]);
    const packed = await packLesson(createLesson(), bundle);
    const result = await unpackLesson(packed);
    expect(result.missingAssetIds).toEqual([]);
  });

  it('names the page file when its JSON is corrupt', async () => {
    const manifest = baseManifest({
      pages: [{ id: 'p1', file: 'pages/page-1.json' }],
    });
    const bytes = await zipWith(manifest, { 'pages/page-1.json': '{not json' });
    await expect(unpackLesson(bytes)).rejects.toThrow(/pages\/page-1\.json/);
  });

  it('rejects packages with more entries than the limit', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i++) files[`junk/${i}.txt`] = 'x';
    const bytes = await zipWith(baseManifest(), files);
    await expect(unpackLesson(bytes, { maxEntries: 5 })).rejects.toThrow(/entries/i);
  });

  it('rejects packages whose read bytes exceed the total-size limit', async () => {
    const big = new Uint8Array(2048);
    const manifest = baseManifest({
      assets: [{ id: 'sha256:big', type: 'application/octet-stream', path: 'assets/sha256_big' }],
    });
    const bytes = await zipWith(manifest, { 'assets/sha256_big': big });
    await expect(unpackLesson(bytes, { maxTotalBytes: 1024 })).rejects.toThrow(/size|bytes/i);
  });
});

describe('validateLessonPackage integrity', () => {
  it('flags a manifest without metadata', async () => {
    const manifest = baseManifest();
    delete (manifest as Partial<Manifest>).metadata;
    const result = await validateLessonPackage(await zipWith(manifest));
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.message.includes('metadata'))).toBe(true);
  });

  it('flags asset entries with unsafe paths', async () => {
    const manifest = baseManifest({
      assets: [{ id: 'a', type: 'image/png', path: '../escape.png' }],
    });
    const result = await validateLessonPackage(await zipWith(manifest));
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.message.includes('unsafe'))).toBe(true);
  });

  it('flags asset files missing from the ZIP', async () => {
    const manifest = baseManifest({
      assets: [{ id: 'a', type: 'image/png', path: 'assets/a.png' }],
    });
    const result = await validateLessonPackage(await zipWith(manifest));
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.message.includes('assets/a.png'))).toBe(true);
  });

  it('accepts a missing file for an external (thin) asset entry', async () => {
    const manifest = baseManifest({
      bundling: 'thin',
      assets: [{ id: 'a', type: 'image/png', path: 'assets/a.png', inline: false }],
    });
    const result = await validateLessonPackage(await zipWith(manifest));
    expect(result.ok).toBe(true);
    expect(result.issues.some((i) => i.message.includes('assets/a.png'))).toBe(false);
  });

  it('still flags a missing file for an inline asset entry (inline: true)', async () => {
    const manifest = baseManifest({
      assets: [{ id: 'a', type: 'image/png', path: 'assets/a.png', inline: true }],
    });
    const result = await validateLessonPackage(await zipWith(manifest));
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.message.includes('assets/a.png'))).toBe(true);
  });

  it('flags duplicate asset paths', async () => {
    const manifest = baseManifest({
      assets: [
        { id: 'a', type: 'image/png', path: 'assets/x.png' },
        { id: 'b', type: 'image/png', path: 'assets/x.png' },
      ],
    });
    const result = await validateLessonPackage(
      await zipWith(manifest, { 'assets/x.png': new Uint8Array([1]) }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.message.includes('duplicate'))).toBe(true);
  });

  it('flags malformed asset entries', async () => {
    const manifest = baseManifest({
      assets: [{ id: 'a' } as unknown as Manifest['assets'][number]],
    });
    const result = await validateLessonPackage(await zipWith(manifest));
    expect(result.ok).toBe(false);
  });

  it('rejects packages with more entries than the limit', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i++) files[`junk/${i}.txt`] = 'x';
    const bytes = await zipWith(baseManifest(), files);
    const result = await validateLessonPackage(bytes, { maxEntries: 5 });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => /entries/i.test(i.message))).toBe(true);
  });
});
