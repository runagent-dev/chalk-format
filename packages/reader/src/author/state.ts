import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPatch, packLesson, pageHashes, type AssetBundle, type BookPatch, type PatchResult } from '@chalk-format/container';
import { gatherAssets } from './gather.js';
import type { SaveProgress } from './save-run.js';
import { assetKey, referencedAssetIds, type Lesson } from '@chalk-format/model';
import type { Book } from '../book.js';
import { isStreamed } from '../stream.js';
import { adoptedPatch } from './patch-state.js';

const HISTORY = 200;

/**
 * The author's working copy of a book: the edited lesson with undo (one entry per gesture), the media added in
 * this session, and a Book over both that the reader draws exactly as a student would see it.
 */
/** `bytes`: where to find media the book does not carry when saving a self-contained book (the libraries). */
export function useAuthoring(base: Book, onChange?: (lesson: Lesson) => void, o: { bytes?: Book['assetBytes'] } = {}) {
  const bytesFrom = useRef(o.bytes); bytesFrom.current = o.bytes;
  const [h, setH] = useState(() => ({ stack: [base.lesson], i: 0, gesture: null as string | null }));
  // the lesson as last saved: what "unsaved changes" compares against
  const [saved, setSaved] = useState(base.lesson);
  // a streamed book's pages arrive after it opened: follow them while nothing has been edited
  const [seenLesson, setSeenLesson] = useState(base.lesson);
  if (seenLesson !== base.lesson) {
    setSeenLesson(base.lesson);
    if (h.stack.length === 1) { setH({ stack: [base.lesson], i: 0, gesture: null }); setSaved(base.lesson); }
  }
  const lesson = h.stack[h.i]!;
  // the history as it is NOW: a save is asynchronous, and its callbacks must see what the user did while it ran
  const hNow = useRef(h); hNow.current = h;
  // media added while authoring; a version number so the derived book updates when one arrives
  const added = useRef(new Map<string, { type: string; bytes: Uint8Array; url: string }>());
  const [addedVersion, setAddedVersion] = useState(0);

  useEffect(() => () => { for (const a of added.current.values()) URL.revokeObjectURL(a.url); }, []);

  // a new book from the host (a reload, or the saved file opened again): the work starts over from it
  const seen = useRef(base);
  useEffect(() => {
    if (seen.current === base) return;
    seen.current = base;
    setH({ stack: [base.lesson], i: 0, gesture: null });
    setSaved(base.lesson);
  }, [base]);

  const book: Book = useMemo(() => {
    const own = added.current;
    return {
      ...base,
      lesson,
      assetUrl: (id) => { const a = own.get(id); return a ? Promise.resolve(a.url) : base.assetUrl(id); },
      peekUrl: (id) => own.get(id)?.url ?? base.peekUrl(id),
      assetBytes: (id) => { const a = own.get(id); return a ? Promise.resolve({ type: a.type, bytes: a.bytes.slice().buffer as ArrayBuffer }) : base.assetBytes(id); },
    };
  }, [base, lesson, addedVersion]);

  const first = useRef(true);
  const report = useRef(onChange); report.current = onChange;
  useEffect(() => { if (first.current) { first.current = false; return; } report.current?.(lesson); }, [lesson]);

  /** Change the lesson. Calls with the same `gesture` id as the last one amend that history entry. */
  const apply = useCallback((fn: (l: Lesson) => Lesson, gesture?: string) => {
    setH((s) => {
      const cur = s.stack[s.i]!, next = fn(cur);
      if (next === cur) return s;
      if (gesture && gesture === s.gesture) { const stack = s.stack.slice(0, s.i + 1); stack[s.i] = next; return { ...s, stack }; }
      const stack = [...s.stack.slice(0, s.i + 1), next].slice(-HISTORY);
      return { stack, i: stack.length - 1, gesture: gesture ?? null };
    });
  }, []);
  const undo = useCallback(() => setH((s) => (s.i > 0 ? { ...s, i: s.i - 1, gesture: null } : s)), []);
  const redo = useCallback(() => setH((s) => (s.i < s.stack.length - 1 ? { ...s, i: s.i + 1, gesture: null } : s)), []);

  /** Add media bytes to the book: its c1 key (spec 1.2), the same for the same bytes. */
  const addAsset = useCallback(async (bytes: Uint8Array, type: string): Promise<string> => {
    const id = await assetKey(bytes);
    if (!added.current.has(id)) {
      added.current.set(id, { type, bytes, url: URL.createObjectURL(new Blob([bytes as BlobPart], { type })) });
      setAddedVersion((v) => v + 1);
    }
    return id;
  }, []);

  /**
   * The book as a .chalk file: every asset it uses that is at hand is carried; others stay external. It is not
   * marked saved here: call `markSaved(lesson)` once the file is really kept (the host's upload may fail).
   */
  const save = useCallback(async (progress?: (p: SaveProgress) => void): Promise<{ bytes: Uint8Array; lesson: Lesson }> => {
    const got = await gatherAssets({
      ids: referencedAssetIds(lesson),
      held: (id) => { const a = added.current.get(id); return a ? { type: a.type, bytes: a.bytes } : undefined; },
      fetchOne: async (id) => { const b = await (bytesFrom.current ?? base.assetBytes)(id); return b ? { type: b.type, bytes: new Uint8Array(b.bytes) } : null; },
      progress,
    });
    const bundle: AssetBundle = new Map(got);
    progress?.({ phase: 'packing' });
    const bytes = await packLesson({ ...lesson, updatedAt: new Date().toISOString() }, bundle);
    return { bytes, lesson };
  }, [lesson, base]);
  const markSaved = useCallback((l: Lesson) => setSaved(l), []);

  // ---- the patch save (a streamed book whose host takes patches): only what changed is sent
  /** The version id and the `hex8` of every page the host has, as far as this editor knows: from the index it opened, then from each answer. */
  const patchBase = useRef<{ of: Book; version: string; hashes: Map<string, string> } | null>(null);
  /** Assets the host has (or was sent): not sent again. */
  const hostAssets = useRef<{ of: Book; ids: Set<string> } | null>(null);
  const canPatch = isStreamed(base);
  const baseOfPatch = () => {
    if (!isStreamed(base)) throw new Error('a patch needs a streamed book');
    if (patchBase.current?.of !== base) patchBase.current = { of: base, version: base.version, hashes: pageHashes(base.index) };
    if (hostAssets.current?.of !== base) hostAssets.current = { of: base, ids: new Set(base.index.assets.map((a) => a.id)) };
    return { pb: patchBase.current, known: hostAssets.current.ids };
  };

  /**
   * What a save sends instead of the whole book: the pages that changed since the last save, and the media added since. Fetches no picture of the
   * book; a library item a changed page uses that the book does not carry yet is fetched once and sent with it.
   */
  const savePatch = useCallback(async (progress?: (p: SaveProgress) => void): Promise<{ patch: BookPatch; media: Map<string, { type: string; bytes: Uint8Array }>; lesson: Lesson }> => {
    const { pb, known } = baseOfPatch();
    const patch = createPatch({ version: pb.version, lesson: saved, hashes: pb.hashes }, lesson);
    const changedIds = new Set(Object.keys(patch.mine.pages));
    const sub = { ...lesson, pages: lesson.pages.filter((p) => changedIds.has(p.id)), snipPages: lesson.snipPages.filter((p) => changedIds.has(p.id)) } as Lesson;
    const wanted = referencedAssetIds(sub).filter((id) => !known.has(id));
    const got = await gatherAssets({
      ids: wanted,
      held: (id) => { const a = added.current.get(id); return a ? { type: a.type, bytes: a.bytes } : undefined; },
      fetchOne: async (id) => { const b = await (bytesFrom.current ?? base.assetBytes)(id); return b ? { type: b.type, bytes: new Uint8Array(b.bytes) } : null; },
      progress,
    });
    const media = new Map(got);
    patch.media = [...media].map(([id, m]) => ({ id, type: m.type }));
    return { patch, media, lesson };
  }, [lesson, saved, base]);

  /**
   * The host kept the patch: its answer is the next base (the version id and the new `hex8` of each page it wrote). A page the host merged with
   * someone else's work comes back whole: it replaces the editor's copy (and the history starts again from there, since earlier snapshots would
   * undo that work), so the next patch cannot undo it either.
   */
  const adoptPatch = useCallback((built: { patch: BookPatch; media: Map<string, unknown>; lesson: Lesson }, result: PatchResult) => {
    const { pb, known } = baseOfPatch();
    const next = adoptedPatch({ patch: built.patch, sent: built.lesson, top: hNow.current.stack[hNow.current.i]!, result, hashes: pb.hashes, known, mediaIds: built.media.keys() });
    patchBase.current = { of: pb.of, version: result.version, hashes: next.hashes };
    hostAssets.current = { of: pb.of, ids: next.known };
    if (next.top) setH({ stack: [next.top], i: 0, gesture: null });
    setSaved(next.saved);
  }, [base]);

  return { lesson, book, apply, undo, redo, addAsset, save, markSaved, canPatch, savePatch, adoptPatch, canUndo: h.i > 0, canRedo: h.i < h.stack.length - 1, dirty: lesson !== saved };
}

export type Authoring = ReturnType<typeof useAuthoring>;
