import type {
  ArrowObject,
  EllipseObject,
  EmbedObject,
  ImageObject,
  InkObject,
  LessonObject,
  LineObject,
  RectObject,
  TextObject,
} from './lesson.js';

/** Point is inside an axis-aligned box defined by x/y/width/height. */
function hitBox(
  box: { x: number; y: number; width: number; height: number },
  x: number,
  y: number,
): boolean {
  return x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height;
}

/** Point is inside a rectangle's axis-aligned bounding box. */
export function hitRect(rect: RectObject, x: number, y: number): boolean {
  return hitBox(rect, x, y);
}

/** Point is inside an image / embed placement box. */
export function hitImage(image: ImageObject | EmbedObject, x: number, y: number): boolean {
  return hitBox(image, x, y);
}

/** Point is inside the ellipse inscribed in the object's box. */
export function hitEllipse(ell: EllipseObject, x: number, y: number): boolean {
  const rx = ell.width / 2;
  const ry = ell.height / 2;
  if (rx <= 0 || ry <= 0) return false;
  const dx = (x - (ell.x + rx)) / rx;
  const dy = (y - (ell.y + ry)) / ry;
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
export function hitText(text: TextObject, x: number, y: number): boolean {
  const width = Math.max(1, text.text.length) * text.fontSize * 0.55;
  const height = text.fontSize;
  return x >= text.x && x <= text.x + width && y >= text.y && y <= text.y + height;
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

/** Type-dispatch hit-test for any LessonObject. */
export function hitObject(obj: LessonObject, x: number, y: number): boolean {
  switch (obj.type) {
    case 'rect':
      return hitRect(obj, x, y);
    case 'text':
      return hitText(obj, x, y);
    case 'ink':
      return hitInk(obj, x, y);
    case 'image':
    case 'embed':
      return hitImage(obj, x, y);
    case 'ellipse':
      return hitEllipse(obj, x, y);
    case 'line':
    case 'arrow':
      return hitSegment(obj, x, y);
    case 'vector':
      // Render-only for now: a vector carries no bounds, so we can't
      // hit-test it without parsing its path. Not selectable yet.
      return false;
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
 * Kept here in @chalkbook/core so hit-test doesn't depend on
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
 * Callers typically take `hits[0]` for the top-most hit.
 */
export function hitTest(objects: readonly LessonObject[], x: number, y: number): LessonObject[] {
  const hits: Array<{ obj: LessonObject; rank: number; index: number }> = [];
  for (let i = 0; i < objects.length; i++) {
    const obj = objects[i]!;
    if (hitObject(obj, x, y)) {
      hits.push({ obj, rank: stackingRank(obj.type), index: i });
    }
  }
  hits.sort((a, b) => b.rank - a.rank || b.index - a.index);
  return hits.map((h) => h.obj);
}
