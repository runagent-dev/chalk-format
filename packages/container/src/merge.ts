import type { LessonObject, LessonPage, StreamPage } from '@chalk-format/model';
import { pageText } from './stream.js';
import { fileHash, sameValue, type BookPatch, type MergeNote, type MergeReport, type TheirsState } from './patch.js';

/**
 * The three-way merge of the patch save. A PURE function over plain data (no store, no clock): `mergeBook(patch, theirs)` takes what the editor
 * sends (`mine`, with the `base` it started from) and what the host has now (`theirs`), and says what the book becomes and what had to be decided.
 * The unit that is sent is a changed page; the unit that is merged is an object inside it, property by property, so two people's edits to
 * different objects, or to different properties of one object, both land. The rules (always reported):
 *   - one side changed it: that change lands; both changed it, to different values: the LAST SAVER (mine) wins and the other value is in the report;
 *   - one side deleted an object or page the other edited: the EDIT is kept;
 *   - both inserted at the same spot: both land, the earlier save first; both moved the same item: the last saver's position;
 *   - a page whose picture was replaced loses its text layer (its positions belong to the old picture).
 */

export type MergeResult = {
  /** The reading pages' ids and the snip pages' ids, in order, after the merge. */
  order: string[];
  snipOrder: string[];
  title: string;
  coverAssetId?: string;
  /** The pages whose stored form has to change: new ones and ones that differ from what the host has. */
  write: Map<string, LessonPage>;
  /** Of `write`: the ids whose page is NOT what the editor sent (someone else's work is in it). */
  merged: string[];
  /** Pages dropped from the book. */
  remove: string[];
  /** Pages whose search text changed (or that were dropped): the one text file is rewritten for these only. */
  textChanged: string[];
  report: MergeReport;
  /** Nothing to write: the book already is what the patch makes it. */
  noop: boolean;
};

type Rec = Record<string, unknown>;

const isPlain = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);

type Ctx = { notes: MergeNote[]; page: string; object?: string };

/** One value, three versions. `undefined` means absent. */
function mergeValue(b: unknown, m: unknown, t: unknown, path: string[], cx: Ctx): unknown {
  if (sameValue(m, t)) return m;
  if (sameValue(m, b)) return t;
  if (sameValue(t, b)) return m;
  if (isPlain(m) && isPlain(t) && (b === undefined || isPlain(b))) return mergeRecord((b ?? {}) as Rec, m, t, path, cx);
  cx.notes.push({ page: cx.page, ...(cx.object !== undefined ? { object: cx.object } : {}), property: path.join('.'), rule: 'same-property-last-saver', by: 'mine', loser: t });
  return m;
}

function mergeRecord(b: Rec, m: Rec, t: Rec, path: string[], cx: Ctx, skip: ReadonlySet<string> = new Set()): Rec {
  const out: Rec = {};
  const keys = [...new Set([...Object.keys(t), ...Object.keys(m), ...Object.keys(b)])];
  for (const k of keys) {
    if (skip.has(k)) continue;
    const v = mergeValue(b[k], m[k], t[k], [...path, k], cx);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** The members of one longest common subsequence of `a` and `b` (ids, no repeats). */
function lcs(a: readonly string[], b: readonly string[]): Set<string> {
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
  let ea = a.length, eb = b.length;
  while (ea > lo && eb > lo && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const keep = new Set<string>([...a.slice(0, lo), ...a.slice(ea)]);
  const A = a.slice(lo, ea), B = b.slice(lo, eb);
  if (!A.length || !B.length) return keep;
  if (A.length * B.length > 25_000_000) return keep; // absurdly large: only the stable ends count as staying
  const w = B.length + 1;
  const t = new Uint32Array((A.length + 1) * w);
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) t[i * w + j] = A[i] === B[j] ? t[(i + 1) * w + j + 1]! + 1 : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!);
  let i = 0, j = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) { keep.add(A[i]!); i++; j++; } else if (t[(i + 1) * w + j]! >= t[i * w + j + 1]!) i++; else j++;
  }
  return keep;
}

/**
 * Merges three orders of the same kind of items (page ids, or object ids for the stacking order). The result starts from `theirs`; what `mine`
 * added, re-added or moved is placed after the item that preceded it in `mine`.
 */
