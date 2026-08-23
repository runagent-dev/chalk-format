import { describe, expect, it } from 'vitest';
import { composeOverlay, diffLesson, parseOverlay, type OverlayBaseRef } from './overlay.js';
import type { Lesson, LessonObject, LessonPage } from './schema.js';

const REF: OverlayBaseRef = { id: 'physics', version: 3 };

function rect(id: string, over: Partial<Record<string, unknown>> = {}): LessonObject {
  return { id, type: 'rect', x: 0, y: 0, width: 10, height: 10, fill: '#000', stroke: '#111', strokeWidth: 1, ...over } as LessonObject;
}
function ink(id: string): LessonObject {
  return { id, type: 'ink', x: 0, y: 0, points: [1, 2, 3, 4], color: '#f00', size: 3 };
}
function page(id: string, objects: LessonObject[], over: Partial<LessonPage> = {}): LessonPage {
  return { id, title: id, background: { type: 'blank' }, objects, ...over };
}
function baseLesson(): Lesson {
  return {
    id: 'physics',
    title: 'Physics',
    locale: 'en',
    createdAt: 't0',
    updatedAt: 't0',
    pages: [page('p1', [rect('r1'), rect('r2')]), page('p2', [], { background: { type: 'color', color: '#fff' } })],
    snipPages: [],
  };
}
const clone = <T>(v: T): T => structuredClone(v);

/** The invariant the whole format rests on. */
function roundTrips(base: Lesson, edited: Lesson) {
  const overlay = diffLesson(base, edited, REF);
  expect(composeOverlay(base, overlay)).toEqual(edited);
  return overlay;
}

describe('composeOverlay / diffLesson', () => {
  it('an empty overlay reproduces the base', () => {
    const base = baseLesson();
    const overlay = diffLesson(base, clone(base), REF);
    expect(overlay.pages).toEqual({});
    expect(overlay.newPages).toEqual([]);
    expect(overlay.pageOrder).toBeUndefined();
    expect(composeOverlay(base, overlay)).toEqual(base);
  });

  it('added annotation is a new-id upsert that never touches base objects', () => {
    const base = baseLesson();
    const edited = clone(base);
    edited.pages[0]!.objects.push(ink('a1'));
    const overlay = roundTrips(base, edited);
    // Minimal: just the one new object, no removals, no base objects copied.
    expect(overlay.pages['p1']!.upsertedObjects).toEqual([ink('a1')]);
    expect(overlay.pages['p1']!.removedObjectIds).toBeUndefined();
  });

  it('removing a base object is a tombstone', () => {
    const base = baseLesson();
    const edited = clone(base);
    edited.pages[0]!.objects = [rect('r2')]; // dropped r1
    const overlay = roundTrips(base, edited);
    expect(overlay.pages['p1']!.removedObjectIds).toEqual(['r1']);
  });

  it('updating a base object records only that object', () => {
    const base = baseLesson();
    const edited = clone(base);
    (edited.pages[0]!.objects[0] as { fill: string }).fill = '#00f';
    const overlay = roundTrips(base, edited);
    expect(overlay.pages['p1']!.upsertedObjects).toHaveLength(1);
    expect(overlay.pages['p1']!.upsertedObjects![0]!.id).toBe('r1');
  });

  it('clearing a page uses the cleared flag, not a list of tombstones', () => {
    const base = baseLesson();
    const edited = clone(base);
    edited.pages[0]!.objects = [];
    const overlay = roundTrips(base, edited);
    expect(overlay.pages['p1']!.cleared).toBe(true);
    expect(overlay.pages['p1']!.removedObjectIds).toBeUndefined();
  });

  it('reordering objects within a page records objectOrder', () => {
    const base = baseLesson();
    const edited = clone(base);
    edited.pages[0]!.objects = [rect('r2'), rect('r1')]; // swapped
    const overlay = roundTrips(base, edited);
    expect(overlay.pages['p1']!.objectOrder).toEqual(['r2', 'r1']);
  });

  it('overrides page background/title/size', () => {
    const base = baseLesson();
    const edited = clone(base);
    edited.pages[1]!.background = { type: 'blank' };
    edited.pages[1]!.title = 'Renamed';
    edited.pages[1]!.width = 2000;
    roundTrips(base, edited);
  });

  it('adds a new page (full page in newPages)', () => {
    const base = baseLesson();
    const edited = clone(base);
    edited.pages.push(page('p3', [ink('x')]));
    const overlay = roundTrips(base, edited);
    expect(overlay.newPages.map((p) => p.id)).toEqual(['p3']);
    expect(overlay.pageOrder).toBeUndefined(); // appended in default order
  });

  it('removes a base page (absent from pageOrder)', () => {
    const base = baseLesson();
    const edited = clone(base);
    edited.pages = [edited.pages[0]!]; // dropped p2
    const overlay = roundTrips(base, edited);
    expect(overlay.pageOrder).toEqual(['p1']);
  });

  it('reorders pages via pageOrder', () => {
    const base = baseLesson();
    const edited = clone(base);
    edited.pages = [edited.pages[1]!, edited.pages[0]!]; // p2, p1
    const overlay = roundTrips(base, edited);
    expect(overlay.pageOrder).toEqual(['p2', 'p1']);
  });

  it('overrides the lesson title and updatedAt', () => {
    const base = baseLesson();
    const edited = clone(base);
    edited.title = 'Physics — my notes';
    edited.updatedAt = 't5';
    const overlay = roundTrips(base, edited);
    expect(overlay.titleOverride).toBe('Physics — my notes');
    expect(overlay.updatedAt).toBe('t5');
  });

  it('round-trips a complex multi-edit lesson', () => {
    const base = baseLesson();
    const edited = clone(base);
    // p1: add annotation, remove r1, mutate r2
    edited.pages[0]!.objects = [rect('r2', { fill: '#0f0' }), ink('a1')];
    edited.pages[0]!.title = 'P1 edited';
    // p2: add ink + change background
    edited.pages[1]!.objects = [ink('a2')];
    edited.pages[1]!.background = { type: 'blank' };
    // add p3, then reorder to [p2, p3, p1]
    edited.pages.push(page('p3', [rect('n1')]));
    edited.pages = [edited.pages[1]!, edited.pages[2]!, edited.pages[0]!];
    edited.title = 'My copy';
    edited.updatedAt = 't9';

    const overlay = roundTrips(base, edited); // the assertion is inside
    expect(overlay.pageOrder).toEqual(['p2', 'p3', 'p1']);
    expect(overlay.newPages.map((p) => p.id)).toEqual(['p3']);
    // base r1/r2 bytes are NOT duplicated wholesale — only the changed r2.
    expect(overlay.pages['p1']!.upsertedObjects!.map((o) => o.id)).toEqual(['r2', 'a1']);
  });

  it('parseOverlay validates a produced overlay', () => {
    const base = baseLesson();
    const edited = clone(base);
    edited.pages[0]!.objects.push(ink('a1'));
    const overlay = diffLesson(base, edited, REF);
    expect(() => parseOverlay(overlay)).not.toThrow();
    expect(parseOverlay(overlay).base.version).toBe(3);
  });
});
