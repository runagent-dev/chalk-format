import { describe, it, expect } from 'vitest';
import { addObject, addPage, createLesson, generateId } from './helpers.js';
import type { RectObject } from './lesson.js';

describe('generateId', () => {
  it('produces unique ids on rapid calls', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId('t')));
    expect(ids.size).toBe(100);
  });
});

describe('createLesson', () => {
  it('creates a lesson with one blank page', () => {
    const lesson = createLesson('Solar System');
    expect(lesson.title).toBe('Solar System');
    expect(lesson.pages).toHaveLength(1);
    expect(lesson.pages[0]!.background).toEqual({ type: 'blank' });
    expect(lesson.pages[0]!.objects).toEqual([]);
    expect(lesson.locale).toBe('en');
    expect(lesson.createdAt).toBe(lesson.updatedAt);
  });

  it('defaults to Untitled Lesson', () => {
    expect(createLesson().title).toBe('Untitled Lesson');
  });
});

describe('addPage', () => {
  it('appends a new page with an auto title', () => {
    const lesson = createLesson();
    const updated = addPage(lesson);
    expect(updated.pages).toHaveLength(2);
    expect(updated.pages[1]!.title).toBe('Page 2');
    expect(updated.pages[1]!.background).toEqual({ type: 'blank' });
  });

  it('does not mutate the original lesson', () => {
    const lesson = createLesson();
    const updated = addPage(lesson);
    expect(lesson.pages).toHaveLength(1);
    expect(updated).not.toBe(lesson);
    expect(updated.updatedAt >= lesson.updatedAt).toBe(true);
  });

  it('accepts a custom title and background', () => {
    const lesson = createLesson();
    const updated = addPage(lesson, {
      title: 'Cover',
      background: { type: 'color', color: '#000000' },
    });
    expect(updated.pages[1]!.title).toBe('Cover');
    expect(updated.pages[1]!.background).toEqual({ type: 'color', color: '#000000' });
  });
});

describe('addObject', () => {
  const rect: RectObject = {
    id: 'r1',
    type: 'rect',
    x: 10,
    y: 10,
    width: 100,
    height: 50,
    fill: '#f00',
    stroke: '#000',
    strokeWidth: 2,
  };

  it('adds an object to the specified page only', () => {
    const l1 = createLesson();
    const l2 = addPage(l1);
    const pageId = l2.pages[0]!.id;
    const l3 = addObject(l2, pageId, rect);
    expect(l3.pages[0]!.objects).toEqual([rect]);
    expect(l3.pages[1]!.objects).toEqual([]);
  });

  it('is a no-op when pageId does not match', () => {
    const lesson = createLesson();
    const updated = addObject(lesson, 'nope', rect);
    expect(updated.pages[0]!.objects).toEqual([]);
  });
});
