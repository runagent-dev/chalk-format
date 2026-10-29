import { describe, expect, it } from 'vitest';
import type { Lesson, LessonObject, LessonPage } from '@chalk-format/model';
import { assetKey } from '@chalk-format/model';
import { assertContentNamedFiles, createPatch, fileHash, mergeBook, pagesNeeded, type BookPatch } from './index.js';

import { text, page, lessonOf, Host } from './__fixtures__/patch-host.js';
const ids = (l: LessonPage[]) => l.map((p) => p.id);
const obj = (p: LessonPage, id: string) => p.objects.find((o) => o.id === id) as Record<string, unknown> | undefined;
const edit = (l: Lesson, id: string, fn: (p: LessonPage) => LessonPage): Lesson => ({ ...l, pages: l.pages.map((p) => (p.id === id ? fn(p) : p)) });
const base3 = () => lessonOf([page('a', [text('a1'), text('a2')]), page('b', [text('b1')]), page('c', [text('c1')])]);

describe('createPatch', () => {
  it('lists only the changed pages, with their base', async () => {
    const h = await Host.open(base3());
    const e = await h.editor();
    const mine = edit(e.lesson, 'b', (p) => ({ ...p, objects: [{ ...p.objects[0]!, x: 99 } as LessonObject] }));
    const patch = createPatch(e, mine);
    expect(Object.keys(patch.mine.pages)).toEqual(['b']);
    expect(Object.keys(patch.base.pages)).toEqual(['b']);
    expect(patch.base.pages.b!.hash).toMatch(/^[0-9a-f]{8}$/);
    expect(patch.base.version).toBe(h.version);
    expect(patch.mine.deleted).toEqual([]);
    expect(JSON.stringify(patch).length).toBeLessThan(2000);
  });
  it('an unchanged book gives an empty patch', async () => {
    const h = await Host.open(base3());
    const e = await h.editor();
    const patch = createPatch(e, e.lesson);
    expect(patch.mine.pages).toEqual({});
    expect(patch.mine.deleted).toEqual([]);
  });
});

