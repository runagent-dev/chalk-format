import { describe, it, expect } from 'vitest';
import {
  composeOverlay,
  diffLesson,
  createLesson,
  addObject,
  type Lesson,
  type LessonObject,
  type OverlayBaseRef,
} from '@chalk-format/model';
import { packOverlay, unpackOverlay } from './overlay-pack.js';
import { packLesson, type AssetBundle } from './pack.js';
import { unpackLesson } from './unpack.js';

const REF: OverlayBaseRef = { id: 'physics', version: 3 };
const SHA = `sha256:${'a'.repeat(64)}`;
const png = new Uint8Array([137, 80, 78, 71]);

function image(id: string, assetId: string): LessonObject {
  return { id, type: 'image', x: 0, y: 0, width: 10, height: 10, assetId };
}

/** A base lesson + a user edit that adds an annotation image referencing SHA. */
function baseAndEdit(): { base: Lesson; edited: Lesson } {
  const base = createLesson('Physics');
  const pageId = base.pages[0]!.id;
  const edited = addObject(base, pageId, image('img1', SHA));
  return { base, edited };
}

describe('packOverlay / unpackOverlay', () => {
  it('round-trips an overlay through pack → unpack', async () => {
    const { base, edited } = baseAndEdit();
    const overlay = diffLesson(base, edited, REF);
    const bytes = await packOverlay(overlay);
    const out = await unpackOverlay(bytes);
    expect(out.overlay).toEqual(overlay);
    expect(out.overlay.base).toEqual(REF);
  });

  it('carries only the assets the overlay introduces (not base assets)', async () => {
    const { base, edited } = baseAndEdit();
    const overlay = diffLesson(base, edited, REF);
    const bundle: AssetBundle = new Map([
      [SHA, { type: 'image/png', bytes: png }],
      [`sha256:${'b'.repeat(64)}`, { type: 'image/png', bytes: png }], // unrelated → dropped
    ]);
    const out = await unpackOverlay(await packOverlay(overlay, bundle));
    expect([...out.assets.keys()]).toEqual([SHA]);
    expect(out.assets.get(SHA)!.bytes).toEqual(png);
  });

  it('thin mode externalizes the content-addressed asset (→ missingAssetIds)', async () => {
    const { base, edited } = baseAndEdit();
    const overlay = diffLesson(base, edited, REF);
    const bundle: AssetBundle = new Map([[SHA, { type: 'image/png', bytes: png }]]);
    const fat = await packOverlay(overlay, bundle, { mode: 'fat' });
    const thin = await packOverlay(overlay, bundle, { mode: 'thin' });
    expect(thin.byteLength).toBeLessThan(fat.byteLength);
    const out = await unpackOverlay(thin);
    expect(out.assets.has(SHA)).toBe(false);
    expect(out.missingAssetIds).toEqual([SHA]);
  });

  it('rejects a lesson bundle passed to unpackOverlay', async () => {
    const lessonBytes = await packLesson(createLesson('Not an overlay'));
    await expect(unpackOverlay(lessonBytes)).rejects.toThrow(/not an overlay/i);
  });

  it('rejects an overlay bundle passed to unpackLesson', async () => {
    const overlay = diffLesson(...Object.values(baseAndEdit()) as [Lesson, Lesson], REF);
    const overlayBytes = await packOverlay(overlay);
    // unpackLesson expects a lesson manifest (pages) — an overlay manifest has none.
    await expect(unpackLesson(overlayBytes)).rejects.toThrow();
  });

  it('end-to-end: base bundle + overlay bundle compose to the edited lesson', async () => {
    const { base, edited } = baseAndEdit();
    const overlay = diffLesson(base, edited, REF);

    // Ship the base fat and the overlay with its new asset.
    const baseBytes = await packLesson(base);
    const overlayBytes = await packOverlay(overlay, new Map([[SHA, { type: 'image/png', bytes: png }]]));

    // Receiver side: unpack both, compose.
    const baseOut = await unpackLesson(baseBytes);
    const overlayOut = await unpackOverlay(overlayBytes);
    const reconstructed = composeOverlay(baseOut.lesson, overlayOut.overlay);

    expect(reconstructed).toEqual(edited);
    // The overlay carried the new annotation's asset; base didn't have it.
    expect(baseOut.assets.has(SHA)).toBe(false);
    expect(overlayOut.assets.has(SHA)).toBe(true);
  });
});
