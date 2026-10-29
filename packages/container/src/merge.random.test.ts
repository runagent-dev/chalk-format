import { describe, expect, it } from 'vitest';
import type { Lesson, LessonObject, LessonPage } from '@chalk-format/model';
import { assembleStreamed, createPatch, pageText, parseStreamIndex } from './index.js';
import { Host, lessonOf, page, text } from './__fixtures__/patch-host.js';

/**
 * Randomised checks of the merge: a seeded generator makes two independent sets of edits to one book (A saves first, then B, both from the same
 * base), and they are applied through a real host (read what is needed, merge, apply, write). Each seed is a reproducible case; a failure names it.
 */

const rng = (seed: number) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
type R = () => number;
const int = (r: R, n: number) => Math.floor(r() * n);
const pick = <T,>(r: R, xs: readonly T[]): T => xs[int(r, xs.length)]!;

const PROPS = ['x', 'y', 'text', 'fontSize', 'fill'] as const;
const valueFor = (r: R, k: (typeof PROPS)[number]): unknown => (k === 'text' ? `t${int(r, 1000)}` : k === 'fill' ? `#${int(r, 0xffffff).toString(16).padStart(6, '0')}` : int(r, 1000));

function baseLesson(r: R): Lesson {
  const n = 3 + int(r, 4);
  return lessonOf(Array.from({ length: n }, (_, i) => page(`p${i}`, Array.from({ length: 2 + int(r, 4) }, (_, j) => text(`p${i}o${j}`, `w${int(r, 100)}`, { x: int(r, 500), y: int(r, 500) })))));
}

type Ops = { props?: boolean; addObj?: boolean; delObj?: boolean; moveObj?: boolean; title?: boolean; addPage?: boolean; delPage?: boolean; movePage?: boolean };
const ALL: Required<Ops> = { props: true, addObj: true, delObj: true, moveObj: true, title: true, addPage: true, delPage: true, movePage: true };

/** `count` random edits by the side `side` (its new ids are prefixed with it), restricted to `pages` and the operations in `ops`. */
function randomEdits(r: R, l: Lesson, side: string, count: number, ops: Ops = ALL, pages?: ReadonlySet<string>): Lesson {
  let n = 0;
  const fresh = (what: string) => `${side}${what}${n++}`;
  let cur = l;
  const choices = (Object.keys(ops) as (keyof Ops)[]).filter((k) => ops[k]);
  const eligible = () => cur.pages.filter((p) => !pages || pages.has(p.id));
  for (let i = 0; i < count; i++) {
    const op = pick(r, choices);
    const ps = eligible();
    const edit = (id: string, fn: (p: LessonPage) => LessonPage) => { cur = { ...cur, pages: cur.pages.map((p) => (p.id === id ? fn(p) : p)) }; };
    if (op === 'addPage') {
      const at = int(r, cur.pages.length + 1);
      cur = { ...cur, pages: [...cur.pages.slice(0, at), page(fresh('P'), [text(fresh('o'))]), ...cur.pages.slice(at)] };
      continue;
    }
    if (op === 'delPage') { if (cur.pages.length > 1 && ps.length) { const p = pick(r, ps); cur = { ...cur, pages: cur.pages.filter((x) => x.id !== p.id) }; } continue; }
    if (op === 'movePage') { if (cur.pages.length > 1) { const from = int(r, cur.pages.length), to = int(r, cur.pages.length); const ids = [...cur.pages]; const [m] = ids.splice(from, 1); ids.splice(to, 0, m!); cur = { ...cur, pages: ids }; } continue; }
    if (!ps.length) continue;
    const p = pick(r, ps);
    if (op === 'title') edit(p.id, (x) => ({ ...x, title: `T${int(r, 1000)}` }));
    else if (op === 'addObj') edit(p.id, (x) => { const at = int(r, x.objects.length + 1); return { ...x, objects: [...x.objects.slice(0, at), text(fresh('o'), 'new', { x: int(r, 500) }), ...x.objects.slice(at)] }; });
    else if (op === 'delObj') edit(p.id, (x) => (x.objects.length ? { ...x, objects: x.objects.filter((_, j) => j !== int(r, x.objects.length)) } : x));
    else if (op === 'moveObj') edit(p.id, (x) => { if (x.objects.length < 2) return x; const o = [...x.objects]; const [m] = o.splice(int(r, o.length), 1); o.splice(int(r, o.length + 1), 0, m!); return { ...x, objects: o }; });
    else if (op === 'props') edit(p.id, (x) => { if (!x.objects.length) return x; const j = int(r, x.objects.length), k = pick(r, PROPS); return { ...x, objects: x.objects.map((o, q) => (q === j ? ({ ...o, [k]: valueFor(r, k) } as LessonObject) : o)) }; });
  }
  return cur;
}

