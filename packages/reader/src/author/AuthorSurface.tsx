import { useEffect, useRef, useState } from 'react';
import { MEDIA_ICON_SIZE, SNIP_ICON_SIZE, generateId, getPageSize, type Lesson, type LessonObject, type LessonPage } from '@chalk-format/model';
import { bounds, hits, moved, type Point } from '../annotate/ops.js';
import { edit } from '../annotate/state.js';

/** The box an object takes on the page as drawn: icon-mode media and snips are fixed-size markers. */
export function boxOf(o: LessonObject) {
  if (o.type === 'snip') return { x: o.x, y: o.y, width: SNIP_ICON_SIZE, height: SNIP_ICON_SIZE };
  if ((o.type === 'image' || o.type === 'embed') && o.displayMode === 'icon') return { x: o.x, y: o.y, width: MEDIA_ICON_SIZE, height: MEDIA_ICON_SIZE };
  return bounds(o);
}
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
 * A page in author mode: tap selects any of the book's objects, a drag moves it, the corner handle resizes it,
 * files dropped on the page are placed where they land. Edits go through `apply`; one gesture is one undo.
 */
export function AuthorSurface({ page, scale, selected, onSelect, apply, onDropFiles, labels }: {
  page: LessonPage; scale: number; selected: string | null;
  onSelect: (id: string | null) => void;
  apply: (fn: (l: Lesson) => Lesson, gesture?: string) => void;
  onDropFiles: (files: File[], at: Point) => void;
  labels: { resize: string; drop: string };
}) {
  const el = useRef<HTMLDivElement>(null);
  const g = useRef<{ id: string; pointer: number; start: Point; orig: LessonObject; resize: boolean; moved: boolean } | null>(null);
  const [dropping, setDropping] = useState(false);
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
    g.current = { id: generateId('g'), pointer: e.pointerId, start: p, orig: hit, resize, moved: false };
  };
  const move = (e: React.PointerEvent) => {
    const s = g.current; if (!s || s.pointer !== e.pointerId) return;
    const p = at(e), dx = p.x - s.start.x, dy = p.y - s.start.y;
    if (!s.moved && Math.hypot(dx, dy) < tol / 2) return;
    s.moved = true;
    const o = s.orig;
    if (s.resize && 'width' in o && 'height' in o) {
      const keep = o.type === 'image' || o.type === 'embed';
      const w = Math.max(24, Math.round(o.width + dx));
      const h = keep ? Math.round((o.height * w) / o.width) : Math.max(24, Math.round(o.height + dy));
      apply(edit.replace(page.id, { ...o, width: w, height: h } as LessonObject), s.id);
      return;
    }
    // stay on the page: at least part of the object remains reachable
    const b = boxOf(o);
    const cx = Math.min(Math.max(dx, -b.x - b.width + 24), width - b.x - 24), cy = Math.min(Math.max(dy, -b.y - b.height + 24), height - b.y - 24);
    apply(edit.replace(page.id, moved(o, Math.round(cx), Math.round(cy))), s.id);
  };
  const up = (e: React.PointerEvent) => { if (g.current?.pointer === e.pointerId) g.current = null; };

  const sb = sel && boxOf(sel);
  const handle = 14 / scale;
  return (
    <div ref={el} className={`chalk-surface chalk-author ${dropping ? 'is-dropping' : ''}`} style={{ width, height }}
      onPointerDown={(e) => down(e)} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { g.current = null; }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDropping(true); } }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => { e.preventDefault(); setDropping(false); const files = [...e.dataTransfer.files]; if (files.length) onDropFiles(files, at(e)); }}>
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
