import { describe, expect, it } from 'vitest';
import type { BookPatch, PatchResult } from '@chalk-format/container';
import type { Lesson, LessonObject, LessonPage } from '@chalk-format/model';
import { adoptedPatch, mediaWanted, patchReferences } from './patch-state.js';

const text = (id: string, over: Record<string, unknown> = {}) => ({ id, type: 'text', x: 0, y: 0, text: 'hi', fontSize: 20, fill: '#000000', ...over }) as LessonObject;
const page = (id: string, objects: LessonObject[], over: Record<string, unknown> = {}) => ({ id, title: id, background: { type: 'blank' }, objects, ...over }) as LessonPage;
const lesson = (pages: LessonPage[]): Lesson => ({ id: 'b', title: 'B', locale: 'bn', pages, snipPages: [], createdAt: '', updatedAt: '' }) as Lesson;
const patchOf = (deleted: string[] = []) => ({ base: { version: 'v0', order: [], title: 'B', pages: {} }, mine: { order: [], pages: {}, deleted }, media: [] }) as BookPatch;
const result = (pages: PatchResult['pages'], extra: Partial<PatchResult> = {}): PatchResult => ({ version: 'sha256:new', pages, report: { notes: [] }, ...extra });
const get = (l: Lesson, id: string, o: string) => l.pages.find((p) => p.id === id)!.objects.find((x) => x.id === o) as unknown as Record<string, unknown>;

describe('what the editor keeps after the host kept a patch', () => {
  const sentLesson = lesson([page('a', [text('a1', { x: 1, y: 1 })]), page('b', [text('b1')])]);

  it('a plain answer: the sent book is the saved one, the history is kept, the hashes move on', () => {
    const r = adoptedPatch({ patch: patchOf(['gone']), sent: sentLesson, top: sentLesson, result: result({ a: { file: 'pages/9-aaaaaaaa.json', hash: 'aaaaaaaa' } }), hashes: new Map([['a', 'old'], ['gone', 'x'], ['b', 'bbbbbbbb']]), known: new Set(['k1']), mediaIds: ['m1'] });
    expect(r.saved).toBe(sentLesson);
    expect(r.top).toBeNull();
    expect([...r.hashes]).toEqual([['a', 'aaaaaaaa'], ['b', 'bbbbbbbb']]);
    expect([...r.known].sort()).toEqual(['k1', 'm1']);
  });

  it('a merged page comes back whole and becomes the saved one; with nothing edited meanwhile it is also the working lesson', () => {
    const merged = page('a', [text('a1', { x: 1, y: 3 })]);
    const r = adoptedPatch({ patch: patchOf(), sent: sentLesson, top: sentLesson, result: result({ a: { file: 'f', hash: 'h', page: merged } }), hashes: new Map(), known: new Set(), mediaIds: [] });
    expect(get(r.saved, 'a', 'a1').y).toBe(3);
    expect(r.top).toBe(r.saved); // exactly the saved book: the editor is not "unsaved"
    expect(r.saved.pages[1]).toBe(sentLesson.pages[1]); // other pages untouched
  });

  it('the host\'s merge and an edit the user made DURING the save both stay (neither is overwritten by the next patch)', () => {
    const merged = page('a', [text('a1', { x: 1, y: 3 })]); // the host merged someone else's y=3
    const meanwhile = lesson([page('a', [text('a1', { x: 50, y: 1 })]), sentLesson.pages[1]!]); // the user moved x while the save ran
    const r = adoptedPatch({ patch: patchOf(), sent: sentLesson, top: meanwhile, result: result({ a: { file: 'f', hash: 'h', page: merged } }), hashes: new Map(), known: new Set(), mediaIds: [] });
    expect(get(r.saved, 'a', 'a1')).toMatchObject({ x: 1, y: 3 }); // the base of the next patch is the host's page
    expect(get(r.top!, 'a', 'a1')).toMatchObject({ x: 50, y: 3 }); // the user's x edit on top of the host's y
    expect(r.top).not.toBe(r.saved); // still unsaved: the x edit has not been sent
  });

  it('a page the user did not touch meanwhile takes the host\'s version; one they did keeps their edit where they disagree', () => {
    const merged = lesson([page('a', [text('a1', { x: 9 })]), page('b', [text('b1', { x: 8 })])]);
    const meanwhile = lesson([page('a', [text('a1', { x: 1, y: 1 })]), page('b', [text('b1', { x: 77 })])]); // a untouched since the click, b edited
    const r = adoptedPatch({
      patch: patchOf(), sent: lesson([sentLesson.pages[0]!, sentLesson.pages[1]!]), top: { ...meanwhile, pages: [sentLesson.pages[0]!, meanwhile.pages[1]!] },
      result: result({ a: { file: 'f', hash: 'h', page: merged.pages[0]! }, b: { file: 'g', hash: 'i', page: merged.pages[1]! } }), hashes: new Map(), known: new Set(), mediaIds: [],
    });
    expect(get(r.top!, 'a', 'a1').x).toBe(9);
    expect(get(r.top!, 'b', 'b1').x).toBe(77);
  });

  it('an asset the host dropped from the index is forgotten, so its bytes are sent again if the picture comes back', () => {
    const r = adoptedPatch({ patch: patchOf(), sent: sentLesson, top: sentLesson, result: result({}, { dropped: ['pic'] }), hashes: new Map(), known: new Set(['pic', 'other']), mediaIds: [] });
    expect([...r.known]).toEqual(['other']);
  });

  it('an asset sent in this very patch that the host also dropped is forgotten too', () => {
    const r = adoptedPatch({ patch: patchOf(), sent: sentLesson, top: sentLesson, result: result({}, { dropped: ['pic'] }), hashes: new Map(), known: new Set(), mediaIds: ['pic'] });
    expect(r.known.has('pic')).toBe(false);
  });
});

