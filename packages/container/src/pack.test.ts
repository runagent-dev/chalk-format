import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { createLesson, type Lesson } from '@chalk-format/model';
import { packLesson } from './pack.js';
import { unpackLesson } from './unpack.js';
import { validateLessonPackage } from './validate.js';
import type { Manifest } from './manifest.js';

function withImage(assetId: string): Lesson {
  const b = createLesson('Has media');
  return {
    ...b,
    pages: [
      {
        ...b.pages[0]!,
        objects: [{ id: 'im', x: 0, y: 0, type: 'image', assetId, width: 100, height: 80 }],
      },
    ],
  };
}

describe('packLesson: cloud (unbundled) refs', () => {
  it('records a referenced content-addressed asset with no bytes as external', async () => {
    const id = 'sha256:' + 'a'.repeat(64);
    const chalk = await packLesson(withImage(id), new Map());
    const zip = await JSZip.loadAsync(chalk);
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string')) as Manifest;
    const entry = manifest.assets.find((a) => a.id === id);
    expect(entry).toBeDefined();
    expect(entry!.inline).toBe(false);
    expect(zip.file(entry!.path)).toBeNull();
    expect((await validateLessonPackage(chalk)).ok).toBe(true);
    const unpacked = await unpackLesson(chalk);
    expect(unpacked.missingAssetIds).toContain(id); // caller resolves from asset service
  });
  it('ignores non-content-addressed missing ids', async () => {
    const chalk = await packLesson(withImage('local-1'), new Map());
    const zip = await JSZip.loadAsync(chalk);
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string')) as Manifest;
    expect(manifest.assets.find((a) => a.id === 'local-1')).toBeUndefined();
  });
});
