import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { packLesson, type AssetBundle } from '@chalk-format/container';
import { assetKey, referencedAssetIds, type Lesson } from '@chalk-format/model';
import type { Book } from '../book.js';

const HISTORY = 200;

/**
 * The author's working copy of a book: the edited lesson with undo (one entry per gesture), the media added in
 * this session, and a Book over both that the reader draws exactly as a student would see it.
 */
export function useAuthoring(base: Book, onChange?: (lesson: Lesson) => void) {
  const [h, setH] = useState(() => ({ stack: [base.lesson], i: 0, gesture: null as string | null }));
  const lesson = h.stack[h.i]!;
  // the lesson as last saved: what "unsaved changes" compares against
  const [saved, setSaved] = useState(base.lesson);
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
  const save = useCallback(async (): Promise<{ bytes: Uint8Array; lesson: Lesson }> => {
    const bundle: AssetBundle = new Map();
    for (const id of referencedAssetIds(lesson)) {
      const a = added.current.get(id);
      if (a) { bundle.set(id, { type: a.type, bytes: a.bytes }); continue; }
      const b = await base.assetBytes(id).catch(() => null);
      if (b) bundle.set(id, { type: b.type, bytes: new Uint8Array(b.bytes) });
    }
    const bytes = await packLesson({ ...lesson, updatedAt: new Date().toISOString() }, bundle);
    return { bytes, lesson };
  }, [lesson, base]);
  const markSaved = useCallback((l: Lesson) => setSaved(l), []);

  return { lesson, book, apply, undo, redo, addAsset, save, markSaved, canUndo: h.i > 0, canRedo: h.i < h.stack.length - 1, dirty: lesson !== saved };
}

export type Authoring = ReturnType<typeof useAuthoring>;
