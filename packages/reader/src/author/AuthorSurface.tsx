import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { generateId, getPageSize, type Lesson, type LessonObject, type LessonPage } from '@chalk-format/model';
import { hits, moved, type Point } from '../annotate/ops.js';
import { edit } from '../annotate/state.js';
import { boxOf, freeIdOn, placeAt, relocate } from './move.js';

export { boxOf } from './move.js';
const boxed = (o: LessonObject) => o.type === 'image' || o.type === 'embed' || o.type === 'snip' || o.type === 'text' || o.type === 'rect' || o.type === 'ellipse';
/** Can its size change? Markers cannot; media keeps its proportions. */
const resizable = (o: LessonObject) => (o.type === 'image' || o.type === 'embed' ? o.displayMode !== 'icon' : o.type === 'rect' || o.type === 'ellipse');

function topAt(objects: readonly LessonObject[], p: Point, tol: number): LessonObject | null {
  for (let i = objects.length - 1; i >= 0; i--) {
    const o = objects[i]!;
    if (boxed(o)) { const b = boxOf(o); if (p.x >= b.x - tol && p.x <= b.x + b.width + tol && p.y >= b.y - tol && p.y <= b.y + b.height + tol) return o; }
    else if (hits(o, p, tol)) return o;
  }
  return null;
}

/**
 * A drag in progress. Every page's surface shares one, because an object can be carried from its page onto another: when it lands there,
 * the pointer capture goes with it, and that page's surface goes on with the same drag (the page it left may even scroll out and unmount).
 */
export type Drag = {
  /** The undo gesture: every step of the drag amends one history entry. */
  id: string; pointer: number;
  /** The object as it was when the drag began; each step places this copy, so nothing accumulates. */
  orig: LessonObject;
  /** Where the pointer is on the object (page units): it stays there wherever the object goes. */
  grab: Point;
  /** The page the object is on now, and the page it started on. */
  on: string; from: string;
  /** Where the last step put it, on a page of this size (page units). */
  placed?: { obj: LessonObject; size: { width: number; height: number } };
  /** Resize by the corner handle: stays on its page. */
  resize: boolean; start: Point;
  /** Screen pixels: where it began, and where the pointer is now (for the auto-scroll). */
  startClient: { x: number; y: number }; last: { x: number; y: number };
  moved: boolean;
  viewer: HTMLElement | null;
  raf: number;
};

/** How close to the edge of the view (screen pixels) a drag scrolls it, so an object can be carried to a page that is not in view. */
const SCROLL_EDGE = 48;

/** The author-mode page surface under a screen point in this viewer, if any (only when it is the topmost thing there: not under the sheet). */
function surfaceAt(viewer: HTMLElement | null, x: number, y: number): HTMLElement | null {
  const top = document.elementFromPoint(x, y)?.closest<HTMLElement>('.chalk-author[data-chalk-page]');
  return top && (!viewer || viewer.contains(top)) ? top : null;
}

/**
 * A page in author mode: tap selects any of the book's objects, a drag moves it (onto another page too, when the pointer carries it there:
 * the pages above and below in the continuous view, the facing page in a spread; near the edge of the view it scrolls), the corner handle
 * resizes it, files dropped on the page are placed where they land. Edits go through `apply`; one gesture is one undo.
 */
