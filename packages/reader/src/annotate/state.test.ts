import { describe, expect, it } from 'vitest';
import { composeOverlay, diffLesson, parseOverlay, type Lesson, type LessonObject } from '@chalk-format/model';
import { edit } from './state.js';

const base: Lesson = {
  id: 'book', title: 'Book', locale: 'bn', createdAt: '', updatedAt: '', snipPages: [],
  pages: [
    { id: 'p1', title: '1', background: { type: 'blank' }, objects: [{ id: 'printed', type: 'text', x: 0, y: 0, text: 'বই', fontSize: 20, fill: '#000' }] },
    { id: 'p2', title: '2', background: { type: 'blank' }, objects: [] },
  ],
};
const note: LessonObject = { id: 'n1', type: 'ink', x: 10, y: 10, points: [0, 0, 5, 5], color: '#c0392b', size: 4 };
const ref = { id: 'book', version: 8 };

describe('annotations as an overlay', () => {
  it('adding, moving and erasing round-trips through diff and compose', () => {
    let l = edit.add('p1', note)(base);
    l = edit.replace('p1', { ...note, x: 20 })(l);
    l = edit.add('p2', { ...note, id: 'n2' })(l);
    l = edit.remove('p2', new Set(['n2']))(l);
    const ov = parseOverlay(JSON.parse(JSON.stringify(diffLesson(base, l, ref))));
    expect(composeOverlay(base, ov)).toEqual(l);
    expect(ov.pages.p1?.upsertedObjects?.map((o) => o.id)).toEqual(['n1']);
  });

  it("records removing the book's own objects (editBase) without copying the page", () => {
    const two: Lesson = { ...base, pages: [{ ...base.pages[0]!, objects: [...base.pages[0]!.objects, { ...note, id: 'printed-2' }] }, base.pages[1]!] };
    const ov = diffLesson(two, edit.remove('p1', new Set(['printed']))(two), ref);
    expect(ov.pages.p1?.removedObjectIds).toEqual(['printed']);
    expect(ov.pages.p1?.upsertedObjects).toBeUndefined();
    // removing every object is recorded as `cleared`
    const all = diffLesson(base, edit.remove('p1', new Set(['printed']))(base), ref);
    expect(all.pages.p1?.cleared).toBe(true);
    expect(composeOverlay(base, all).pages[0]!.objects).toEqual([]);
  });

  it('leaves untouched pages as they were (identity: their renders are skipped)', () => {
    const l = edit.add('p1', note)(base);
    expect(l.pages[1]).toBe(base.pages[1]);
    expect(edit.remove('p2', new Set(['nothing']))(l)).toBe(l);
  });
});

describe('notes on an edited book (authoring)', () => {
  it('move onto the new book: the notes stay, and so does what the author added', () => {
    const withNote = edit.add('p1', note)(base);
    const edited = edit.add('p2', { id: 'added', type: 'rect', x: 0, y: 0, width: 10, height: 10, fill: 'transparent', stroke: '#000', strokeWidth: 2 })(base);
    // what useAnnotations does when its base changes
    const moved = composeOverlay(edited, diffLesson(base, withNote, { id: base.id, version: 10 }));
    expect(moved.pages[0]!.objects.map((o) => o.id)).toEqual(['printed', 'n1']);
    expect(moved.pages[1]!.objects.map((o) => o.id)).toEqual(['added']);
    // and the overlay against the new book holds only the note
    const ov = diffLesson(edited, moved, { id: base.id, version: 10 });
    expect(JSON.stringify(ov)).toContain('n1');
    expect(JSON.stringify(ov)).not.toContain('added');
  });
});