describe('mergeBook: the host has not changed (a plain save)', () => {
  it('takes the editor\'s page and writes only that page', async () => {
    const h = await Host.open(base3());
    const e = await h.editor();
    const before = [...h.files.keys()];
    const patch = createPatch(e, edit(e.lesson, 'b', (p) => ({ ...p, objects: [text('b1', 'changed'), text('b2')] })));
    const { merge, written, result } = await h.save(patch);
    expect(merge.report.notes).toEqual([]);
    expect(written.filter((f) => f.startsWith('pages/'))).toHaveLength(1);
    expect(written.some((f) => f.startsWith('text-'))).toBe(true); // b's text changed
    expect(h.page('b').objects.map((o) => o.id)).toEqual(['b1', 'b2']);
    expect(h.page('a')).toEqual(e.lesson.pages[0]);
    expect(Object.keys(result.pages)).toEqual(['b']);
    expect(result.pages.b!.page).toBeUndefined(); // stored exactly as sent
    expect([...h.files.keys()].filter((f) => !before.includes(f)).length).toBe(written.length);
  });

  it('names new pages with a book-wide counter, so moving pages renames nothing', async () => {
    const h = await Host.open(base3());
    const e = await h.editor();
    const moved = { ...e.lesson, pages: [e.lesson.pages[2]!, e.lesson.pages[0]!, e.lesson.pages[1]!] };
    const m = await h.save(createPatch(e, moved));
    expect(m.written).toEqual([]); // only book.json changes
    expect(ids(h.index.pages as unknown as LessonPage[])).toEqual(['c', 'a', 'b']);
    const e2 = await h.editor();
    const added = { ...e2.lesson, pages: [...e2.lesson.pages, page('d', [text('d1')])] };
    const a = await h.save(createPatch(e2, added));
    const dFile = h.index.pages.find((p) => p.id === 'd')!.file;
    expect(dFile).toMatch(/^pages\/4-[0-9a-f]{8}\.json$/); // one more than the largest in the index
    expect(a.written.filter((f) => f.startsWith('pages/'))).toEqual([dFile]);
  });

  it('adds, deletes and reorders pages in one patch', async () => {
    const h = await Host.open(base3());
    const e = await h.editor();
    const mine = { ...e.lesson, pages: [e.lesson.pages[2]!, page('n', [text('n1')]), e.lesson.pages[0]!] }; // b deleted, c first, n inserted, a last
    await h.save(createPatch(e, mine));
    expect(ids((await h.lesson()).pages)).toEqual(['c', 'n', 'a']);
    expect(h.text!.pages.b).toBeUndefined(); // the deleted page's text left the search file
    expect(h.text!.pages.n).toBeDefined();
  });

  it('leaves the search text file alone when no page\'s text changed (a title, a moved picture), and rewrites it when a text moves', async () => {
    const key = await assetKey(new Uint8Array([3, 3]));
    const withImg = lessonOf([page('a', [text('a1'), { id: 'i', type: 'image', x: 0, y: 0, width: 10, height: 10, assetId: key } as LessonObject]), page('b', [text('b1')])]);
    const h = await Host.open(withImg);
    const e = await h.editor();
    const textFile = h.index.text!.file;
    const m = await h.save(createPatch(e, edit(e.lesson, 'a', (p) => ({ ...p, title: 'New', objects: p.objects.map((o) => (o.type === 'image' ? ({ ...o, x: 500 } as LessonObject) : o)) }))));
    expect(m.written.some((f) => f.startsWith('text-'))).toBe(false);
    expect(h.index.text!.file).toBe(textFile);
    const e2 = await h.editor();
    const m2 = await h.save(createPatch(e2, edit(e2.lesson, 'a', (p) => ({ ...p, objects: p.objects.map((o) => (o.type === 'text' ? ({ ...o, y: 400 } as LessonObject) : o)) }))));
    expect(m2.written.some((f) => f.startsWith('text-'))).toBe(true); // the text run moved
    expect(h.index.text!.file).not.toBe(textFile);
  });

  it('an empty patch leaves the book as it is (golden)', async () => {
    const h = await Host.open(base3());
    const e = await h.editor();
    const before = await h.lesson();
    const idxBefore = h.index;
    const m = await h.save(createPatch(e, e.lesson));
    expect(m.result.unchanged).toBe(true);
    expect(m.written).toEqual([]);
    expect(await h.lesson()).toEqual(before);
    expect(h.index).toEqual(idxBefore);
  });

  it('applying the same patch twice changes nothing more', async () => {
    const h = await Host.open(base3());
    const e = await h.editor();
    const patch = createPatch(e, edit(e.lesson, 'a', (p) => ({ ...p, title: 'Renamed', objects: [...p.objects, text('a3')] })));
    await h.save(patch);
    const once = await h.lesson();
    const idx = h.index;
    const again = await h.save(patch);
    expect(again.merge.noop).toBe(true);
    expect(again.result.unchanged).toBe(true);
    expect(await h.lesson()).toEqual(once);
    expect(h.index.pages).toEqual(idx.pages);
  });

  it('changes the title and drops assets no page uses any more, keeping renditions of used ones', async () => {
    const png = new Uint8Array([1, 2, 3, 4]);
    const key = await assetKey(png);
    const other = await assetKey(new Uint8Array([9, 9, 9]));
    const withImg = lessonOf([page('a', [{ id: 'i', type: 'image', x: 0, y: 0, width: 10, height: 10, assetId: key } as LessonObject]), page('b', [{ id: 'j', type: 'image', x: 0, y: 0, width: 10, height: 10, assetId: other } as LessonObject])]);
    const h = await Host.open(withImg, new Map([[key, { type: 'image/png', bytes: png }], [other, { type: 'image/png', bytes: new Uint8Array([9, 9, 9]) }]]));
    const e = await h.editor();
    expect(h.index.assets.map((a) => a.id).sort()).toEqual([key, other].sort());
    const mine = { ...edit(e.lesson, 'b', (p) => ({ ...p, objects: [] })), title: 'New title' };
    await h.save(createPatch(e, mine));
    expect(h.index.title).toBe('New title');
    expect(h.index.assets.map((a) => a.id)).toEqual([key]); // `other` is unused now
  });
});