function mergeOrder(base: readonly string[], mine: readonly string[], theirs: readonly string[], survivors: ReadonlySet<string>, onBothMoved: (id: string) => void): string[] {
  const baseSet = new Set(base), mineSet = new Set(mine), theirsSet = new Set(theirs);
  const start = theirs.filter((id) => survivors.has(id));
  const startSet = new Set(start);
  // moved = in both lists but not part of the longest run that kept its relative order
  const bm = base.filter((id) => mineSet.has(id));
  const stayMine = lcs(bm, mine.filter((id) => baseSet.has(id)));
  const bt = base.filter((id) => theirsSet.has(id));
  const stayTheirs = lcs(bt, theirs.filter((id) => baseSet.has(id)));
  const reposition = new Set<string>();
  for (const id of bm) {
    if (stayMine.has(id) || !startSet.has(id)) continue;
    reposition.add(id);
    if (!stayTheirs.has(id)) onBothMoved(id);
  }
  for (const id of mine) if (survivors.has(id) && !startSet.has(id)) reposition.add(id); // added by mine, or edited by mine after the host deleted it
  const out = start.filter((id) => !reposition.has(id));
  for (let i = 0; i < mine.length; i++) {
    const id = mine[i]!;
    if (!reposition.has(id)) continue;
    let at = -1;
    for (let j = i - 1; j >= 0; j--) { const k = out.indexOf(mine[j]!); if (k >= 0) { at = k; break; } }
    if (at >= 0) {
      at++;
      // two inserts at the same spot: the one saved earlier (already there) comes first
      while (at < out.length && !baseSet.has(out[at]!) && !mineSet.has(out[at]!)) at++;
    } else at = i > 0 ? out.length : 0;
    out.splice(at, 0, id);
  }
  return out;
}

const byId = (list: readonly LessonObject[]) => new Map(list.map((o) => [o.id, o as unknown as Rec]));

function mergeObjects(base: readonly LessonObject[] | undefined, mine: readonly LessonObject[], theirs: readonly LessonObject[], cx: Ctx): LessonObject[] {
  const B = byId(base ?? []), M = byId(mine), T = byId(theirs);
  const result = new Map<string, Rec>();
  for (const id of new Set([...T.keys(), ...M.keys(), ...B.keys()])) {
    const b = B.get(id), m = M.get(id), t = T.get(id);
    if (m && t) result.set(id, mergeRecord(b ?? {}, m, t, [], { ...cx, object: id }));
    else if (m) {
      if (!b || !sameValue(m, b)) {
        if (b) cx.notes.push({ page: cx.page, object: id, rule: 'deleted-vs-edited-kept', by: 'mine', detail: 'deleted by someone else, edited here: the edit is kept' });
        result.set(id, m);
      }
    } else if (t) {
      if (!b || !sameValue(t, b)) {
        if (b) cx.notes.push({ page: cx.page, object: id, rule: 'deleted-vs-edited-kept', by: 'theirs', detail: 'deleted here, edited by someone else: their edit is kept' });
        result.set(id, t);
      }
    }
  }
  const order = mergeOrder(base?.map((o) => o.id) ?? [], mine.map((o) => o.id), theirs.map((o) => o.id), new Set(result.keys()), (id) =>
    cx.notes.push({ page: cx.page, object: id, rule: 'order-both-moved', by: 'mine', detail: 'both moved it: the last saver\'s place is kept' }));
  return order.map((id) => result.get(id) as unknown as LessonObject);
}

/** Three versions of one page: its properties merged one by one, its objects by id. */
function mergePage(base: LessonPage | undefined, mine: LessonPage, theirs: LessonPage, id: string, notes: MergeNote[]): LessonPage {
  const cx: Ctx = { notes, page: id };
  const props = mergeRecord((base ?? {}) as unknown as Rec, mine as unknown as Rec, theirs as unknown as Rec, [], cx, new Set(['objects']));
  const objects = mergeObjects(base?.objects, mine.objects, theirs.objects, cx);
  const page = { ...props, objects } as unknown as LessonPage;
  // a new picture makes the text positions of the old one meaningless
  if (base && !sameValue(page.background, base.background) && page.textLayer?.length) {
    delete (page as { textLayer?: unknown }).textLayer;
    notes.push({ page: id, rule: 'background-replaced-text-cleared', by: 'mine', detail: 'the page\'s picture was replaced: its text layer was cleared' });
  }
  return page;
}

const textOf = (p: LessonPage | undefined, snip: boolean) => (p && !snip ? JSON.stringify(pageText(p)) : undefined);

