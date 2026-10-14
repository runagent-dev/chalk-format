import type {
  ArrowObject,
  EllipseObject,
  EmbedObject,
  ImageObject,
  InkObject,
  LessonObject,
  LineObject,
  RectObject,
  SnipObject,
  TextObject,
} from './lesson.js';
import { objectBBox, SNIP_ICON_SIZE } from './object-transform.js';

/** Point is inside an axis-aligned box defined by x/y/width/height, grown
 *  by `tolerance` on each side (0 = exact box, matching every pre-existing
 *  caller). */
function hitBox(
  box: { x: number; y: number; width: number; height: number },
  x: number,
  y: number,
  tolerance = 0,
): boolean {
  return (
    x >= box.x - tolerance &&
    x <= box.x + box.width + tolerance &&
    y >= box.y - tolerance &&
    y <= box.y + box.height + tolerance
  );
}

/** Point is inside a rectangle's axis-aligned bounding box (grown by `tolerance`). */
export function hitRect(rect: RectObject, x: number, y: number, tolerance = 0): boolean {
  return hitBox(rect, x, y, tolerance);
}

/** Point is inside an image / embed placement box (grown by `tolerance`).
 *  Hit-tests the object's *effective* box (`objectBBox`) rather than its
 *  raw stored `width`/`height` — when `displayMode === 'icon'` that's a
 *  small fixed marker, not the full placed size, and this must agree
 *  with what's actually drawn (and with the selection box, which also
 *  derives from `objectBBox`). */
export function hitImage(image: ImageObject | EmbedObject, x: number, y: number, tolerance = 0): boolean {
  return hitBox(objectBBox(image), x, y, tolerance);
}

/** Point is inside a region-snip icon's fixed SNIP_ICON_SIZE box, grown by
 *  `tolerance`. */
export function hitSnip(snip: SnipObject, x: number, y: number, tolerance = 0): boolean {
  return hitBox({ x: snip.x, y: snip.y, width: SNIP_ICON_SIZE, height: SNIP_ICON_SIZE }, x, y, tolerance);
}

/** Point is inside the ellipse inscribed in the object's box, grown by
 *  `tolerance` (added to both radii). */
export function hitEllipse(ell: EllipseObject, x: number, y: number, tolerance = 0): boolean {
  const rx = ell.width / 2 + tolerance;
  const ry = ell.height / 2 + tolerance;
  if (rx <= 0 || ry <= 0) return false;
  const dx = (x - (ell.x + ell.width / 2)) / rx;
  const dy = (y - (ell.y + ell.height / 2)) / ry;
  return dx * dx + dy * dy <= 1;
}

/** Point is within `strokeWidth/2 + tolerance` of a line/arrow segment. */
export function hitSegment(seg: LineObject | ArrowObject, x: number, y: number, tolerance = 2): boolean {
  const threshold = seg.strokeWidth / 2 + tolerance;
  return distanceToSegment(x, y, seg.x, seg.y, seg.x2, seg.y2) <= threshold;
}

/**
 * Approximate text bounding box. Uses `fontSize * length * 0.55` as a
 * character-width heuristic — not exact, but good enough for the
 * coarse hit-tests Sprint 2 needs. A future slice can measure real
 * glyph widths via `Canvas.measureText` and embed the result on the
 * `TextObject` itself; the hit-test signature stays the same.
 */
export function hitText(text: TextObject, x: number, y: number, tolerance = 0): boolean {
  const width = Math.max(1, text.text.length) * text.fontSize * 0.55;
  const height = text.fontSize;
  return hitBox({ x: text.x, y: text.y, width, height }, x, y, tolerance);
}

/**
 * Ink hit-test: within `size/2 + tolerance` of any segment of the
 * polyline. Uses point-to-segment distance so drawing across a stroke
 * catches it even if no vertex is under the pointer.
 *
 * `points` are relative to the object's `x`/`y` offset (matching how
 * Konva positions a Line), so the query point is shifted into the
 * stroke's local space first.
 */
