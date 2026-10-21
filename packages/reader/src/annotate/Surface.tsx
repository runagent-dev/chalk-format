import { useEffect, useRef, useState } from 'react';
import { XIcon } from '@phosphor-icons/react';
import { generateId, getPageSize, type Lesson, type LessonObject, type LessonPage } from '@chalk-format/model';
import type { ToolId } from '../config.js';
import { inkPath } from '../render/ink.js';
import { bounds, inkFrom, moved, topHit, translucent, type Point } from './ops.js';
import { edit } from './state.js';

export type Pen = { tool: ToolId; color: string; highlight: string; size: number; textSize: number };

type Draft =
  | { kind: 'ink'; points: Point[] }
  | { kind: 'shape'; a: Point; b: Point }
  | null;

/**
 * The page's drawing surface while a tool is out: strokes, shapes, the eraser, text notes and selection, in
 * page units (so a note sticks to the page at any zoom). Edits go through `apply`; one gesture is one undo.
 */
export function Surface({ page, scale, pen, editable, apply, textPrompt }: {
  page: LessonPage; scale: number; pen: Pen;
  editable: (o: LessonObject) => boolean;
  apply: (fn: (l: Lesson) => Lesson, gesture?: string) => void;
  textPrompt: string;
}) {
  const el = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Draft>(null);
  const [text, setText] = useState<{ x: number; y: number; value: string } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const g = useRef<{ id: string; pointer: number; start: Point; orig?: LessonObject; erased?: Set<string>; moved?: boolean } | null>(null);
  const { width, height } = getPageSize(page);
  const tol = 8 / scale;
  const at = (e: { clientX: number; clientY: number }): Point => {
    const r = el.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
  };

  useEffect(() => { if (pen.tool !== 'select') setSelected(null); }, [pen.tool]);
  // Delete / Backspace removes the selection
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && !(e.target as HTMLElement).closest('input, textarea')) { e.preventDefault(); apply(edit.remove(page.id, new Set([selected]))); setSelected(null); }
      if (e.key === 'Escape') setSelected(null);
    };
    addEventListener('keydown', onKey); return () => removeEventListener('keydown', onKey);
  }, [selected, apply, page.id]);

  const eraseAt = (p: Point) => {
    const s = g.current; if (!s) return;
    const hit = topHit(page.objects.filter((o) => !s.erased!.has(o.id)), p, tol, editable);
    if (hit) { s.erased!.add(hit.id); apply(edit.remove(page.id, new Set(s.erased)), s.id); }
  };

  const down = (e: React.PointerEvent) => {
    if (e.button !== 0 || text) return;
    const p = at(e);
    el.current!.setPointerCapture(e.pointerId);
    g.current = { id: generateId('g'), pointer: e.pointerId, start: p };
    switch (pen.tool) {
      case 'pen': case 'highlighter': setDraft({ kind: 'ink', points: [p] }); break;
      case 'rect': case 'ellipse': case 'line': case 'arrow': setDraft({ kind: 'shape', a: p, b: p }); break;
      case 'eraser': g.current.erased = new Set(); eraseAt(p); break;
      case 'select': {
        const hit = topHit(page.objects, p, tol, editable);
        setSelected(hit?.id ?? null);
        if (hit) g.current.orig = hit;
        break;
      }
      default: break;
    }
  };
  const move = (e: React.PointerEvent) => {
    const s = g.current; if (!s || s.pointer !== e.pointerId) return;
    if (pen.tool === 'pen' || pen.tool === 'highlighter') {
      const pts = (e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent]).map(at);
      setDraft((d) => (d && d.kind === 'ink' ? { kind: 'ink', points: [...d.points, ...pts] } : d));
    } else if (draft?.kind === 'shape') setDraft({ ...draft, b: at(e) });
    else if (pen.tool === 'eraser') eraseAt(at(e));
    else if (pen.tool === 'select' && s.orig) {
      const p = at(e), dx = p.x - s.start.x, dy = p.y - s.start.y;
      if (!s.moved && Math.hypot(dx, dy) < tol / 2) return;
      s.moved = true;
      apply(edit.replace(page.id, moved(s.orig, dx, dy)), s.id);
    }
  };
  const up = (e: React.PointerEvent) => {
    const s = g.current; if (!s || s.pointer !== e.pointerId) return;
    g.current = null;
    const id = generateId('note');
    if (draft?.kind === 'ink') {
      const hl = pen.tool === 'highlighter', { x, y, points } = inkFrom(draft.points);
      apply(edit.add(page.id, { id, type: 'ink', x, y, points, color: hl ? translucent(pen.highlight) : pen.color, size: hl ? Math.max(pen.size * 3, 14) : pen.size }));
    } else if (draft?.kind === 'shape') {
      const { a, b } = draft, r = (v: number) => Math.round(v * 10) / 10;
      if (Math.hypot(b.x - a.x, b.y - a.y) > tol) {
        if (pen.tool === 'line' || pen.tool === 'arrow') apply(edit.add(page.id, { id, type: pen.tool, x: r(a.x), y: r(a.y), x2: r(b.x), y2: r(b.y), stroke: pen.color, strokeWidth: pen.size }));
        else apply(edit.add(page.id, { id, type: pen.tool === 'ellipse' ? 'ellipse' : 'rect', x: r(Math.min(a.x, b.x)), y: r(Math.min(a.y, b.y)), width: r(Math.abs(b.x - a.x)), height: r(Math.abs(b.y - a.y)), fill: 'transparent', stroke: pen.color, strokeWidth: pen.size }));
      }
    } else if (pen.tool === 'text') {
      const p = at(e);
      setText({ x: p.x, y: p.y - pen.textSize * 0.6, value: '' });
    }
    setDraft(null);
  };

  const commitText = () => {
    if (text && text.value.trim()) apply(edit.add(page.id, { id: generateId('note'), type: 'text', x: Math.round(text.x), y: Math.round(text.y), text: text.value.replace(/\s+$/, ''), fontSize: pen.textSize, fill: pen.color }));
    setText(null);
  };

  const sel = selected ? page.objects.find((o) => o.id === selected) : undefined;
  const sb = sel && bounds(sel);
  return (
    <div ref={el} className={`chalk-surface is-${pen.tool}`} style={{ width, height }}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { g.current = null; setDraft(null); }}>
      <svg className="chalk-layer" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
        {draft?.kind === 'ink' && (() => {
          const hl = pen.tool === 'highlighter', { x, y, points } = inkFrom(draft.points);
          return <path d={inkPath(points, hl ? Math.max(pen.size * 3, 14) : pen.size, false)} transform={`translate(${x} ${y})`} fill={hl ? translucent(pen.highlight) : pen.color} />;
        })()}
        {draft?.kind === 'shape' && (() => {
          const { a, b } = draft, common = { stroke: pen.color, strokeWidth: pen.size, fill: 'none' };
          if (pen.tool === 'ellipse') return <ellipse cx={(a.x + b.x) / 2} cy={(a.y + b.y) / 2} rx={Math.abs(b.x - a.x) / 2} ry={Math.abs(b.y - a.y) / 2} {...common} />;
          if (pen.tool === 'line' || pen.tool === 'arrow') return <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} {...common} strokeLinecap="round" />;
          return <rect x={Math.min(a.x, b.x)} y={Math.min(a.y, b.y)} width={Math.abs(b.x - a.x)} height={Math.abs(b.y - a.y)} {...common} />;
        })()}
        {sb && <rect className="chalk-selection" x={sb.x - 4 / scale} y={sb.y - 4 / scale} width={sb.width + 8 / scale} height={sb.height + 8 / scale} strokeWidth={1.5 / scale} strokeDasharray={`${5 / scale} ${4 / scale}`} />}
      </svg>
      {sb && (
        <button type="button" className="chalk-selection-delete" aria-label="×" onPointerDown={(e) => e.stopPropagation()}
          onClick={() => { apply(edit.remove(page.id, new Set([selected!]))); setSelected(null); }}
          style={{ left: sb.x + sb.width + 4 / scale, top: sb.y - 4 / scale, width: 28 / scale, height: 28 / scale, transform: 'translate(-50%, -50%)' }}>
          <XIcon size={16 / scale} weight="bold" />
        </button>
      )}
      {text && (
        <textarea autoFocus className="chalk-note-input" aria-label={textPrompt} placeholder={textPrompt} value={text.value}
          style={{ left: text.x, top: text.y, fontSize: pen.textSize, color: pen.color, minWidth: pen.textSize * 6 }}
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => setText({ ...text, value: e.target.value })} onBlur={commitText}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitText(); } if (e.key === 'Escape') setText(null); }} />
      )}
    </div>
  );
}
