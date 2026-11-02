import { describe, expect, it } from 'vitest';
import { createPatch } from '@chalk-format/container';
import { MEDIA_ICON_SIZE, type Lesson, type LessonObject, type LessonPage } from '@chalk-format/model';
import { edit } from '../annotate/state.js';
import { KEEP_ON_PAGE, boxOf, follow, freeIdOn, lineFor, placeAt, relocate, sigOf, type At, type Moved } from './move.js';

const page = (id: string, objects: LessonObject[], over: Record<string, unknown> = {}) => ({ id, title: id, background: { type: 'blank' }, objects, ...over }) as LessonPage;
const lesson = (pages: LessonPage[]): Lesson => ({ id: 'b', title: 'B', locale: 'bn', pages, snipPages: [], createdAt: '', updatedAt: '' }) as Lesson;
const lab = { id: 'lab1', type: 'embed', embed: 'plugin', plugin: 'chalk.lab', x: 100, y: 200, width: 400, height: 300, lab: { id: 'org.x.pendulum', version: '1.2.0', title: 'দোলক', entry: `c1:${'a'.repeat(26)}` } } as LessonObject;
const video = { id: 'v1', type: 'embed', embed: 'video', assetId: `c1:${'b'.repeat(26)}`, x: 50, y: 60, width: 320, height: 180, presentation: { open: 'popup' } } as LessonObject;
const line = { id: 'l1', type: 'line', x: 10, y: 10, x2: 110, y2: 60, stroke: '#000', strokeWidth: 2 } as LessonObject;
const ids = (l: Lesson, p: number) => l.pages[p]!.objects.map((o) => o.id);

describe('edit.move: an object to another page', () => {
  const book = lesson([page('p1', [video, lab]), page('p2', [line]), page('p3', [])]);

  it('takes it off one page and puts it on top of the other, the same object (id, library link, settings) at its new place', () => {
    const there = { ...lab, x: 5, y: 6 } as LessonObject;
    const l = edit.move('p1', 'p2', there)(book);
    expect(ids(l, 0)).toEqual(['v1']);
    expect(ids(l, 1)).toEqual(['l1', 'lab1']);
    expect(l.pages[1]!.objects[1]).toEqual(there);
    expect((l.pages[1]!.objects[1] as { lab: unknown }).lab).toEqual((lab as { lab: unknown }).lab);
    expect(l.pages[2]).toBe(book.pages[2]); // other pages untouched
  });

  it('works for every kind of object: media keeps its presentation, a line both its ends', () => {
    let l = edit.move('p1', 'p3', video)(book);
    l = edit.move('p2', 'p3', line)(l);
    expect(ids(l, 2)).toEqual(['v1', 'l1']);
    expect(l.pages[2]!.objects[0]).toEqual(video);
    expect(l.pages[2]!.objects[1]).toEqual(line);
  });

  it('to its own page it is a replace (it keeps its place in the order)', () => {
    const l = edit.move('p1', 'p1', { ...video, x: 9 } as LessonObject)(book);
    expect(ids(l, 0)).toEqual(['v1', 'lab1']);
    expect(l.pages[0]!.objects[0]!.x).toBe(9);
  });

  it('changes nothing when the object is not on the page it is said to leave, or the target page does not exist', () => {
    expect(edit.move('p2', 'p3', lab)(book)).toBe(book);
    expect(edit.move('p1', 'nope', lab)(book)).toBe(book);
  });

  it('can be repeated during a drag (each step from where it is now) and never leaves two copies', () => {
    let l = edit.move('p1', 'p2', lab)(book);
    l = edit.move('p2', 'p3', lab)(l);
    l = edit.move('p3', 'p2', { ...lab, y: 1 } as LessonObject)(l);
    const all = l.pages.flatMap((p) => p.objects.map((o) => o.id));
    expect(all.filter((id) => id === 'lab1')).toHaveLength(1);
    expect(ids(l, 1)).toEqual(['l1', 'lab1']);
  });

  it('never puts two objects with one id on a page: an id the target already uses is refused, and freeIdOn gives a new one', () => {
    const twin = lesson([page('p1', [video]), page('p2', [{ ...video, x: 400 } as LessonObject])]);
    expect(edit.move('p1', 'p2', video)(twin)).toBe(twin);
    const landing = freeIdOn(twin.pages[1], video);
    expect(landing.id).not.toBe('v1');
    expect(landing).toEqual({ ...video, id: landing.id });
    const l = edit.move('p1', 'p2', landing, 'v1')(twin);
    expect(ids(l, 0)).toEqual([]);
    expect(ids(l, 1)).toEqual(['v1', landing.id]);
    expect(freeIdOn(book.pages[2], video)).toBe(video); // free: the same object, the same id
  });

  it('a partial save sends both pages: the one it left and the one it is on', () => {
    const l = edit.move('p1', 'p2', lab)(book);
    const patch = createPatch({ version: 'v0', lesson: book, hashes: new Map([['p1', 'aaaaaaaa'], ['p2', 'bbbbbbbb'], ['p3', 'cccccccc']]) }, l);
    expect(Object.keys(patch.mine.pages).sort()).toEqual(['p1', 'p2']);
    expect(patch.mine.pages.p2!.objects.map((o) => o.id)).toEqual(['l1', 'lab1']);
    expect(patch.mine.deleted).toEqual([]);
  });
});