export function hitInk(ink: InkObject, x: number, y: number, tolerance = 2): boolean {
  x -= ink.x;
  y -= ink.y;
  const threshold = ink.size / 2 + tolerance;
  const pts = ink.points;
  // Need at least two points to form a segment; a single-point stroke
  // is a dot — treat it as a small circle.
  if (pts.length < 2) return false;
  if (pts.length === 2) {
    return Math.hypot(x - pts[0]!, y - pts[1]!) <= threshold;
  }
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const x1 = pts[i]!;
    const y1 = pts[i + 1]!;
    const x2 = pts[i + 2]!;
    const y2 = pts[i + 3]!;
    if (distanceToSegment(x, y, x1, y1, x2, y2) <= threshold) return true;
  }
  return false;
}

function distanceToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) {
    return Math.hypot(px - x1, py - y1);
  }
  let t = ((px - x1) * dx + (py - y1) * dy) / lengthSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/**
 * Type-dispatch hit-test for any LessonObject. `tolerance` grows every
 * shape's hit area uniformly — the mechanism a caller like the eraser's
 * radius modes uses to test a wide circle instead of a bare point.
 * Left `undefined`, each shape falls back to its own default (0 for
 * box/ellipse shapes, 2px for the stroke-ish ink/line/arrow, matching
 * every pre-existing caller exactly).
 */
export function hitObject(obj: LessonObject, x: number, y: number, tolerance?: number): boolean {
  switch (obj.type) {
    case 'rect':
      return hitRect(obj, x, y, tolerance);
    case 'text':
      return hitText(obj, x, y, tolerance);
    case 'ink':
      return hitInk(obj, x, y, tolerance);
    case 'image':
    case 'embed':
      return hitImage(obj, x, y, tolerance);
    case 'ellipse':
      return hitEllipse(obj, x, y, tolerance);
    case 'line':
    case 'arrow':
      return hitSegment(obj, x, y, tolerance);
    case 'vector':
      // Render-only for now: a vector carries no bounds, so we can't
      // hit-test it without parsing its path. Not selectable yet.
      return false;
    case 'snip':
      return hitSnip(obj, x, y, tolerance);
  }
}

/**
 * Visual stacking rank per LessonObject type — mirrors the six-layer
 * Konva Stage in §9.5. Higher = renders on top and should therefore
 * be considered the top-most hit-test candidate.
 *
 *   ink                       → annotationLayer (rank 2)
 *   everything else           → contentLayer     (rank 1)
 *
 * Kept here in @chalk-format/model so hit-test doesn't depend on
 * canvas-konva. When new object types land, add them to this switch.
 */
export function stackingRank(type: LessonObject['type']): number {
  switch (type) {
    case 'ink':
      return 2;
    case 'rect':
    case 'text':
    case 'image':
    case 'ellipse':
    case 'line':
    case 'arrow':
    case 'vector':
    case 'embed':
    case 'snip':
      return 1;
  }
}

/**
 * Return every object at `(x, y)`, top-most first.
 *
 * Ordering rules (highest priority first):
 *   1. Higher `stackingRank` wins  — ink beats rect/text because ink
 *      renders on `annotationLayer` above `contentLayer`, regardless
 *      of source order in the lesson.
 *   2. Within the same rank, later source index wins — matches how
 *      Konva draws children (later = on top).
 *
 * Callers typically take `hits[0]` for the top-most hit. `tolerance`
 * (see `hitObject`) is forwarded to every candidate — e.g. the eraser's
 * radius modes pass the brush radius here instead of the default point
 * tolerance.
 */
export function hitTest(
  objects: readonly LessonObject[],
  x: number,
  y: number,
  tolerance?: number,
): LessonObject[] {
  const hits: Array<{ obj: LessonObject; rank: number; index: number }> = [];
  for (let i = 0; i < objects.length; i++) {
    const obj = objects[i]!;
    if (hitObject(obj, x, y, tolerance)) {
      hits.push({ obj, rank: stackingRank(obj.type), index: i });
    }
  }
  hits.sort((a, b) => b.rank - a.rank || b.index - a.index);
  return hits.map((h) => h.obj);
}
