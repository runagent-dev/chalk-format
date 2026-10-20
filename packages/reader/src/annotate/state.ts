import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CHALK_FORMAT_VERSION, composeOverlay, diffLesson, parseOverlay, type Lesson, type LessonObject, type Overlay } from '@chalk-format/model';

export type AnnotationOptions = {
  /** Controlled: the host owns the overlay and passes it back after each onOverlayChange. */
  overlay?: Overlay | undefined;
  /** Uncontrolled: where to start (else this browser's saved notes, with persistence 'local'). */
  defaultOverlay?: Overlay | undefined;
  onOverlayChange?: ((overlay: Overlay) => void) | undefined;
  persistence: 'local' | 'none';
};

const storageKey = (lesson: Lesson) => `chalk:${lesson.id}:overlay`;
function loadLocal(lesson: Lesson): Overlay | null {
  try { const raw = localStorage.getItem(storageKey(lesson)); return raw ? parseOverlay(JSON.parse(raw)) : null; } catch { return null; }
}

const HISTORY = 200;

/**
 * The student's work as a Chalk overlay (spec 1.0 §4). The reader keeps the edited lesson; the overlay is
 * always diffLesson(base, edited), so it is exactly what the format can store and exchange. History has one
 * entry per gesture (a whole eraser drag undoes as one), up to 200.
 */
export function useAnnotations(base: Lesson, o: AnnotationOptions) {
  const baseRef = useMemo(() => ({ id: base.id, version: CHALK_FORMAT_VERSION }), [base.id]);
  const start = () => {
    const ov = o.overlay ?? o.defaultOverlay ?? (o.persistence === 'local' ? loadLocal(base) : null);
    return ov && ov.base.id === base.id ? composeOverlay(base, ov) : base;
  };
  const [h, setH] = useState(() => ({ stack: [start()], i: 0, gesture: null as string | null }));
  const lesson = h.stack[h.i]!;
  const overlay = useMemo(() => diffLesson(base, lesson, baseRef), [base, lesson, baseRef]);

  // a controlled overlay that the host changed (not the one we just reported) replaces the work
  const reported = useRef<Overlay | null>(null);
  useEffect(() => {
    if (!o.overlay || o.overlay === reported.current || o.overlay.base.id !== base.id) return;
    setH({ stack: [composeOverlay(base, o.overlay)], i: 0, gesture: null });
  }, [o.overlay, base]);

  // report and save after every change (not on the first render)
  const first = useRef(true);
  const onChange = useRef(o.onOverlayChange); onChange.current = o.onOverlayChange;
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    reported.current = overlay;
    onChange.current?.(overlay);
    if (o.persistence !== 'local') return;
    const id = setTimeout(() => { try { localStorage.setItem(storageKey(base), JSON.stringify(overlay)); } catch { /* full or blocked */ } }, 400);
    return () => clearTimeout(id);
  }, [overlay, base, o.persistence]);

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
  /** Replace the work with an overlay (opened from a file). Undoable. */
  const load = useCallback((ov: Overlay) => {
    if (ov.base.id !== base.id) throw new Error(`these notes belong to another book (${ov.base.id})`);
    apply(() => composeOverlay(base, ov));
  }, [base, apply]);

  // the book's own objects (by page) may be changed only when the host allows it
  const baseIds = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const p of [...base.pages, ...base.snipPages]) m.set(p.id, new Set(p.objects.map((x) => x.id)));
    return m;
  }, [base]);
  const isOwn = useCallback((pageId: string, obj: LessonObject) => !baseIds.get(pageId)?.has(obj.id), [baseIds]);

  return { lesson, overlay, apply, undo, redo, load, isOwn, canUndo: h.i > 0, canRedo: h.i < h.stack.length - 1 };
}

/** Lesson edits by page: add, replace, remove an object, leaving every other page untouched. */
export const edit = {
  add: (pageId: string, obj: LessonObject) => (l: Lesson): Lesson => ({ ...l, pages: l.pages.map((p) => (p.id === pageId ? { ...p, objects: [...p.objects, obj] } : p)) }),
  replace: (pageId: string, obj: LessonObject) => (l: Lesson): Lesson => ({ ...l, pages: l.pages.map((p) => (p.id === pageId ? { ...p, objects: p.objects.map((x) => (x.id === obj.id ? obj : x)) } : p)) }),
  remove: (pageId: string, ids: ReadonlySet<string>) => (l: Lesson): Lesson => {
    let changed = false;
    const pages = l.pages.map((p) => {
      if (p.id !== pageId) return p;
      const objects = p.objects.filter((x) => !ids.has(x.id));
      if (objects.length === p.objects.length) return p;
      changed = true; return { ...p, objects };
    });
    return changed ? { ...l, pages } : l;
  },
};