describe('mergeBook: the rules of the design table', () => {
  /** A saves first (theirs), then B's patch from the same base merges onto it. */
  async function twoSides(base: Lesson, a: (l: Lesson) => Lesson, b: (l: Lesson) => Lesson) {
    const h = await Host.open(base);
    const e = await h.editor();
    const firstSave = await h.save(createPatch(e, a(e.lesson)));
    const m = await h.save(createPatch(e, b(e.lesson)));
    return { h, ...m, e, firstSave };
  }
  const moveObj = (id: string, x: number) => (l: Lesson) => edit(l, 'a', (p) => ({ ...p, objects: p.objects.map((o) => (o.id === id ? ({ ...o, x } as LessonObject) : o)) }));
  const setProp = (id: string, k: string, v: unknown) => (l: Lesson) => edit(l, 'a', (p) => ({ ...p, objects: p.objects.map((o) => (o.id === id ? ({ ...o, [k]: v } as LessonObject) : o)) }));

  it('different objects of one page: both edits land', async () => {
    const { h, merge, result } = await twoSides(base3(), moveObj('a1', 111), moveObj('a2', 222));
    expect(obj(h.page('a'), 'a1')!.x).toBe(111);
    expect(obj(h.page('a'), 'a2')!.x).toBe(222);
    expect(merge.report.notes).toEqual([]);
    expect(result.pages.a!.page).toBeDefined(); // the editor must take the merged page in
    expect(obj(result.pages.a!.page!, 'a1')!.x).toBe(111);
  });

  it('different properties of one object: both land', async () => {
    const { h, merge } = await twoSides(base3(), setProp('a1', 'x', 5), setProp('a1', 'fill', '#ff0000'));
    expect(obj(h.page('a'), 'a1')).toMatchObject({ x: 5, fill: '#ff0000' });
    expect(merge.report.notes).toEqual([]);
  });

  it('the same property to different values: the last saver wins, the other value is reported', async () => {
    const { h, merge } = await twoSides(base3(), setProp('a1', 'text', 'from A'), setProp('a1', 'text', 'from B'));
    expect(obj(h.page('a'), 'a1')!.text).toBe('from B');
    expect(merge.report.notes).toEqual([expect.objectContaining({ page: 'a', object: 'a1', property: 'text', rule: 'same-property-last-saver', by: 'mine', loser: 'from A' })]);
  });

  it('the same property to the same value: no conflict', async () => {
    const { merge } = await twoSides(base3(), moveObj('a1', 7), moveObj('a1', 7));
    expect(merge.report.notes).toEqual([]);
    expect(merge.noop).toBe(true);
  });

  it('nested properties merge one by one (presentation.open and presentation.show)', async () => {
    const withEmbed = lessonOf([page('a', [{ id: 'e', type: 'embed', embed: 'video', x: 0, y: 0, width: 10, height: 10, presentation: {} } as LessonObject])]);
    const set = (k: string, v: string) => (l: Lesson) => edit(l, 'a', (p) => ({ ...p, objects: p.objects.map((o) => ({ ...o, presentation: { ...(o as { presentation?: object }).presentation, [k]: v } }) as LessonObject) }));
    const { h, merge } = await twoSides(withEmbed, set('open', 'popup'), set('show', 'live'));
    expect(obj(h.page('a'), 'e')!.presentation).toEqual({ open: 'popup', show: 'live' });
    expect(merge.report.notes).toEqual([]);
  });

  it('one deletes an object the other edited: the edit is kept and reported', async () => {
    const del = (l: Lesson) => edit(l, 'a', (p) => ({ ...p, objects: p.objects.filter((o) => o.id !== 'a1') }));
    const first = await twoSides(base3(), del, moveObj('a1', 321));
    expect(obj(first.h.page('a'), 'a1')!.x).toBe(321);
    expect(first.merge.report.notes).toEqual([expect.objectContaining({ object: 'a1', rule: 'deleted-vs-edited-kept', by: 'mine' })]);
    const second = await twoSides(base3(), moveObj('a1', 321), del);
    expect(obj(second.h.page('a'), 'a1')!.x).toBe(321);
    expect(second.merge.report.notes).toEqual([expect.objectContaining({ object: 'a1', rule: 'deleted-vs-edited-kept', by: 'theirs' })]);
  });

  it('both delete the same object: it is gone, no note', async () => {
    const del = (l: Lesson) => edit(l, 'a', (p) => ({ ...p, objects: p.objects.filter((o) => o.id !== 'a1') }));
    const r = await twoSides(base3(), del, del);
    expect(r.h.page('a').objects.map((o) => o.id)).toEqual(['a2']);
    expect(r.merge.report.notes).toEqual([]);
  });

  it('one deletes a page the other edited: the page stays with the edit', async () => {
    const delPage = (l: Lesson) => ({ ...l, pages: l.pages.filter((p) => p.id !== 'b') });
    const editB = (l: Lesson) => edit(l, 'b', (p) => ({ ...p, objects: [text('b1', 'kept')] }));
    const r = await twoSides(base3(), delPage, editB);
    expect(ids((await r.h.lesson()).pages)).toContain('b');
    expect(r.h.page('b').objects[0]).toMatchObject({ text: 'kept' });
    expect(r.merge.report.notes.map((n) => n.rule)).toContain('deleted-vs-edited-kept');
    const r2 = await twoSides(base3(), editB, delPage); // the other way round
    expect(r2.h.page('b').objects[0]).toMatchObject({ text: 'kept' });
    expect(r2.merge.report.notes.map((n) => n.rule)).toContain('deleted-vs-edited-kept');
  });

  it('a page deleted by one side and untouched by the other is deleted', async () => {
    const delPage = (l: Lesson) => ({ ...l, pages: l.pages.filter((p) => p.id !== 'c') });
    const r = await twoSides(base3(), moveObj('a1', 1), delPage);
    expect(ids((await r.h.lesson()).pages)).toEqual(['a', 'b']);
    expect(r.merge.report.notes).toEqual([]);
  });

  it('both insert pages at the same spot: both land, the earlier save first', async () => {
    const ins = (id: string) => (l: Lesson) => ({ ...l, pages: [l.pages[0]!, page(id, [text(`${id}1`)]), ...l.pages.slice(1)] });
    const r = await twoSides(base3(), ins('x'), ins('y'));
    expect(ids((await r.h.lesson()).pages)).toEqual(['a', 'x', 'y', 'b', 'c']);
  });

  it('both reorder: a page both moved takes the last saver\'s place; pages only one side moved keep that side\'s', async () => {
    const five = () => lessonOf(['a', 'b', 'c', 'd', 'e'].map((id) => page(id, [text(`${id}1`)])));
    const pick = (order: string) => (l: Lesson) => ({ ...l, pages: order.split('').map((id) => l.pages.find((p) => p.id === id)!) });
    const both = await twoSides(five(), pick('eabcd'), pick('abecd')); // both moved e: to the front, and after b
    expect(ids((await both.h.lesson()).pages)).toEqual(['a', 'b', 'e', 'c', 'd']);
    expect(both.merge.report.notes).toEqual([expect.objectContaining({ page: 'e', rule: 'order-both-moved', by: 'mine' })]);
    // different pages moved by each side: both moves land
    const apart = await twoSides(five(), pick('eabcd'), pick('abdce'));
    const order = ids((await apart.h.lesson()).pages);
    expect(order.indexOf('e')).toBeLessThan(order.indexOf('a')); // theirs: e first
    expect(order.indexOf('d')).toBeLessThan(order.indexOf('c')); // mine: d before c
    // only one side moves: its order lands whole
    const only = await twoSides(base3(), moveObj('a1', 4), (l) => ({ ...l, pages: [l.pages[1]!, l.pages[0]!, l.pages[2]!] }));
    expect(ids((await only.h.lesson()).pages)).toEqual(['b', 'a', 'c']);
    expect(only.merge.report.notes).toEqual([]);
  });

  it('one replaces a page\'s picture, the other adds an object: both land, and the text layer is cleared', async () => {
    const withLayer = lessonOf([page('a', [text('a1')], { textLayer: [{ text: 'old', x: 1, y: 2, width: 3, fontSize: 4 }], background: { type: 'image', assetId: 'sha256:' + '0'.repeat(64) } })]);
    const replace = (l: Lesson) => edit(l, 'a', (p) => ({ ...p, background: { type: 'image', assetId: 'sha256:' + '1'.repeat(64) } as LessonPage['background'] }));
    const addObj = (l: Lesson) => edit(l, 'a', (p) => ({ ...p, objects: [...p.objects, text('a9')] }));
    const r = await twoSides(withLayer, replace, addObj);
    const p = r.h.page('a');
    expect((p.background as { assetId: string }).assetId).toBe('sha256:' + '1'.repeat(64));
    expect(p.objects.map((o) => o.id)).toEqual(['a1', 'a9']);
    expect(p.textLayer).toBeUndefined();
    // reported by the save that replaced the picture; the other save finds the layer already gone
    expect(r.firstSave.merge.report.notes.map((n) => n.rule)).toContain('background-replaced-text-cleared');
    expect(r.h.text!.pages.a?.some((t) => t.text === 'old')).toBeFalsy();
  });

  it('a page the host deleted and the editor edited comes back, with the editor\'s edit', async () => {
    const h = await Host.open(base3());
    const e = await h.editor();
    await h.save(createPatch(e, { ...e.lesson, pages: e.lesson.pages.filter((p) => p.id !== 'c') }));
    expect(ids((await h.lesson()).pages)).toEqual(['a', 'b']);
    const m = await h.save(createPatch(e, edit(e.lesson, 'c', (p) => ({ ...p, title: 'Mine' }))));
    expect(ids((await h.lesson()).pages)).toEqual(['a', 'b', 'c']);
    expect(h.page('c').title).toBe('Mine');
    expect(m.merge.report.notes.map((n) => n.rule)).toContain('deleted-vs-edited-kept');
  });

  it('the book title: the last saver wins, and a conflict is reported', async () => {
    const t = (s: string) => (l: Lesson) => ({ ...l, title: s });
    const r = await twoSides(base3(), t('From A'), t('From B'));
    expect(r.h.index.title).toBe('From B');
    expect(r.merge.report.notes).toEqual([expect.objectContaining({ property: 'title', loser: 'From A' })]);
    const one = await twoSides(base3(), t('From A'), moveObj('a1', 3));
    expect(one.h.index.title).toBe('From A');
  });

  it('a mismatching version id is only a fast path: the merge decides', async () => {
    const h = await Host.open(base3());
    const e = await h.editor();
    const patch = createPatch({ ...e, version: 'sha256:' + 'f'.repeat(64) }, edit(e.lesson, 'a', (p) => ({ ...p, title: 'Z' })));
    await h.save(patch);
    expect(h.page('a').title).toBe('Z');
  });

  it('snip pages are merged and ordered like pages', async () => {
    const lesson = lessonOf([page('a', [text('a1')])], [page('s1', [text('s11')]), page('s2', [text('s21')])]);
    const h = await Host.open(lesson);
    const e = await h.editor();
    const mine = { ...e.lesson, snipPages: [e.lesson.snipPages[1]!, { ...e.lesson.snipPages[0]!, title: 'Snip one' }] };
    await h.save(createPatch(e, mine));
    const l = await h.lesson();
    expect(ids(l.snipPages)).toEqual(['s2', 's1']);
    expect(l.snipPages[1]!.title).toBe('Snip one');
    expect(h.index.snipPages![0]!.file).toMatch(/^snips\//);
  });

  it('a page that changed in the store but was not supplied is an error, not a silent overwrite', async () => {
    const h = await Host.open(base3());
    const e = await h.editor();
    await h.save(createPatch(e, edit(e.lesson, 'a', (p) => ({ ...p, title: 'Theirs' }))));
    const patch = createPatch(e, edit(e.lesson, 'a', (p) => ({ ...p, title: 'Mine' })));
    expect(() => mergeBook(patch, { index: h.index, pages: new Map() })).toThrow(/pagesNeeded/);
    expect(pagesNeeded(patch, h.index)).toEqual(['a']);
  });

  it('pagesNeeded asks for every page the patch touches that the store has, whatever hash the patch claims', async () => {
    const h = await Host.open(base3());
    const e = await h.editor();
    await h.save(createPatch(e, edit(e.lesson, 'a', (p) => ({ ...p, title: 'Theirs' }))));
    const patch = createPatch(e, edit(edit(e.lesson, 'a', (p) => ({ ...p, title: 'Mine' })), 'b', (p) => ({ ...p, title: 'Mine b' })));
    expect(pagesNeeded(patch, h.index).sort()).toEqual(['a', 'b']);
    const withNew = createPatch(e, { ...e.lesson, pages: [...e.lesson.pages, page('fresh')] });
    expect(pagesNeeded(withNew, h.index)).toEqual([]); // a page the store does not have is not read
  });
});

describe('applyStreamPatch: media and checks', () => {
  it('carries new media under its content name and lists it in the index', async () => {
    const h = await Host.open(base3());
    const e = await h.editor();
    const bytes = new Uint8Array([5, 6, 7, 8, 9]);
    const key = await assetKey(bytes);
    const mine = edit(e.lesson, 'a', (p) => ({ ...p, objects: [...p.objects, { id: 'img', type: 'image', x: 0, y: 0, width: 10, height: 10, assetId: key } as LessonObject] }));
    const m = await h.save(createPatch(e, mine, [{ id: key, type: 'image/png' }]), new Map([[key, { type: 'image/png', bytes }]]));
    const entry = h.index.assets.find((a) => a.id === key)!;
    expect(entry).toMatchObject({ type: 'image/png', size: 5, path: `assets/${key.replace(':', '_')}` });
    expect(h.files.get(entry.path!)).toEqual(bytes);
    expect(m.written).toContain(entry.path);
    expect(h.index.pages.find((p) => p.id === 'a')!.assets).toContain(key);
  });

  it('refuses media whose bytes are not what their key says, and writes nothing', async () => {
    const h = await Host.open(base3());
    const e = await h.editor();
    const key = await assetKey(new Uint8Array([1, 1, 1]));
    const mine = edit(e.lesson, 'a', (p) => ({ ...p, objects: [...p.objects, { id: 'img', type: 'image', x: 0, y: 0, width: 10, height: 10, assetId: key } as LessonObject] }));
    const before = new Map(h.files);
    await expect(h.save(createPatch(e, mine), new Map([[key, { type: 'image/png', bytes: new Uint8Array([2, 2, 2]) }]]))).rejects.toThrow(/does not match/);
    expect(h.files).toEqual(before);
  });

  it('a referenced asset nobody carries becomes an external entry', async () => {
    const h = await Host.open(base3());
    const e = await h.editor();
    const key = await assetKey(new Uint8Array([4, 4]));
    const mine = edit(e.lesson, 'a', (p) => ({ ...p, objects: [...p.objects, { id: 'img', type: 'image', x: 0, y: 0, width: 10, height: 10, assetId: key } as LessonObject] }));
    await h.save(createPatch(e, mine));
    expect(h.index.assets.find((a) => a.id === key)).toMatchObject({ id: key });
    expect(h.index.assets.find((a) => a.id === key)!.path).toBeUndefined();
  });

  it('assertContentNamedFiles checks the file name, whatever id led to it', async () => {
    const good = new Uint8Array([1, 2, 3]);
    const digest = (await assetKey(good)).slice(3);
    await expect(assertContentNamedFiles(new Map([[`assets/c1_${digest}`, good]]))).resolves.toBeUndefined();
    await expect(assertContentNamedFiles(new Map([[`assets/c1_${digest}`, new Uint8Array([9])]]))).rejects.toThrow(/name says/);
    await expect(assertContentNamedFiles(new Map([[`assets/sha256_${'0'.repeat(64)}`, good]]))).rejects.toThrow(/name says/);
    await expect(assertContentNamedFiles(new Map([['assets/cover.png', good]]))).resolves.toBeUndefined();
  });

  it('the page files it writes are named by their content', async () => {
    const h = await Host.open(base3());
    const e = await h.editor();
    await h.save(createPatch(e, edit(e.lesson, 'a', (p) => ({ ...p, title: 'Named' }))));
    for (const p of h.index.pages) {
      const bytes = h.files.get(p.file)!;
      const hex = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer))].slice(0, 4).map((b) => b.toString(16).padStart(2, '0')).join('');
      expect(fileHash(p.file)).toBe(hex);
    }
  });
});