describe('where a moved object goes', () => {
  const size = { width: 800, height: 1100 };

  it('placeAt puts its top left where it was dropped, and keeps part of it on the page', () => {
    expect(placeAt(video, { x: 200, y: 300 }, size)).toMatchObject({ x: 200, y: 300, width: 320, height: 180 });
    const far = placeAt(video, { x: 5000, y: -5000 }, size);
    expect(far.x).toBe(800 - KEEP_ON_PAGE);
    expect(far.y).toBe(KEEP_ON_PAGE - 180);
  });

  it('placeAt moves both ends of a line and keeps an icon-sized marker by its drawn box', () => {
    expect(placeAt(line, { x: 0, y: 0 }, size)).toMatchObject({ x: 0, y: 0, x2: 100, y2: 50 });
    const icon = { ...lab, displayMode: 'icon' } as LessonObject;
    expect(boxOf(icon).width).toBe(MEDIA_ICON_SIZE);
    expect(placeAt(icon, { x: 2000, y: 0 }, size).x).toBe(800 - KEEP_ON_PAGE);
  });

  it('relocate keeps the place relative to the page, scaled to a page of another size, and inside it', () => {
    expect(relocate(video, size, size)).toMatchObject({ x: 50, y: 60 });
    expect(relocate(video, size, { width: 400, height: 550 })).toMatchObject({ x: 25, y: 30, width: 320, height: 180 });
    // near the bottom right of a big page: on a small one it is pulled in so all of it shows
    const low = { ...video, x: 700, y: 1000 } as LessonObject;
    expect(relocate(low, size, { width: 600, height: 800 })).toMatchObject({ x: 600 - 320, y: 800 - 180 });
    // bigger than the page: its top left corner
    const big = { ...video, width: 1000, height: 1200 } as LessonObject;
    expect(relocate(big, size, { width: 600, height: 800 })).toMatchObject({ x: 0, y: 0 });
  });
});

