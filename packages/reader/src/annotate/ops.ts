import type { LessonObject } from '@chalk-format/model';

export type Point = { x: number; y: number };

const distToSegment = (p: Point, a: Point, b: Point) => {
  const dx = b.x - a.x, dy = b.y - a.y, len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
};

/** The object's box in page units (for selection outlines and coarse hits). */
export function bounds(o: LessonObject): { x: number; y: number; width: number; height: number } {
  switch (o.type) {
    case 'ink': {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i + 1 < o.points.length; i += 2) { x0 = Math.min(x0, o.points[i]!); x1 = Math.max(x1, o.points[i]!); y0 = Math.min(y0, o.points[i + 1]!); y1 = Math.max(y1, o.points[i + 1]!); }
      const h = o.size / 2;
      return x0 === Infinity ? { x: o.x, y: o.y, width: 0, height: 0 } : { x: o.x + x0 - h, y: o.y + y0 - h, width: x1 - x0 + o.size, height: y1 - y0 + o.size };
    }
    case 'line': case 'arrow': return { x: Math.min(o.x, o.x2), y: Math.min(o.y, o.y2), width: Math.abs(o.x2 - o.x), height: Math.abs(o.y2 - o.y) };
    case 'text': {
      const lines = o.text.split('\n');
      return { x: o.x, y: o.y, width: Math.max(...lines.map((l) => l.length)) * o.fontSize * 0.55, height: lines.length * o.fontSize * 1.2 };
    }
    case 'snip': return { x: o.x, y: o.y, width: 56, height: 56 };
    case 'vector': {
      // the path's own numbers, taken as x, y pairs: exact for M/L/C/Q paths, close enough to pick one
      const n = (o.path.match(/-?\d*\.?\d+(?:e-?\d+)?/gi) ?? []).map(Number);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i + 1 < n.length; i += 2) { x0 = Math.min(x0, n[i]!); x1 = Math.max(x1, n[i]!); y0 = Math.min(y0, n[i + 1]!); y1 = Math.max(y1, n[i + 1]!); }
      return x0 === Infinity ? { x: o.x, y: o.y, width: 0, height: 0 } : { x: o.x + x0, y: o.y + y0, width: x1 - x0, height: y1 - y0 };
    }
    case 'rect': case 'ellipse': case 'image': case 'embed': return { x: o.x, y: o.y, width: o.width, height: o.height };
  }
}

/** Is p on the object, within `tol` page units? Strokes and lines by distance; boxes by area. */
export function hits(o: LessonObject, p: Point, tol: number): boolean {
  if (o.type === 'ink') {
    const r = o.size / 2 + tol;
    if (o.points.length < 4) return Math.hypot(p.x - o.x - (o.points[0] ?? 0), p.y - o.y - (o.points[1] ?? 0)) <= r;
    for (let i = 0; i + 3 < o.points.length; i += 2) {
      if (distToSegment(p, { x: o.x + o.points[i]!, y: o.y + o.points[i + 1]! }, { x: o.x + o.points[i + 2]!, y: o.y + o.points[i + 3]! }) <= r) return true;
    }
    return false;
  }
  if (o.type === 'line' || o.type === 'arrow') return distToSegment(p, { x: o.x, y: o.y }, { x: o.x2, y: o.y2 }) <= o.strokeWidth / 2 + tol;
  const b = bounds(o);
  return p.x >= b.x - tol && p.x <= b.x + b.width + tol && p.y >= b.y - tol && p.y <= b.y + b.height + tol;
}

/** The topmost object at p that may be changed (later objects are drawn on top, spec 1.0 §3.2). */
export function topHit(objects: readonly LessonObject[], p: Point, tol: number, editable: (o: LessonObject) => boolean): LessonObject | null {
  for (let i = objects.length - 1; i >= 0; i--) { const o = objects[i]!; if (editable(o) && hits(o, p, tol)) return o; }
  return null;
}

/** The object moved by (dx, dy). */
export function moved<T extends LessonObject>(o: T, dx: number, dy: number): T {
  const r = (v: number) => Math.round(v * 10) / 10;
  if (o.type === 'line' || o.type === 'arrow') return { ...o, x: r(o.x + dx), y: r(o.y + dy), x2: r(o.x2 + dx), y2: r(o.y2 + dy) };
  return { ...o, x: r(o.x + dx), y: r(o.y + dy) };
}

/** A stroke's points as offsets from its first point (spec 1.0 §3.4: ink points are offsets from x, y). */
export function inkFrom(points: readonly Point[]): { x: number; y: number; points: number[] } {
  const o = points[0] ?? { x: 0, y: 0 }, flat: number[] = [];
  for (const p of points) flat.push(Math.round((p.x - o.x) * 10) / 10, Math.round((p.y - o.y) * 10) / 10);
  return { x: Math.round(o.x * 10) / 10, y: Math.round(o.y * 10) / 10, points: flat };
}

/** A translucent version of a colour for the highlighter: #rgb / #rrggbb with alpha, else unchanged. */
export function translucent(color: string, alpha = 0.42): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const hex = m[1]!.length === 3 ? m[1]!.split('').map((c) => c + c).join('') : m[1]!;
  return `#${hex}${Math.round(alpha * 255).toString(16).padStart(2, '0')}`;
}