const objs = (p: LessonPage | undefined) => new Map((p?.objects ?? []).map((o) => [o.id, o as unknown as Record<string, unknown>]));
const allIds = (l: Lesson) => new Set(l.pages.flatMap((p) => p.objects.map((o) => o.id)));
const SEEDS = Array.from({ length: 250 }, (_, i) => i + 1);

/** Sets one property of one object, if that side still has it. */
const setProp = (l: Lesson, pageId: string, objId: string, k: string, v: unknown): Lesson =>
  ({ ...l, pages: l.pages.map((p) => (p.id === pageId ? { ...p, objects: p.objects.map((o) => (o.id === objId ? ({ ...o, [k]: v } as LessonObject) : o)) } : p)) });

async function run(seed: number, opts: { force?: boolean } = {}) {
  const r = rng(seed);
  const l0 = baseLesson(r);
  const h = await Host.open(l0);
  const e = await h.editor();
  let la = randomEdits(r, e.lesson, 'A', 1 + int(r, 6));
  let lb = randomEdits(r, e.lesson, 'B', 1 + int(r, 6));
  if (opts.force) {
    // both sides set the same property of the same object, to different values: a real conflict, on a quarter of the seeds
    const target = pick(r, e.lesson.pages);
    const o = pick(r, target.objects);
    const k = pick(r, PROPS);
    if (r() < 0.75) { la = setProp(la, target.id, o.id, k, valueFor(r, k)); lb = setProp(lb, target.id, o.id, k, valueFor(r, k)); }
  }
  const first = await h.save(createPatch(e, la));
  const second = await h.save(createPatch(e, lb));
  return { h, e, l0: e.lesson, la, lb, first, second, final: await h.lesson() };
}

