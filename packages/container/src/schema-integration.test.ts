import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { CHALK_FORMAT_VERSION, addObject, createLesson, type Lesson } from '@chalk-format/model';
import { packLesson } from './pack.js';
import { unpackLesson } from './unpack.js';
import { CHALKBOOK_FORMAT, CHALKBOOK_VERSION } from './manifest.js';

/** Build a raw .chalk zip from an arbitrary manifest + page files. */
async function zipWith(
  manifest: unknown,
  pages: Record<string, unknown> = {},
): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify(manifest));
  for (const [path, data] of Object.entries(pages)) {
    zip.file(path, JSON.stringify(data));
  }
  return zip.generateAsync({ type: 'uint8array' });
}

function fullLesson(): Lesson {
  let lesson = createLesson('Full');
  const pid = lesson.pages[0]!.id;
  lesson = addObject(lesson, pid, {
    id: 'r1', x: 1, y: 2, type: 'rect', width: 3, height: 4, fill: '#f00', stroke: '#000', strokeWidth: 1,
  });
  lesson = addObject(lesson, pid, {
    id: 'i1', x: 0, y: 0, type: 'ink', points: [0, 0, 10, 10], color: '#111', size: 4,
  });
  lesson = addObject(lesson, pid, {
    id: 't1', x: 5, y: 6, type: 'text', text: 'hi', fontSize: 20, fill: '#000',
  });
  lesson = { ...lesson, pages: [{ ...lesson.pages[0]!, width: 1200, height: 1553 }] };
  return lesson;
}

describe('encode validates against the schema', () => {
  it('packLesson refuses an invalid lesson model', async () => {
    await expect(packLesson({ id: 'x' } as unknown as Lesson)).rejects.toThrow(/invalid lesson/i);
  });

  it('packLesson writes the current formatVersion into the manifest', async () => {
    const bytes = await packLesson(createLesson('V'));
    const zip = await JSZip.loadAsync(bytes);
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    expect(manifest.formatVersion).toBe(CHALK_FORMAT_VERSION);
  });

  it('round-trips every rich item type (v3)', async () => {
    const base = createLesson('Rich');
    const objects = [
      { id: 'im', x: 1, y: 2, type: 'image' as const, assetId: 'sha256:i', width: 100, height: 80 },
      { id: 'e', x: 0, y: 0, type: 'ellipse' as const, width: 40, height: 20, fill: '#f00', stroke: '#000', strokeWidth: 2 },
      { id: 'l', x: 0, y: 0, type: 'line' as const, x2: 30, y2: 40, stroke: '#000', strokeWidth: 2 },
      { id: 'a', x: 0, y: 0, type: 'arrow' as const, x2: 30, y2: 40, stroke: '#00f', strokeWidth: 3 },
      { id: 'v', x: 5, y: 5, type: 'vector' as const, path: 'M0 0 L10 10', stroke: '#111' },
      { id: 'em', x: 0, y: 0, type: 'embed' as const, embed: 'model3d' as const, width: 200, height: 200, assetId: 'sha256:m', poster: 'sha256:p' },
    ];
    const lesson = { ...base, pages: [{ ...base.pages[0]!, objects }] };
    const { lesson: restored } = await unpackLesson(await packLesson(lesson));
    expect(restored.pages[0]!.objects).toEqual(objects);
  });

  it('round-trips a page textLayer', async () => {
    const base = createLesson('WithText');
    const lesson = {
      ...base,
      pages: [
        {
          ...base.pages[0]!,
          textLayer: [{ text: 'Volcano', x: 12, y: 30, width: 90, fontSize: 18 }],
        },
      ],
    };
    const { lesson: restored } = await unpackLesson(await packLesson(lesson));
    expect(restored.pages[0]!.textLayer).toEqual(lesson.pages[0]!.textLayer);
  });
});

describe('decode validates through the schema (no more `as` cast)', () => {
  it('rejects a page whose object violates the model', async () => {
    const manifest = {
      format: CHALKBOOK_FORMAT,
      version: CHALKBOOK_VERSION,
      formatVersion: 1,
      id: 'l',
      title: 'T',
      locale: 'en',
      pages: [{ id: 'p', file: 'pages/page-1.json' }],
      assets: [],
      metadata: { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    };
    const bytes = await zipWith(manifest, {
      'pages/page-1.json': {
        id: 'p', title: 't', background: { type: 'blank' },
        objects: [{ id: 'o', x: 0, y: 0, type: 'triangle' }],
      },
    });
    await expect(unpackLesson(bytes)).rejects.toThrow();
  });

  it('round-trips every object type and page dimensions', async () => {
    const original = fullLesson();
    const { lesson } = await unpackLesson(await packLesson(original));
    expect(lesson.pages[0]!.objects).toEqual(original.pages[0]!.objects);
    expect(lesson.pages[0]!.width).toBe(1200);
    expect(lesson.pages[0]!.height).toBe(1553);
  });
});

describe('versioning / backward compatibility', () => {
  it('treats a manifest without formatVersion as v1 and decodes it', async () => {
    // Simulates a .chalk written before the formatVersion field existed.
    const manifest = {
      format: CHALKBOOK_FORMAT,
      version: '0.1.0',
      id: 'l',
      title: 'Legacy',
      locale: 'en',
      pages: [{ id: 'p', file: 'pages/page-1.json' }],
      assets: [],
      metadata: { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    };
    const bytes = await zipWith(manifest, {
      'pages/page-1.json': { id: 'p', title: 'Page 1', background: { type: 'blank' }, objects: [] },
    });
    const { lesson } = await unpackLesson(bytes);
    expect(lesson.title).toBe('Legacy');
    expect(lesson.pages).toHaveLength(1);
  });
});
