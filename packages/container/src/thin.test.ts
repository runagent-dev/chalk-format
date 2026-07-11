import { describe, it, expect } from 'vitest';
import { addObject, createLesson, type Lesson } from '@chalkbook/core';
import { packLesson, type AssetBundle } from './pack.js';
import { unpackLesson } from './unpack.js';
import { validateLessonPackage } from './validate.js';

/** A lesson with one image object referencing `assetId`. */
function lessonWithImage(assetId: string): Lesson {
  const lesson = createLesson('Thin Test');
  return addObject(lesson, lesson.pages[0]!.id, {
    id: 'img1',
    type: 'image',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    assetId,
  });
}

const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]); // PNG signature
const SHA_A = `sha256:${'a'.repeat(64)}`;
const SHA_CLOUD = `sha256:${'c'.repeat(64)}`;

describe('thin bundles', () => {
  it('defaults to fat — bytes are inlined and round-trip', async () => {
    const lesson = lessonWithImage(SHA_A);
    const bundle: AssetBundle = new Map([[SHA_A, { type: 'image/png', bytes: pngBytes }]]);
    const bytes = await packLesson(lesson, bundle);
    const out = await unpackLesson(bytes);
    expect(out.bundling).toBe('fat');
    expect(out.missingAssetIds).toEqual([]);
    expect(out.assets.get(SHA_A)?.bytes).toEqual(pngBytes);
  });

  it('thin mode externalizes a content-addressed asset (bytes omitted, listed as missing)', async () => {
    const lesson = lessonWithImage(SHA_A);
    const bundle: AssetBundle = new Map([[SHA_A, { type: 'image/png', bytes: pngBytes }]]);
    const fat = await packLesson(lesson, bundle, { mode: 'fat' });
    const thin = await packLesson(lesson, bundle, { mode: 'thin' });

    // The thin file is smaller — it dropped the asset bytes.
    expect(thin.byteLength).toBeLessThan(fat.byteLength);

    const out = await unpackLesson(thin);
    expect(out.bundling).toBe('thin');
    expect(out.assets.has(SHA_A)).toBe(false); // bytes not in the ZIP
    expect(out.missingAssetIds).toEqual([SHA_A]); // to be fetched by id
    // The lesson still references it, so a resolver can fetch it.
    expect(out.lesson.pages[0]!.objects[0]).toMatchObject({ assetId: SHA_A });
  });

  it('thin mode still inlines a NON-content-addressed asset (cannot be re-fetched)', async () => {
    // A non-sha256 id has no id-based fetch path, so thin must keep its bytes.
    const lesson = lessonWithImage('local-blob-42');
    const bundle: AssetBundle = new Map([['local-blob-42', { type: 'image/png', bytes: pngBytes }]]);
    const out = await unpackLesson(await packLesson(lesson, bundle, { mode: 'thin' }));

    expect(out.bundling).toBe('thin');
    expect(out.missingAssetIds).toEqual([]); // nothing dropped
    expect(out.assets.get('local-blob-42')?.bytes).toEqual(pngBytes);
  });

  it('thin mode with a mix externalizes only the content-addressed asset', async () => {
    const lesson = createLesson('Mixed');
    let l = addObject(lesson, lesson.pages[0]!.id, {
      id: 'i1', type: 'image', x: 0, y: 0, width: 10, height: 10, assetId: SHA_CLOUD,
    });
    l = addObject(l, l.pages[0]!.id, {
      id: 'i2', type: 'image', x: 20, y: 0, width: 10, height: 10, assetId: 'local-x',
    });
    const bundle: AssetBundle = new Map([
      [SHA_CLOUD, { type: 'image/png', bytes: pngBytes }],
      ['local-x', { type: 'image/png', bytes: pngBytes }],
    ]);
    const out = await unpackLesson(await packLesson(l, bundle, { mode: 'thin' }));
    expect(out.missingAssetIds).toEqual([SHA_CLOUD]);
    expect(out.assets.has('local-x')).toBe(true);
  });

  it('a packed thin bundle passes the public validator', async () => {
    const lesson = lessonWithImage(SHA_A);
    const bundle: AssetBundle = new Map([[SHA_A, { type: 'image/png', bytes: pngBytes }]]);
    const thin = await packLesson(lesson, bundle, { mode: 'thin' });
    const result = await validateLessonPackage(thin);
    expect(result.ok).toBe(true); // externalized bytes are not treated as damage
  });
});