// 250 seeded cases each: heavy by design, so they get room when the whole repo's checks run in parallel (vitest's default is 5 s)
describe('mergeBook, randomised: two editors from one base', { timeout: 60_000 }, () => {
  it('never loses an object or a page either side added', async () => {
    for (const seed of SEEDS) {
      const { l0, la, lb, final } = await run(seed);
      const finalIds = allIds(final);
      const baseIds = allIds(l0);
      for (const [name, side] of [['A', la], ['B', lb]] as const) {
        for (const id of allIds(side)) if (!baseIds.has(id)) expect(finalIds.has(id), `seed ${seed}: ${name}'s object ${id} was lost`).toBe(true);
        for (const p of side.pages) if (!l0.pages.some((x) => x.id === p.id)) expect(final.pages.some((x) => x.id === p.id), `seed ${seed}: ${name}'s page ${p.id} was lost`).toBe(true);
      }
    }
  });

  it('every property edit survives, or is reported with the value that lost (last saver wins)', async () => {
    let conflicts = 0;
    for (const seed of SEEDS) {
      const { l0, la, lb, final, second } = await run(seed, { force: true });
      for (const p0 of l0.pages) {
        const pa = la.pages.find((x) => x.id === p0.id), pb = lb.pages.find((x) => x.id === p0.id), pf = final.pages.find((x) => x.id === p0.id);
        if (!pa || !pb || !pf) continue; // a page one side deleted: covered by the next test
        const o0 = objs(p0), oa = objs(pa), ob = objs(pb), of = objs(pf);
        for (const [id, base] of o0) {
          const a = oa.get(id), b = ob.get(id), f = of.get(id);
          if (!a || !b) continue; // deleted by a side: covered below
          expect(f, `seed ${seed}: ${id} vanished`).toBeDefined();
          for (const k of PROPS) {
            const want = b[k] !== base[k] ? b[k] : a[k] !== base[k] ? a[k] : base[k];
            expect(f![k], `seed ${seed}: ${id}.${k}`).toEqual(want);
            if (a[k] !== base[k] && b[k] !== base[k] && a[k] !== b[k]) {
              conflicts++;
              expect(second.merge.report.notes.some((n) => n.object === id && n.property === k && n.rule === 'same-property-last-saver' && n.loser === a[k]), `seed ${seed}: the conflict on ${id}.${k} is not reported`).toBe(true);
            }
          }
        }
      }
      // page titles the same way
      for (const p0 of l0.pages) {
        const pa = la.pages.find((x) => x.id === p0.id), pb = lb.pages.find((x) => x.id === p0.id), pf = final.pages.find((x) => x.id === p0.id);
        if (!pa || !pb || !pf) continue;
        expect(pf.title, `seed ${seed}: title of ${p0.id}`).toBe(pb.title !== p0.title ? pb.title : pa.title !== p0.title ? pa.title : p0.title);
      }
    }
    expect(conflicts, 'the generator never produced a conflict: the test checks nothing').toBeGreaterThan(5);
  });

  it('a delete against an edit keeps the edit; a delete against no edit deletes', async () => {
    let kept = 0, gone = 0;
    for (const seed of SEEDS) {
      const { l0, la, lb, final, first, second } = await run(seed);
      for (const p0 of l0.pages) {
        const pa = la.pages.find((x) => x.id === p0.id), pb = lb.pages.find((x) => x.id === p0.id), pf = final.pages.find((x) => x.id === p0.id);
        if (!pa || !pb) continue;
        const o0 = objs(p0), oa = objs(pa), ob = objs(pb), of = objs(pf);
        for (const [id, base] of o0) {
          const a = oa.get(id), b = ob.get(id);
          const changed = (x: Record<string, unknown>) => JSON.stringify(x) !== JSON.stringify(base);
          if (!a && b) { if (changed(b)) { kept++; expect(of.has(id), `seed ${seed}: B's edit of ${id} was dropped by A's delete`).toBe(true); } else { gone++; expect(of.has(id), `seed ${seed}: ${id} should be deleted`).toBe(false); } }
          if (a && !b) { if (changed(a)) { kept++; expect(of.has(id), `seed ${seed}: A's edit of ${id} was dropped by B's delete`).toBe(true); } else { gone++; expect(of.has(id), `seed ${seed}: ${id} should be deleted`).toBe(false); } }
        }
      }
      void first; void second;
    }
    expect(kept).toBeGreaterThan(3);
    expect(gone).toBeGreaterThan(3);
  });

  it('a page deleted by one side is deleted unless the other side edited it', async () => {
    let kept = 0, gone = 0;
    for (const seed of SEEDS) {
      const { l0, la, lb, final } = await run(seed);
      const has = (l: Lesson, id: string) => l.pages.some((p) => p.id === id);
      for (const p0 of l0.pages) {
        const edited = (l: Lesson) => JSON.stringify(l.pages.find((p) => p.id === p0.id)) !== JSON.stringify(p0);
        if (has(la, p0.id) && has(lb, p0.id)) continue;
        if (!has(la, p0.id) && !has(lb, p0.id)) { expect(has(final, p0.id), `seed ${seed}: ${p0.id} deleted by both`).toBe(false); continue; }
        const survivor = has(la, p0.id) ? la : lb;
        if (edited(survivor)) { kept++; expect(has(final, p0.id), `seed ${seed}: edited page ${p0.id} was lost`).toBe(true); }
        else if (final.pages.length > 1) { gone++; expect(has(final, p0.id), `seed ${seed}: page ${p0.id} should be deleted`).toBe(false); }
      }
      expect(final.pages.length, `seed ${seed}: an empty book`).toBeGreaterThan(0);
    }
    expect(kept).toBeGreaterThan(3);
    expect(gone).toBeGreaterThan(3);
  });

  it('applying the second patch again changes nothing more (idempotent)', async () => {
    for (const seed of SEEDS) {
      const { h, e, lb, final } = await run(seed);
      const index = h.index;
      const again = await h.save(createPatch(e, lb));
      expect(again.merge.noop, `seed ${seed}: the patch was not idempotent`).toBe(true);
      expect(await h.lesson()).toEqual(final);
      expect(h.index.pages).toEqual(index.pages);
    }
  });

  it('what is stored is always a valid, self-consistent book', async () => {
    for (const seed of SEEDS) {
      const { h, final } = await run(seed);
      const index = parseStreamIndex(JSON.parse(new TextDecoder().decode(h.files.get('book.json')!)));
      expect(new Set(index.pages.map((p) => p.id)).size).toBe(index.pages.length);
      expect(index.pages.map((p) => p.id), `seed ${seed}`).toEqual(final.pages.map((p) => p.id));
      for (const e of index.pages) expect(h.files.has(e.file), `seed ${seed}: ${e.file} is missing`).toBe(true);
      // the search text lists exactly the pages that have text
      const withText = final.pages.filter((p) => pageText(p).length).map((p) => p.id).sort();
      expect(Object.keys(h.text?.pages ?? {}).sort(), `seed ${seed}: the search file`).toEqual(withText);
      await assembleStreamed(async (p) => h.files.get(p)!); // reads back without error
    }
  });

  it('edits to different pages commute: the order of saving does not matter', async () => {
    for (const seed of SEEDS) {
      const r = rng(seed * 7919);
      const l0 = baseLesson(r);
      const ids = l0.pages.map((p) => p.id);
      const mid = Math.max(1, Math.floor(ids.length / 2));
      const A = new Set(ids.slice(0, mid)), B = new Set(ids.slice(mid));
      const structural = { props: true, addObj: true, delObj: true, moveObj: true, title: true } satisfies Ops;
      const run1 = async (firstSide: 'A' | 'B') => {
        const h = await Host.open(l0);
        const e = await h.editor();
        const rr = rng(seed * 31);
        const la = randomEdits(rr, e.lesson, 'A', 1 + int(rr, 6), structural, A);
        const lb = randomEdits(rr, e.lesson, 'B', 1 + int(rr, 6), structural, B);
        const order = firstSide === 'A' ? [la, lb] : [lb, la];
        for (const l of order) await h.save(createPatch(e, l));
        return h.lesson();
      };
      expect(await run1('A'), `seed ${seed}`).toEqual(await run1('B'));
    }
  });

  it('edits to different objects of the same pages commute too', async () => {
    for (const seed of SEEDS) {
      const r = rng(seed * 104729);
      const l0 = baseLesson(r);
      const build = async (firstSide: 'A' | 'B') => {
        const h = await Host.open(l0);
        const e = await h.editor();
        const rr = rng(seed * 17);
        // A edits properties of objects with an even index, B of those with an odd index, on all pages
        const edits = (parity: number): Lesson => ({ ...e.lesson, pages: e.lesson.pages.map((p) => ({ ...p, objects: p.objects.map((o, j) => { if (j % 2 !== parity || rr() >= 0.7) return o; const k = pick(rr, PROPS); return { ...o, [k]: valueFor(rr, k) } as LessonObject; }) })) });
        const la = edits(0), lb = edits(1);
        for (const l of firstSide === 'A' ? [la, lb] : [lb, la]) await h.save(createPatch(e, l));
        return h.lesson();
      };
      expect(await build('A'), `seed ${seed}`).toEqual(await build('B'));
    }
  });

  it('a patch is as small as the change: only changed pages travel', async () => {
    for (const seed of SEEDS.slice(0, 60)) {
      const r = rng(seed);
      const l0 = baseLesson(r);
      const h = await Host.open(l0);
      const e = await h.editor();
      const target = pick(r, l0.pages).id;
      const mine = randomEdits(r, e.lesson, 'A', 1 + int(r, 3), { props: true, addObj: true, title: true }, new Set([target]));
      const patch = createPatch(e, mine);
      expect(Object.keys(patch.mine.pages).every((id) => id === target), `seed ${seed}`).toBe(true);
      expect(Object.keys(patch.base.pages).every((id) => id === target)).toBe(true);
      const { written } = await h.save(patch);
      expect(written.filter((f) => f.startsWith('pages/')).length).toBeLessThanOrEqual(1);
    }
  });

  it('keeps one page when the two sides between them would delete them all', async () => {
    const h = await Host.open(lessonOf([page('a', [text('a1')]), page('b', [text('b1')])]));
    const e = await h.editor();
    await h.save(createPatch(e, { ...e.lesson, pages: [e.lesson.pages[0]!] })); // A deletes b
    const m = await h.save(createPatch(e, { ...e.lesson, pages: [e.lesson.pages[1]!] })); // B deletes a (keeps b): untouched pages go, but never the last
    const pages = (await h.lesson()).pages;
    expect(pages.length).toBeGreaterThan(0);
    expect(m.merge.report.notes.some((n) => n.rule === 'last-page-kept') || pages.some((p) => p.id === 'b')).toBe(true);
  });
});
