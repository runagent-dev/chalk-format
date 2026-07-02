import { describe, it, expect } from 'vitest';
import { addObject, addPage, createLesson, type Lesson } from '@chalkbook/core';
import { packLesson } from './pack.js';
import { unpackLesson } from './unpack.js';
import { validateLessonPackage } from './validate.js';

async function roundTrip(lesson: Lesson): Promise<Lesson> {
  const bytes = await packLesson(lesson);
  return unpackLesson(bytes);
}

describe('chalk round-trip', () => {
  it('preserves a blank lesson', async () => {
    const original = createLesson('Round-Trip Test');
    const restored = await roundTrip(original);
    expect(restored.id).toBe(original.id);
    expect(restored.title).toBe(original.title);
    expect(restored.pages).toHaveLength(1);
    expect(restored.pages[0]!.background).toEqual({ type: 'blank' });
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

    const restored = await roundTrip(lesson);
    expect(restored.pages).toHaveLength(2);
    expect(restored.pages[0]!.objects).toEqual(lesson.pages[0]!.objects);
    expect(restored.pages[1]!.objects).toEqual(lesson.pages[1]!.objects);
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