export function AuthorSurface({ page, scale, selected, onSelect, apply, onDropFiles, labels, drag, pageOf }: {
  page: LessonPage; scale: number; selected: string | null;
  /** Select an object (null: nothing); `on` names its page when that is not this one (it was carried onto another). */
  onSelect: (id: string | null, on?: string) => void;
  apply: (fn: (l: Lesson) => Lesson, gesture?: string) => void;
  onDropFiles: (files: File[], at: Point) => void;
  labels: { resize: string; drop: string };
  /** The drag in progress, shared by all pages of the reader. */
  drag: MutableRefObject<Drag | null>;
  /** Any page of the book as it is now (an object carried onto a page must not take an id that page already uses). */
  pageOf: (id: string) => LessonPage | undefined;
}) {
  const el = useRef<HTMLDivElement>(null);
  const [dropping, setDropping] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const { width, height } = getPageSize(page);
  const tol = 6 / scale;
  const at = (e: { clientX: number; clientY: number }): Point => {
    const r = el.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
  };
  const sel = selected ? page.objects.find((o) => o.id === selected) : undefined;

  // keys for the selection: Delete removes it, arrows nudge it (Shift: 10×), Escape lets go
  useEffect(() => {
    if (!sel) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) return;
      const step = e.shiftKey ? 10 : 1;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (d) { e.preventDefault(); apply(edit.replace(page.id, moved(sel, d[0]!, d[1]!)), `nudge-${sel.id}`); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); apply(edit.remove(page.id, new Set([sel.id]))); onSelect(null); }
      if (e.key === 'Escape') onSelect(null);
    };
    addEventListener('keydown', onKey); return () => removeEventListener('keydown', onKey);
  }, [sel, apply, page.id, onSelect]);

  const down = (e: React.PointerEvent, resize = false) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const p = at(e);
    const hit = resize && sel ? sel : topAt(page.objects, p, tol);
    onSelect(hit?.id ?? null);
    if (!hit) return;
    el.current!.setPointerCapture(e.pointerId);
    const b = boxOf(hit), client = { x: e.clientX, y: e.clientY };
    drag.current = {
      id: generateId('g'), pointer: e.pointerId, orig: hit, grab: { x: p.x - b.x, y: p.y - b.y }, on: page.id, from: page.id, resize, start: p,
      startClient: client, last: client, moved: false, viewer: el.current!.closest<HTMLElement>('.chalk-viewer'), raf: 0,
    };
  };

  /**
   * Put the dragged object under the pointer: on the page the pointer is over (moving it there if that is another page, and handing the
   * pointer capture to that page), else on the page it is on, held so that part of it stays on the page.
   */
  const carry = (s: Drag) => {
    const { x, y } = s.last;
    const target = surfaceAt(s.viewer, x, y) ?? s.viewer?.querySelector<HTMLElement>(`.chalk-author[data-chalk-page="${CSS.escape(s.on)}"]`) ?? null;
    const to = target?.dataset.chalkPage;
    if (!target || !to) return;
    const r = target.getBoundingClientRect();
    const p = { x: (x - r.left) / scale, y: (y - r.top) / scale };
    // offsetWidth/Height: the surface's own size, in page units (it is drawn scaled)
    const size = { width: target.offsetWidth, height: target.offsetHeight };
    const obj = placeAt(s.orig, { x: p.x - s.grab.x, y: p.y - s.grab.y }, size);
    if (to === s.on) { apply(edit.move(s.on, to, obj), s.id); s.placed = { obj, size }; return; }
    const landing = freeIdOn(pageOf(to), obj);
    s.placed = { obj: landing, size };
    apply(edit.move(s.on, to, landing, obj.id), s.id);
    s.orig = { ...s.orig, id: landing.id };
    s.on = to;
    onSelect(landing.id, to);
    try { target.setPointerCapture(s.pointer); } catch { /* the pointer is already up */ }
  };

  /** While the pointer is near the top or bottom (or a side) of the view, scroll it and keep the object under the pointer. */
  const autoScroll = (s: Drag) => {
    if (s.raf || !s.viewer) return;
    const tick = () => {
      s.raf = 0;
      const v = s.viewer;
      if (drag.current !== s || !v) return;
      const box = v.getBoundingClientRect();
      // on a phone the properties sheet covers the lower part of the view: its top is the edge
      const sheet = v.parentElement?.querySelector('.chalk-sidebar')?.getBoundingClientRect();
      const bottom = sheet && sheet.top > box.top && sheet.left <= box.left + 1 && sheet.right >= box.right - 1 ? Math.min(box.bottom, sheet.top) : box.bottom;
      const speed = (d: number) => Math.round(Math.min(d, 2 * SCROLL_EDGE) / 3);
      const { x, y } = s.last;
      const dy = y < box.top + SCROLL_EDGE ? -speed(box.top + SCROLL_EDGE - y) : y > bottom - SCROLL_EDGE ? speed(y - bottom + SCROLL_EDGE) : 0;
      const dx = x < box.left + SCROLL_EDGE ? -speed(box.left + SCROLL_EDGE - x) : x > box.right - SCROLL_EDGE ? speed(x - box.right + SCROLL_EDGE) : 0;
      if (!dx && !dy) return;
      const before = { top: v.scrollTop, left: v.scrollLeft };
      v.scrollBy(dx, dy);
      if (v.scrollTop === before.top && v.scrollLeft === before.left) return; // at the end: nothing more to scroll
      carry(s);
      s.raf = requestAnimationFrame(tick);
    };
    s.raf = requestAnimationFrame(tick);
  };

  const move = (e: React.PointerEvent) => {
    const s = drag.current;
    // no drag: outline what a click would select
    if (!s) { if (e.pointerType === 'mouse') setHover(topAt(page.objects, at(e), tol)?.id ?? null); return; }
    if (s.pointer !== e.pointerId) return;
    s.last = { x: e.clientX, y: e.clientY };
    if (!s.moved && Math.hypot(s.last.x - s.startClient.x, s.last.y - s.startClient.y) < 3) return;
    s.moved = true;
    const o = s.orig;
    if (s.resize) {
      if (!('width' in o && 'height' in o) || s.on !== page.id) return;
      const p = at(e), dx = p.x - s.start.x, dy = p.y - s.start.y;
      const keep = o.type === 'image' || o.type === 'embed';
      const w = Math.max(24, Math.round(o.width + dx));
      const h = keep ? Math.round((o.height * w) / o.width) : Math.max(24, Math.round(o.height + dy));
      apply(edit.replace(page.id, { ...o, width: w, height: h } as LessonObject), s.id);
      return;
    }
    carry(s);
    autoScroll(s);
  };
  const end = (e: React.PointerEvent) => {
    const s = drag.current;
    if (s?.pointer !== e.pointerId) return;
    if (s.raf) cancelAnimationFrame(s.raf);
    drag.current = null;
    // dropped on another page: all of it on that page where it fits (on its own page it may hang over an edge, as it always could)
    if (s.placed && s.on !== s.from) {
      const inside = relocate(s.placed.obj, s.placed.size, s.placed.size);
      if (inside.x !== s.placed.obj.x || inside.y !== s.placed.obj.y) apply(edit.replace(s.on, inside), s.id);
    }
  };

  const sb = sel && boxOf(sel);
  const handle = 14 / scale;
  return (
    <div ref={el} className={`chalk-surface chalk-author ${dropping ? 'is-dropping' : ''}`} style={{ width, height }} data-chalk-page={page.id}
      onPointerDown={(e) => down(e)} onPointerMove={move} onPointerUp={end} onPointerCancel={end}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDropping(true); } }}
      onPointerLeave={() => setHover(null)}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => { e.preventDefault(); setDropping(false); const files = [...e.dataTransfer.files]; if (files.length) onDropFiles(files, at(e)); }}>
      {hover && hover !== selected && (() => {
        const h = page.objects.find((o) => o.id === hover); if (!h) return null;
        const b = boxOf(h);
        return <div className="chalk-author-hover" style={{ left: b.x, top: b.y, width: b.width, height: b.height, '--s': scale } as React.CSSProperties} />;
      })()}
      {sb && (
        <div className="chalk-author-sel" style={{ left: sb.x, top: sb.y, width: sb.width, height: sb.height, '--s': scale } as React.CSSProperties}>
          {sel && resizable(sel) && (
            <span className="chalk-author-handle" role="presentation" aria-label={labels.resize} title={labels.resize}
              style={{ width: handle, height: handle }} onPointerDown={(e) => down(e, true)} />
          )}
        </div>
      )}
      {dropping && <div className="chalk-author-drop"><span style={{ fontSize: 16 / scale }}>{labels.drop}</span></div>}
    </div>
  );
}
