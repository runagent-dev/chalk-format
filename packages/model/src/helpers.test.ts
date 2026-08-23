import { describe, it, expect } from 'vitest';
import {
  addObject,
  addObjectToSnipPage,
  addPage,
  addSnipPage,
  createLesson,
  generateId,
  removeObject,
  removeObjectFromSnipPage,
  removeSnipPage,
  replaceSnipPageObjects,
  updateObject,
  updateObjectInSnipPage,
} from './helpers.js';
import type { LessonPage, RectObject } from './lesson.js';

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
    expect(lesson.snipPages).toEqual([]);
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

describe('updateObject', () => {
  const rect: RectObject = {
    id: 'r1',
    type: 'rect',
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    fill: '#000',
    stroke: '#000',
    strokeWidth: 1,
  };

  it('replaces the object with matching id on the given page', () => {
    const l1 = createLesson();
    const pageId = l1.pages[0]!.id;
    const l2 = addObject(l1, pageId, rect);
    const updated: RectObject = { ...rect, x: 42 };
    const l3 = updateObject(l2, pageId, rect.id, updated);
    expect(l3.pages[0]!.objects).toEqual([updated]);
  });

  it('is a no-op when objectId does not match', () => {
    const l1 = createLesson();
    const pageId = l1.pages[0]!.id;
    const l2 = addObject(l1, pageId, rect);
    const l3 = updateObject(l2, pageId, 'nope', { ...rect, x: 999 });
    expect(l3.pages[0]!.objects).toEqual([rect]);
  });
});

describe('removeObject', () => {
  const rect: RectObject = {
    id: 'r1',
    type: 'rect',
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    fill: '#000',
    stroke: '#000',
    strokeWidth: 1,
  };

  it('removes the object with matching id from the given page', () => {
    const l1 = createLesson();
    const pageId = l1.pages[0]!.id;
    const l2 = addObject(l1, pageId, rect);
    const l3 = removeObject(l2, pageId, rect.id);
    expect(l3.pages[0]!.objects).toEqual([]);
  });

  it('is a no-op when objectId does not match', () => {
    const l1 = createLesson();
    const pageId = l1.pages[0]!.id;
    const l2 = addObject(l1, pageId, rect);
    const l3 = removeObject(l2, pageId, 'nope');
    expect(l3.pages[0]!.objects).toEqual([rect]);
  });
});

describe('snip page helpers', () => {
  const rect: RectObject = {
    id: 'r1',
    type: 'rect',
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    fill: '#000',
    stroke: '#000',
    strokeWidth: 1,
  };
  const snipPage: LessonPage = {
    id: 'sp1',
    title: 'Snip',
    background: { type: 'image', assetId: 'sha256:capture' },
    objects: [],
  };

  it('addSnipPage appends to snipPages, leaving pages untouched', () => {
    const l1 = createLesson();
    const l2 = addSnipPage(l1, snipPage);
    expect(l2.snipPages).toEqual([snipPage]);
    expect(l2.pages).toEqual(l1.pages);
  });

  it('removeSnipPage drops the matching satellite page only', () => {
    const l1 = addSnipPage(createLesson(), snipPage);
    const other: LessonPage = { ...snipPage, id: 'sp2' };
    const l2 = addSnipPage(l1, other);
    const l3 = removeSnipPage(l2, 'sp1');
    expect(l3.snipPages).toEqual([other]);
  });

  it('addObjectToSnipPage adds to the specified satellite page only', () => {
    const l1 = addSnipPage(createLesson(), snipPage);
    const other: LessonPage = { ...snipPage, id: 'sp2' };
    const l2 = addSnipPage(l1, other);
    const l3 = addObjectToSnipPage(l2, 'sp1', rect);
    expect(l3.snipPages.find((p) => p.id === 'sp1')!.objects).toEqual([rect]);
    expect(l3.snipPages.find((p) => p.id === 'sp2')!.objects).toEqual([]);
  });

  it('updateObjectInSnipPage replaces the object with matching id', () => {
    const l1 = addObjectToSnipPage(addSnipPage(createLesson(), snipPage), 'sp1', rect);
    const moved: RectObject = { ...rect, x: 99 };
    const l2 = updateObjectInSnipPage(l1, 'sp1', rect.id, moved);
    expect(l2.snipPages[0]!.objects).toEqual([moved]);
  });

  it('removeObjectFromSnipPage removes the object with matching id', () => {
    const l1 = addObjectToSnipPage(addSnipPage(createLesson(), snipPage), 'sp1', rect);
    const l2 = removeObjectFromSnipPage(l1, 'sp1', rect.id);
    expect(l2.snipPages[0]!.objects).toEqual([]);
  });

  it('replaceSnipPageObjects wholesale-replaces the objects array (used by the modal undo stack)', () => {
    const l1 = addObjectToSnipPage(addSnipPage(createLesson(), snipPage), 'sp1', rect);
    const l2 = replaceSnipPageObjects(l1, 'sp1', []);
    expect(l2.snipPages[0]!.objects).toEqual([]);
    const l3 = replaceSnipPageObjects(l2, 'sp1', [rect]);
    expect(l3.snipPages[0]!.objects).toEqual([rect]);
  });
});
