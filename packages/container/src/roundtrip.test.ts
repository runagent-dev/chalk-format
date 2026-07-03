import { describe, it, expect } from 'vitest';
import { addObject, addPage, createLesson, type Lesson } from '@chalkbook/core';
import { packLesson, type AssetBundle } from './pack.js';
import { unpackLesson, type UnpackResult } from './unpack.js';
import { validateLessonPackage } from './validate.js';

async function roundTrip(lesson: Lesson, assets?: AssetBundle): Promise<UnpackResult> {
  const bytes = await packLesson(lesson, assets);
  return unpackLesson(bytes);
}

describe('chalk round-trip', () => {
  it('preserves a blank lesson', async () => {
    const original = createLesson('Round-Trip Test');
    const { lesson: restored, assets } = await roundTrip(original);
    expect(restored.id).toBe(original.id);
    expect(restored.title).toBe(original.title);
    expect(restored.pages).toHaveLength(1);
    expect(restored.pages[0]!.background).toEqual({ type: 'blank' });
    expect(assets.size).toBe(0);
  });

  it('preserves multi-page lessons with rectangles and text', async () => {
    let lesson = createLesson('Multi-page');
    lesson = addPage(lesson, { title: 'Second' });
    lesson = addObject(lesson, lesson.pages[0]!.id, {
      id: 'r1',
      type: 'rect',
      x: 10,
      y: 20,
      width: 100,
      height: 50,
      fill: '#f43f5e',
      stroke: '#111',
      strokeWidth: 2,
    });
    lesson = addObject(lesson, lesson.pages[1]!.id, {
      id: 't1',
      type: 'text',
      x: 30,
      y: 40,
      text: 'hello',
      fontSize: 24,
      fill: '#111',
    });

    const { lesson: restored } = await roundTrip(lesson);
    expect(restored.pages).toHaveLength(2);
    expect(restored.pages[0]!.objects).toEqual(lesson.pages[0]!.objects);
    expect(restored.pages[1]!.objects).toEqual(lesson.pages[1]!.objects);
  });

  it('round-trips binary assets byte-for-byte', async () => {
    const lesson = createLesson('With Assets');
    const pdfBytes = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52]); // "%PDF-1.4"
    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]); // PNG signature
    const bundle: AssetBundle = new Map([
      ['sha256:pdf', { type: 'application/pdf', bytes: pdfBytes }],
      ['sha256:png', { type: 'image/png', bytes: pngBytes }],
    ]);

    const { lesson: restored, assets } = await roundTrip(lesson, bundle);
    expect(restored.title).toBe(lesson.title);
    expect(assets.size).toBe(2);
    expect(assets.get('sha256:pdf')?.type).toBe('application/pdf');
    expect(Array.from(assets.get('sha256:pdf')!.bytes)).toEqual(Array.from(pdfBytes));
    expect(assets.get('sha256:png')?.type).toBe('image/png');
    expect(Array.from(assets.get('sha256:png')!.bytes)).toEqual(Array.from(pngBytes));
  });

  it('accepts ids that contain colons (like sha256:...) safely', async () => {
    // Colons are the standard content-hash separator but some ZIP
    // tooling dislikes them; the packer must escape internally while
    // the manifest keeps the original id.
    const lesson = createLesson();
    const bundle: AssetBundle = new Map([
      [
        'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        { type: 'application/pdf', bytes: new Uint8Array([1, 2, 3]) },
      ],
    ]);
    const { assets } = await roundTrip(lesson, bundle);
    expect(
      assets.get('sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'),
    ).toBeDefined();
  });
});

describe('validateLessonPackage', () => {
  it('accepts a well-formed lesson', async () => {
    const bytes = await packLesson(createLesson());
    const result = await validateLessonPackage(bytes);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('rejects arbitrary bytes as not-a-zip', async () => {
    const bad = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const result = await validateLessonPackage(bad);
    expect(result.ok).toBe(false);
    expect(result.issues[0]!.severity).toBe('error');
  });
});