describe('the selection follows a moved object', () => {
  const at = (pageId: string, id: string): At => ({ pageId, id });
  // moves recorded as the reader does: each on the line of the move that ended where it starts
  const line = (...ms: { from: At; to: At; sig?: string }[]) => ms.reduce<Moved[]>((acc, m) => [...acc, { from: m.from, to: m.to, sig: m.sig ?? 's', line: lineFor(acc, m.from) }], []);
  const mv = (from: At, to: At, sig?: string) => ({ from, to, ...(sig ? { sig } : {}) });
  const where = (...places: At[]) => (a: At) => places.some((p) => p.pageId === a.pageId && p.id === a.id);

  it('never to another object that only shares its id', () => {
    // x on p1 moved to p3; another x sits on p2: undoing the move leads back to p1, not to p2
    const moves = line(mv(at('p1', 'x'), at('p3', 'x')));
    expect(follow(at('p3', 'x'), moves, where(at('p1', 'x'), at('p2', 'x')))).toEqual(at('p1', 'x'));
    // with no move made, an object gone from its place is gone (no guess by id)
    expect(follow(at('p1', 'x'), [], where(at('p2', 'x')))).toBeNull();
  });

  it('never to another object that came to a place the moved object passed through', () => {
    // x (sig "a") moved from p1 to p3, then another object ("b") took p1 and the id x: it is not the moved one, and is never selected for it
    const moves = line(mv(at('p1', 'x'), at('p3', 'x'), 'a'));
    const objects = new Map([['p1 x', 'b']]);
    const has = (a: At, sig?: string) => objects.has(`${a.pageId} ${a.id}`) && (sig === undefined || objects.get(`${a.pageId} ${a.id}`) === sig);
    expect(follow(at('p3', 'x'), moves, has)).toBeNull();
    objects.set('p1 x', 'a');
    expect(follow(at('p3', 'x'), moves, has)).toEqual(at('p1', 'x'));
    // what the signature leaves out: the id and the place
    expect(sigOf({ ...video, id: 'other', x: 1, y: 2 } as LessonObject)).toBe(sigOf(video));
    expect(sigOf({ ...video, width: 1 } as LessonObject)).not.toBe(sigOf(video));
  });

  it('only along the moves of the one object: never across to another that passed through the same place', () => {
    // A (sig a) dragged p1 to p2 to p3; B (sig b), same id, moved p4 to p2; both undone: the selection on p3 finds A on p1, never B on p4
    const moves = line(mv(at('p1', 'x'), at('p2', 'x'), 'a'), mv(at('p2', 'x'), at('p3', 'x'), 'a'), mv(at('p4', 'x'), at('p2', 'x'), 'b'));
    const objects = new Map([['p1 x', 'a'], ['p4 x', 'b']]);
    const has = (q: At, sig?: string) => objects.has(`${q.pageId} ${q.id}`) && (sig === undefined || objects.get(`${q.pageId} ${q.id}`) === sig);
    expect(follow(at('p3', 'x'), moves, has)).toEqual(at('p1', 'x'));
    objects.delete('p1 x');
    expect(follow(at('p3', 'x'), moves, has)).toBeNull();
  });

  it('along one object\'s moves even when it was changed between them (moved, resized, moved, all undone)', () => {
    const moves = line(mv(at('p1', 'x'), at('p2', 'x'), 'small'), mv(at('p2', 'x'), at('p3', 'x'), 'big'));
    expect(moves.map((m) => m.line)).toEqual([1, 1]);
    // everything undone: back on p1, as it was before the resize
    const has = (q: At, sig?: string) => q.pageId === 'p1' && q.id === 'x' && (sig === undefined || sig === 'small');
    expect(follow(at('p3', 'x'), moves, has)).toEqual(at('p1', 'x'));
  });

  it('back and forth between two pages with a change between (A to B, resize, B to A, all undone)', () => {
    const moves = line(mv(at('p1', 'x'), at('p2', 'x'), 'small'), mv(at('p2', 'x'), at('p1', 'x'), 'big'));
    // the selection was on p1 (after the second move); all undone, the object is on p1 again, small: the older move knows it
    const has = (q: At, sig?: string) => q.pageId === 'p1' && q.id === 'x' && (sig === undefined || sig === 'small');
    expect(follow(at('p2', 'x'), moves, has)).toEqual(at('p1', 'x'));
  });

  it('through a renamed id, and back again on redo', () => {
    const moves = line(mv(at('p1', 'x'), at('p2', 'x_new')));
    expect(follow(at('p2', 'x_new'), moves, where(at('p1', 'x')))).toEqual(at('p1', 'x'));
    expect(follow(at('p1', 'x'), moves, where(at('p2', 'x_new')))).toEqual(at('p2', 'x_new'));
  });

  it('back past a move it does not need: A to B to C, undone twice, finds A', () => {
    const moves = line(mv(at('p1', 'x'), at('p2', 'x')), mv(at('p2', 'x'), at('p3', 'x')));
    // the first undo left the selection on p2; the second puts the object back on p1
    expect(follow(at('p2', 'x'), moves, where(at('p1', 'x')))).toEqual(at('p1', 'x'));
  });

  it('along a drag that crossed several pages, undone as one step', () => {
    const moves = line(mv(at('p1', 'x'), at('p2', 'x')), mv(at('p2', 'x'), at('p3', 'x')));
    expect(follow(at('p3', 'x'), moves, where(at('p1', 'x')))).toEqual(at('p1', 'x'));
    expect(follow(at('p3', 'x'), moves, where())).toBeNull();
  });
});
