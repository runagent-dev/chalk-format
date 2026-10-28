/**
 * Where the floating window is and how big (spec 1.6): pure geometry, in px inside the reader's box, so it can be tested without a browser.
 * A window is its header (a fixed height) over a body that holds the media. `aspect` is the body's width / height, or null when the
 * shape is free; with an aspect every size the student picks is snapped to it.
 */

export type Size = { w: number; h: number };
export type Box = { x: number; y: number; w: number; h: number };
export type Dir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** The header's height. */
export const HEAD = 44;
/** The smallest body the media is usable in. */
export const MIN_BODY: Size = { w: 240, h: 150 };
/** The gap kept to the reader's edges. */
export const MARGIN = 8;
/** At or below this reader width the window becomes a sheet across the bottom (reference threshold, spec 1.6 §3). */
export const SHEET_BELOW = 640;
/** How a keyboard moves the window: arrows, and with Shift. */
export const STEP = 16;
export const STEP_BIG = 64;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
const round = (b: Box): Box => ({ x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) });

/** The widest and narrowest body width that fits the reader (and keeps the aspect, when there is one). */
function bodyWidthRange(root: Size, aspect: number | null): [number, number] {
  const maxW = root.w - 2 * MARGIN;
  const maxH = root.h - 2 * MARGIN - HEAD;
  const hi = aspect ? Math.min(maxW, maxH * aspect) : maxW;
  const lo = aspect ? Math.max(MIN_BODY.w, MIN_BODY.h * aspect) : MIN_BODY.w;
  return [Math.min(lo, hi), hi];
}

/** Keeps a box inside the reader: not smaller than the minimum, not larger than the reader, aspect kept when there is one. */
export function fit(b: Box, root: Size, aspect: number | null): Box {
  if (aspect) {
    const [lo, hi] = bodyWidthRange(root, aspect);
    const w = clamp(b.w, lo, hi);
    const h = w / aspect + HEAD;
    return round({ x: clamp(b.x, MARGIN, root.w - w - MARGIN), y: clamp(b.y, MARGIN, root.h - h - MARGIN), w, h });
  }
  const w = clamp(b.w, Math.min(MIN_BODY.w, root.w - 2 * MARGIN), root.w - 2 * MARGIN);
  const h = clamp(b.h, Math.min(MIN_BODY.h + HEAD, root.h - 2 * MARGIN), root.h - 2 * MARGIN);
  return round({ x: clamp(b.x, MARGIN, root.w - w - MARGIN), y: clamp(b.y, MARGIN, root.h - h - MARGIN), w, h });
}

/**
 * Where a window opens: at the media's own proportions, about half the reader wide (at most 560 px) and no more than 80 % of its height,
 * at the top right, or at the top left when that covers less of the object that opened it (`anchor`, in the reader's coordinates).
 */
export function openBox(root: Size, aspect: number | null, anchor?: Box | null): Box {
  const free: Size = { w: 440, h: 300 };
  let w = Math.min(560, Math.max(MIN_BODY.w, root.w * 0.5));
  let h = aspect ? w / aspect + HEAD : free.h + HEAD;
  if (!aspect) w = Math.min(w, free.w);
  const tall = root.h * 0.8;
  if (h > tall) {
    h = tall;
    if (aspect) w = (h - HEAD) * aspect;
  }
  const right = fit({ x: root.w - w - 24, y: 24, w, h }, root, aspect);
  const left = fit({ x: 24, y: 24, w, h }, root, aspect);
  if (!anchor) return right;
  // beside the object that opened it: whichever side covers less of it (the right one when it is a tie and the object is on the left half)
  const a = overlap(right, anchor), c = overlap(left, anchor);
  if (a !== c) return a < c ? right : left;
  return anchor.x + anchor.w / 2 > root.w / 2 ? left : right;
}

/** The area two boxes have in common. */
export function overlap(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** The window moved by (dx, dy), kept inside the reader. */
export function move(b: Box, dx: number, dy: number, root: Size): Box {
  return round({ ...b, x: clamp(b.x + dx, MARGIN, root.w - b.w - MARGIN), y: clamp(b.y + dy, MARGIN, root.h - b.h - MARGIN) });
}

/**
 * The window resized by dragging the edge or corner `dir` by (dx, dy) from its `start` box. The opposite edge stays where it is. With an
 * aspect the body keeps it: an edge changes the other dimension to match, a corner follows the larger of the two pulls.
 */
export function resize(start: Box, dir: Dir, dx: number, dy: number, root: Size, aspect: number | null): Box {
  const east = dir.includes('e'), west = dir.includes('w'), north = dir.includes('n'), south = dir.includes('s');
  const sx = east ? 1 : west ? -1 : 0, sy = south ? 1 : north ? -1 : 0;
  // the room on the side being pulled (the window stops at the reader's edge, it does not slide along it); an edge not being pulled grows away from its anchor
  const roomW = sx < 0 ? start.x + start.w - MARGIN : root.w - MARGIN - start.x;
  const roomH = sy < 0 ? start.y + start.h - MARGIN : root.h - MARGIN - start.y;
  let w: number, h: number;
  if (aspect) {
    const fromW = start.w + sx * dx;
    const fromH = (start.h - HEAD + sy * dy) * aspect;
    // an edge is pulled along its own axis; a corner follows whichever pull changes the size more
    const pick = sx && sy ? (Math.abs(fromW - start.w) >= Math.abs(fromH - start.w) ? fromW : fromH) : sx ? fromW : fromH;
    const [lo, hi0] = bodyWidthRange(root, aspect);
    const hi = Math.min(hi0, roomW, (roomH - HEAD) * aspect);
    w = clamp(pick, Math.min(lo, hi), hi);
    h = w / aspect + HEAD;
  } else {
    const minW = Math.min(MIN_BODY.w, root.w - 2 * MARGIN), minH = Math.min(MIN_BODY.h + HEAD, root.h - 2 * MARGIN);
    w = clamp(start.w + sx * dx, minW, Math.min(root.w - 2 * MARGIN, roomW));
    h = clamp(start.h + sy * dy, minH, Math.min(root.h - 2 * MARGIN, roomH));
  }
  const x = west ? start.x + start.w - w : start.x;
  const y = north ? start.y + start.h - h : start.y;
  return fit({ x, y, w, h }, root, aspect);
}

/** The bottom sheet of a narrow reader: the whole width, as tall as the media's proportions ask, at most 70 % of the reader. */
export function sheetBox(root: Size, aspect: number | null): Box {
  const want = aspect ? root.w / aspect + HEAD : root.h * 0.55;
  // the upper bound wins over the lower one: on a very short reader the sheet is smaller than the usual minimum, never taller than the reader
  const hi = Math.min(root.h, Math.max(HEAD + 40, root.h * 0.7));
  const h = Math.round(clamp(want, Math.min(MIN_BODY.h + HEAD, hi), hi));
  return { x: 0, y: Math.max(0, root.h - h), w: root.w, h };
}

/** The body's aspect for an object on the page: its own width over height, or null for a shape that has none (audio) or when the host wants it free. */
export function aspectFor(o: { width: number; height: number }, rule: 'media' | 'free' | number, shapeless = false): number | null {
  if (rule === 'free' || shapeless) return null;
  if (typeof rule === 'number') return Number.isFinite(rule) && rule > 0 ? rule : null;
  return o.width > 0 && o.height > 0 ? clamp(o.width / o.height, 0.25, 4) : 16 / 9;
}