describe('review findings, round 2 (the editor)', () => {
  const sent = lesson([page('a', [text('a1', { x: 1, y: 1 })]), page('b', [text('b1')])]);

  it('a page the host merged and the user DELETED during the save keeps the sent version as the base, so the delete meets the host\'s changes as a conflict', () => {
    const merged = page('a', [text('a1', { x: 1, y: 3 })]);
    const top = lesson([sent.pages[1]!]); // the user deleted page a while the save ran
    const r = adoptedPatch({ patch: patchOf(), sent, top, result: result({ a: { file: 'f', hash: 'h', page: merged } }), hashes: new Map(), known: new Set(), mediaIds: [] });
    expect(get(r.saved, 'a', 'a1').y).toBe(1); // not the host's page: a later delete is then not a clean delete of unchanged work
    expect(r.top!.pages.map((p) => p.id)).toEqual(['b']);
  });

  it('media another editor added, in a merged page, counts as carried', () => {
    const r = adoptedPatch({ patch: patchOf(), sent, top: sent, result: result({}, { assets: [{ id: 'theirs', type: 'image/png', path: 'assets/theirs' }] }), hashes: new Map(), known: new Set(), mediaIds: [] });
    expect(r.known.has('theirs')).toBe(true);
  });
});

describe('which assets a patch carries', () => {
  const none = new Set<string>();
  it('only those the host has no bytes of', () => {
    expect(mediaWanted({ referenced: ['have', 'new'], carried: new Set(['have']), external: none, local: () => false })).toEqual(['new']);
  });
  it('an asset the host lists as external stays external, unless the editor holds the bytes (a local file with the same key was imported)', () => {
    const ext = new Set(['lib']);
    expect(mediaWanted({ referenced: ['lib'], carried: none, external: ext, local: () => false })).toEqual([]);
    expect(mediaWanted({ referenced: ['lib'], carried: none, external: ext, local: (id) => id === 'lib' })).toEqual(['lib']);
  });
});

describe('review findings, round 3 (the editor)', () => {
  const sent = lesson([page('a', [text('a1')])]);
  it('assets the host has no bytes for are forgotten, so they are sent again', () => {
    const r = adoptedPatch({ patch: patchOf(), sent, top: sent, result: result({}, { unresolved: ['pic'] }), hashes: new Map(), known: new Set(['pic', 'ok']), mediaIds: [] });
    expect([...r.known]).toEqual(['ok']);
  });
  it('a patch looks at the changed pages\' assets, at every asset the editor holds bytes for that the book uses (even on an unchanged page), and at what the host asked for again', () => {
    const refs = patchReferences({ changed: ['c1'], all: new Set(['c1', 'imported', 'x']), local: ['imported', 'unused'], resend: ['again'] });
    expect(refs.sort()).toEqual(['again', 'c1', 'imported']);
  });
  it('so a local file for an asset the host lists as external is sent although the page that uses it did not change', () => {
    const referenced = patchReferences({ changed: [], all: new Set(['lib']), local: ['lib'], resend: [] });
    expect(mediaWanted({ referenced, carried: new Set(), external: new Set(['lib']), local: (id) => id === 'lib' })).toEqual(['lib']);
  });
});