/**
 * What the book becomes when `patch` is applied to the book the host has (`theirs`). `theirs.pages` must hold the pages `pagesNeeded(patch,
 * theirs.index)` lists. Pure, idempotent (the same patch again changes nothing more) and, for edits that do not touch the same thing, independent
 * of which side saved first.
 */
export function mergeBook(patch: BookPatch, theirs: TheirsState): MergeResult {
  const notes: MergeNote[] = [];
  const idx = theirs.index;
  const entry = new Map<string, { e: StreamPage; snip: boolean }>([...idx.pages.map((e): [string, { e: StreamPage; snip: boolean }] => [e.id, { e, snip: false }]), ...(idx.snipPages ?? []).map((e): [string, { e: StreamPage; snip: boolean }] => [e.id, { e, snip: true }])]);
  const mineSnips = new Set(patch.mine.snipOrder ?? []), baseSnips = new Set(patch.base.snipOrder ?? []);
  const isSnip = (id: string) => entry.get(id)?.snip ?? (mineSnips.has(id) || baseSnips.has(id));

  const survivors = new Set(entry.keys());
  const write = new Map<string, LessonPage>();
  const merged: string[] = [];
  const remove: string[] = [];
  const textChanged = new Set<string>();

  for (const [id, mineP] of Object.entries(patch.mine.pages)) {
    const e = entry.get(id)?.e;
    const b = patch.base.pages[id];
    let result: LessonPage;
    let stored: LessonPage | undefined;
    if (!e) {
      if (b) notes.push({ page: id, rule: 'deleted-vs-edited-kept', by: 'mine', detail: 'the page was deleted by someone else and edited here: the edit is kept' });
      result = mineP;
      survivors.add(id);
    } else if (b && fileHash(e.file) === b.hash) {
      result = mineP; // the host has not touched it since the editor opened it
      stored = b.page;
    } else {
      const t = theirs.pages.get(id);
      if (!t) throw new Error(`page ${id} has changed in the store, but its current form was not supplied (see pagesNeeded)`);
      result = mergePage(b?.page, mineP, t, id, notes);
      stored = t;
    }
    if (!stored || !sameValue(result, stored)) {
      write.set(id, result);
      if (!sameValue(result, mineP)) merged.push(id);
      if (textOf(result, isSnip(id)) !== textOf(stored, isSnip(id)) && !isSnip(id)) textChanged.add(id);
    }
  }

  for (const id of patch.mine.deleted) {
    const e = entry.get(id)?.e;
    const b = patch.base.pages[id];
    if (!e || !b) continue; // already gone, or no base to tell whether someone edited it since: it is kept
    if (fileHash(e.file) === b.hash) { survivors.delete(id); remove.push(id); if (!isSnip(id)) textChanged.add(id); }
    else notes.push({ page: id, rule: 'deleted-vs-edited-kept', by: 'theirs', detail: 'the page was deleted here and edited by someone else: their edit is kept' });
  }

  const both = (id: string) => notes.push({ page: id, rule: 'order-both-moved', by: 'mine', detail: 'both moved this page: the last saver\'s place is kept' });
  const normal = new Set([...survivors].filter((id) => !isSnip(id)));
  const snips = new Set([...survivors].filter((id) => isSnip(id)));
  const order = mergeOrder(patch.base.order, patch.mine.order, idx.pages.map((p) => p.id), normal, both);
  const snipOrder = mergeOrder(patch.base.snipOrder ?? [], patch.mine.snipOrder ?? [], (idx.snipPages ?? []).map((p) => p.id), snips, both);

  const book = (property: string, b: unknown, m: unknown, t: unknown) => mergeValue(b, m, t, [property], { notes, page: '' });
  const title = book('title', patch.base.title, patch.mine.title ?? patch.base.title, idx.title) as string;
  const baseCover = patch.base.coverAssetId ?? undefined;
  const mineCover = patch.mine.coverAssetId === undefined ? baseCover : patch.mine.coverAssetId ?? undefined;
  const coverAssetId = book('coverAssetId', baseCover, mineCover, idx.coverAssetId) as string | undefined;

  const noop = !write.size && !remove.length && sameValue(order, idx.pages.map((p) => p.id)) && sameValue(snipOrder, (idx.snipPages ?? []).map((p) => p.id))
    && title === idx.title && coverAssetId === idx.coverAssetId;
  return { order, snipOrder, title, ...(coverAssetId ? { coverAssetId } : {}), write, merged, remove, textChanged: [...textChanged], report: { notes }, noop };
}
