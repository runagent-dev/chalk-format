import { mergeLessonPage, type BookPatch, type PatchResult } from '@chalk-format/container';
import type { Lesson, LessonPage } from '@chalk-format/model';

/**
 * What the editor keeps after the host has kept a patch. Plain data in, plain data out (the hook only stores the result), so each rule is tested on
 * its own.
 *
 * - `saved`: the book as the host now has it, as far as the editor knows: what it sent, with each page the host merged with someone else's work
 *   replaced by the host's version. The next patch starts from it. A merged page the user DELETED while the save ran keeps the version that was
 *   sent: the user never saw the host's changes to it, so their delete must meet them as the conflict it is (the edit is kept), not delete them unseen.
 * - `top`: the editor's working lesson after the answer, or `null` when nothing changes there (the history is kept). A page the host merged comes
 *   back whole; where the user edited that page in the meantime (while the save ran) the two are merged here, with the same rules as the host's
 *   (`mergeLessonPage`): the host's changes and the user's new edits both stay, so neither is lost and the next patch does not undo the host's.
 *   The history then restarts at this lesson (older snapshots would undo the other person's work).
 * - `hashes`, `known`: the `hex8` of every page the host has, and the assets it has (or was sent): an asset the host dropped from the index is
 *   forgotten, so if the user brings its picture back its bytes are sent again.
 */
export function adoptedPatch(o: {
  patch: BookPatch;
  sent: Lesson;
  top: Lesson;
  result: PatchResult;
  hashes: ReadonlyMap<string, string>;
  known: ReadonlySet<string>;
  mediaIds: Iterable<string>;
}): { saved: Lesson; top: Lesson | null; hashes: Map<string, string>; known: Set<string> } {
  const hashes = new Map(o.hashes);
  for (const id of o.patch.mine.deleted) hashes.delete(id);
  for (const [id, w] of Object.entries(o.result.pages)) hashes.set(id, w.hash);
  const known = new Set(o.known);
  for (const id of o.mediaIds) known.add(id);
  for (const id of o.result.dropped ?? []) known.delete(id);
  for (const a of o.result.assets ?? []) known.add(a.id); // media someone else added, in a page the host merged

  const merged = new Map(Object.entries(o.result.pages).flatMap(([id, w]) => (w.page ? [[id, w.page] as [string, LessonPage]] : [])));
  if (!merged.size) return { saved: o.sent, top: null, hashes, known };
  const swap = (l: Lesson, pick: (p: LessonPage) => LessonPage): Lesson => ({ ...l, pages: l.pages.map(pick), snipPages: l.snipPages.map(pick) });
  const stillThere = new Set([...o.top.pages, ...o.top.snipPages].map((p) => p.id));
  const saved = swap(o.sent, (p) => (o.top === o.sent || stillThere.has(p.id) ? merged.get(p.id) : undefined) ?? p);
  if (o.top === o.sent) return { saved, top: saved, hashes, known };
  const sentPages = new Map([...o.sent.pages, ...o.sent.snipPages].map((p) => [p.id, p]));
  const top = swap(o.top, (p) => {
    const m = merged.get(p.id);
    if (!m) return p;
    const was = sentPages.get(p.id);
    return !was || p === was ? m : mergeLessonPage(was, p, m).page; // edited since the click: the user's new edits on top of the host's merged page
  });
  return { saved, top, hashes, known };
}

/**
 * The assets a patch must carry: those a changed page uses that the host does not have the bytes of. One the host lists as external (no file) is
 * left external, as in a whole-book save, unless the editor holds the bytes itself (a local file with the same key was imported): then they are sent.
 */
export function mediaWanted(o: { referenced: readonly string[]; carried: ReadonlySet<string>; external: ReadonlySet<string>; local: (id: string) => boolean }): string[] {
  return o.referenced.filter((id) => !o.carried.has(id) && (!o.external.has(id) || o.local(id)));
}
