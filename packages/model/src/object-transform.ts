import type { InkObject, LessonObject, TextObject } from './schema.js';

export interface ObjectBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Keep in sync with the text estimate in hit-test.ts. */
const TEXT_WIDTH_PER_CHAR = 0.55;

export const MIN_TEXT_FONT_SIZE = 6;
export const MAX_TEXT_FONT_SIZE = 800;

export function textBox(text: TextObject): ObjectBox {
  const width = Math.max(1, text.text.length) * text.fontSize * TEXT_WIDTH_PER_CHAR;
  return { x: text.x, y: text.y, width, height: text.fontSize };
}

export function inkBox(ink: InkObject): ObjectBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < ink.points.length; i += 2) {
    const x = ink.points[i]!;
    const y = ink.points[i + 1]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return { x: ink.x, y: ink.y, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Page-space bounding box of any lesson object. Vector paths carry no
 * extent information without parsing the path data, so callers must
 * treat a zero-sized box as "position only" (no resize handle).
 */
export function objectBBox(obj: LessonObject): ObjectBox {
  switch (obj.type) {
    case 'text':
      return textBox(obj);
    case 'rect':
    case 'image':
    case 'embed':
    case 'ellipse':
      return { x: obj.x, y: obj.y, width: obj.width, height: obj.height };
    case 'line':
    case 'arrow': {
      const x = Math.min(obj.x, obj.x2);
      const y = Math.min(obj.y, obj.y2);
      return { x, y, width: Math.abs(obj.x2 - obj.x), height: Math.abs(obj.y2 - obj.y) };
    }
    case 'ink':
      return inkBox(obj);
    case 'vector':
      return { x: obj.x, y: obj.y, width: 0, height: 0 };
  }
}

/** Shift an object by (dx, dy) in page space, leaving its shape intact. */
export function moveObjectBy(obj: LessonObject, dx: number, dy: number): LessonObject {
  switch (obj.type) {
    case 'rect':
    case 'text':
    case 'image':
    case 'ellipse':
    case 'vector':
    case 'embed':
      return { ...obj, x: obj.x + dx, y: obj.y + dy };
    case 'line':
    case 'arrow':
      return { ...obj, x: obj.x + dx, y: obj.y + dy, x2: obj.x2 + dx, y2: obj.y2 + dy };
    case 'ink': {
      const shifted = new Array<number>(obj.points.length);
      for (let i = 0; i < obj.points.length; i += 2) {
        shifted[i] = obj.points[i]! + dx;
        shifted[i + 1] = obj.points[i + 1]! + dy;
      }
      return { ...obj, points: shifted };
    }
  }
}

/**
 * Uniformly scale an object by `factor` about the page-space anchor
 * (ax, ay) — normally its bounding-box top-left, so resizing from the
 * corner handle keeps the opposite corner planted. Text scales its
 * font size; strokes scale with the geometry. Vector paths return
 * unchanged (their extent is not computable without path parsing).
 */
export function scaleObjectAbout(
  obj: LessonObject,
  ax: number,
  ay: number,
  factor: number,
): LessonObject {
  if (!(factor > 0)) return obj;
  switch (obj.type) {
    case 'text':
      return {
        ...obj,
        fontSize: Math.min(
          MAX_TEXT_FONT_SIZE,
          Math.max(MIN_TEXT_FONT_SIZE, Math.round(obj.fontSize * factor)),
        ),
      };
    case 'rect':
    case 'ellipse':
      return {
        ...obj,
        width: obj.width * factor,
        height: obj.height * factor,
        strokeWidth: obj.strokeWidth * factor,
      };
    case 'image':
    case 'embed':
      return { ...obj, width: obj.width * factor, height: obj.height * factor };
    case 'line':
    case 'arrow':
      return {
        ...obj,
        x2: ax + (obj.x2 - ax) * factor,
        y2: ay + (obj.y2 - ay) * factor,
        strokeWidth: obj.strokeWidth * factor,
      };
    case 'ink': {
      const scaled = new Array<number>(obj.points.length);
      for (let i = 0; i < obj.points.length; i += 2) {
        scaled[i] = ax + (obj.points[i]! - ax) * factor;
        scaled[i + 1] = ay + (obj.points[i + 1]! - ay) * factor;
      }
      return { ...obj, points: scaled, size: obj.size * factor };
    }
    case 'vector':
      return obj;
  }
}