describe('review findings, round 1 (container)', () => {
  const png = new Uint8Array([7, 7, 7, 7]);
  const img = (id: string, assetId: string) => ({ id, type: 'image', x: 0, y: 0, width: 10, height: 10, assetId }) as LessonObject;

  it('a picture replaced on a page the host has not touched clears the text layer at once, and replaying the patch is a no-op', async () => {
    const old = 'sha256:' + '0'.repeat(64), fresh = 'sha256:' + '1'.repeat(64);
    const h = await Host.open(lessonOf([page('a', [text('a1')], { textLayer: [{ text: 'old', x: 1, y: 2, width: 3, fontSize: 4 }], background: { type: 'image', assetId: old } })]));
    const e = await h.editor();
    const patch = createPatch(e, edit(e.lesson, 'a', (p) => ({ ...p, background: { type: 'image', assetId: fresh } as LessonPage['background'] }))); // the editor did not clear the layer
    const first = await h.save(patch);
    expect(h.page('a').textLayer).toBeUndefined();
    expect(first.merge.report.notes.map((n) => n.rule)).toContain('background-replaced-text-cleared');
    expect(h.text?.pages.a?.some((t) => t.text === 'old')).toBeFalsy();
    const again = await h.save(patch); // replayed
    expect(again.merge.noop).toBe(true);
    expect(again.result.unchanged).toBe(true);
  });

  it('pages and objects whose ids are __proto__ or constructor keep their edits (own properties, not prototypes)', async () => {
    const h = await Host.open(lessonOf([page('__proto__', [text('constructor', 'one'), text('o2')]), page('b', [text('b1')])]));
    const e = await h.editor();
    const mine = edit(e.lesson, '__proto__', (p) => ({ ...p, title: 'Edited', objects: p.objects.map((o) => (o.id === 'constructor' ? ({ ...o, text: 'two' } as LessonObject) : o)) }));
    const patch = JSON.parse(JSON.stringify(createPatch(e, mine))) as BookPatch; // as it travels
    expect(Object.keys(patch.mine.pages)).toEqual(['__proto__']);
    expect(Object.keys(patch.base.pages)).toEqual(['__proto__']);
    const m = await h.save(patch);
    expect(h.page('__proto__').title).toBe('Edited');
    expect(obj(h.page('__proto__'), 'constructor')!.text).toBe('two');
    expect(Object.keys(m.result.pages)).toEqual(['__proto__']);
    expect(({} as Record<string, unknown>).title).toBeUndefined(); // nothing leaked onto Object.prototype
  });

  it('a patch that claims the store\'s hash for a stale base does not overwrite what the store has', async () => {
    const h = await Host.open(base3());
    const e = await h.editor();
    const theirs = edit(e.lesson, 'a', (p) => ({ ...p, objects: p.objects.map((o) => (o.id === 'a1' ? ({ ...o, x: 111 } as LessonObject) : o)) }));
    await h.save(createPatch(e, theirs));
    const stale = createPatch(e, edit(e.lesson, 'a', (p) => ({ ...p, objects: p.objects.map((o) => (o.id === 'a2' ? ({ ...o, x: 222 } as LessonObject) : o)) })));
    stale.base.pages.a!.hash = h.index.pages.find((p) => p.id === 'a')!.file.match(/-([0-9a-f]{8})\.json$/)![1]!; // the lie: the store's current hash
    await h.save(stale);
    expect(obj(h.page('a'), 'a1')!.x).toBe(111); // the other person's edit survived
    expect(obj(h.page('a'), 'a2')!.x).toBe(222);
  });

  it('two inserts before the first item: the earlier save comes first (pages and objects)', async () => {
    const front = (id: string) => (l: Lesson) => ({ ...l, pages: [page(id, [text(`${id}1`)]), ...l.pages] });
    const h = await Host.open(base3());
    const e = await h.editor();
    await h.save(createPatch(e, front('x')(e.lesson)));
    await h.save(createPatch(e, front('y')(e.lesson)));
    expect(ids((await h.lesson()).pages)).toEqual(['x', 'y', 'a', 'b', 'c']);
    const h2 = await Host.open(base3());
    const e2 = await h2.editor();
    const first = (id: string) => (l: Lesson) => edit(l, 'a', (p) => ({ ...p, objects: [text(id), ...p.objects] }));
    await h2.save(createPatch(e2, first('ox')(e2.lesson)));
    await h2.save(createPatch(e2, first('oy')(e2.lesson)));
    expect(h2.page('a').objects.map((o) => o.id)).toEqual(['ox', 'oy', 'a1', 'a2']);
  });

  it('an insert after a page the host deleted stays where it was (before its next neighbour), not at the end', async () => {
    const h = await Host.open(base3());
    const e = await h.editor();
    await h.save(createPatch(e, { ...e.lesson, pages: e.lesson.pages.filter((p) => p.id !== 'a') })); // the host deletes a
    await h.save(createPatch(e, { ...e.lesson, pages: [e.lesson.pages[0]!, page('x', [text('x1')]), e.lesson.pages[1]!, e.lesson.pages[2]!] })); // mine: a, x, b, c
    expect(ids((await h.lesson()).pages)).toEqual(['x', 'b', 'c']);
  });

  it('bytes supplied for an asset the index lists as external make the entry a carried one', async () => {
    const key = await assetKey(png);
    const h = await Host.open(lessonOf([page('a', [img('i', key)])])); // no bytes: external
    expect(h.index.assets.find((a) => a.id === key)!.path).toBeUndefined();
    const e = await h.editor();
    await h.save(createPatch(e, edit(e.lesson, 'a', (p) => ({ ...p, title: 'T' })), [{ id: key, type: 'image/png' }]), new Map([[key, { type: 'image/png', bytes: png }]]));
    const entry = h.index.assets.find((a) => a.id === key)!;
    expect(entry).toMatchObject({ type: 'image/png', size: 4 });
    expect(entry.path).toBe(`assets/${key.replace(':', '_')}`);
    expect(h.files.get(entry.path!)).toEqual(png);
  });

  it('replaying a patch that carries media is a no-op too', async () => {
    const key = await assetKey(png);
    const h = await Host.open(base3());
    const e = await h.editor();
    const patch = createPatch(e, edit(e.lesson, 'a', (p) => ({ ...p, objects: [...p.objects, img('i', key)] })), [{ id: key, type: 'image/png' }]);
    const media = new Map([[key, { type: 'image/png', bytes: png }]]);
    await h.save(patch, media);
    const version = h.version, idx = h.index;
    const again = await h.save(patch, media);
    expect(again.result.unchanged).toBe(true);
    expect(again.written).toEqual([]);
    expect(h.version).toBe(version);
    expect(h.index.updatedAt).toBe(idx.updatedAt);
  });

  it('says which assets it took out of the index, so the editor sends their bytes again if it uses them again', async () => {
    const key = await assetKey(png);
    const h = await Host.open(lessonOf([page('a', [img('i', key)])]), new Map([[key, { type: 'image/png', bytes: png }]]));
    const e = await h.editor();
    const m = await h.save(createPatch(e, edit(e.lesson, 'a', (p) => ({ ...p, objects: [] }))));
    expect(m.result.dropped).toEqual([key]);
    expect(h.index.assets.map((a) => a.id)).toEqual([]);
  });
});
