import type { InkObject } from './lesson.js';
import { generateId } from './helpers.js';

/** Spacing (px, in the ink's local point space) used to resample a
 *  stroke before bucketing it inside/outside a circle — matches
 *  EraserTool's existing `segmentStep` pattern for sweeping a pointer
 *  drag. */
const RESAMPLE_STEP = 2;

interface Point {
  x: number;
  y: number;
}

/** Resample a flattened [x0,y0,x1,y1,...] polyline to ~`step`px spacing,
 *  preserving every original vertex as a resample boundary. */
function resamplePolyline(points: readonly number[], step: number): Point[] {
  if (points.length < 2) return [];
  if (points.length === 2) return [{ x: points[0]!, y: points[1]! }];
  const out: Point[] = [{ x: points[0]!, y: points[1]! }];
  for (let i = 0; i + 3 < points.length; i += 2) {
    const x1 = points[i]!;
    const y1 = points[i + 1]!;
    const x2 = points[i + 2]!;
    const y2 = points[i + 3]!;
    const dist = Math.hypot(x2 - x1, y2 - y1);
    const samples = Math.max(1, Math.round(dist / step));
    for (let s = 1; s <= samples; s++) {
      const t = s / samples;
      out.push({ x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t });
    }
  }
  return out;
}

/**
 * Splits `ink` around a circle at absolute page coordinates (`cx`, `cy`)
 * with radius `radius`, returning the surviving fragments as new
 * InkObjects (0, 1, or many — 0 when the whole stroke falls inside the
 * circle, 1 when only an end is clipped, 2+ when the circle cuts through
 * the middle). `radius` is grown by `ink.size / 2` so the visible stroke
 * width — not just its centerline — is what actually disappears,
 * matching `hitInk`'s own `size/2 + tolerance` threshold.
 *
 * Approximates the intersection by resampling the polyline at ~2px
 * spacing (`resamplePolyline`) and bucketing each sample inside/outside
 * the circle, rather than computing the exact analytic circle-segment
 * intersection — plenty precise for a hand-drawn erase gesture and far
 * simpler to implement and verify. Contiguous "outside" runs of at least
 * 2 points become a fragment; a lone straggler point is dropped (not a
 * valid stroke).
 */
export function trimInkByCircle(ink: InkObject, cx: number, cy: number, radius: number): InkObject[] {
  const effRadius = radius + ink.size / 2;
  const local = resamplePolyline(ink.points, RESAMPLE_STEP);

  if (local.length === 0) return [];

  const isOutside = (p: Point): boolean => {
    const dx = ink.x + p.x - cx;
    const dy = ink.y + p.y - cy;
    return Math.hypot(dx, dy) > effRadius;
  };

  if (local.length === 1) {
    // A single-point stroke is a dot (see hitInk) — gone if the circle
    // covers it, unchanged otherwise.
    return isOutside(local[0]!) ? [ink] : [];
  }

  const fragments: InkObject[] = [];
  let run: Point[] = [];
  const flushRun = () => {
    if (run.length >= 2) {
      fragments.push({ ...ink, id: generateId('ink'), points: run.flatMap((p) => [p.x, p.y]) });
    }
    run = [];
  };
  for (const p of local) {
    if (isOutside(p)) run.push(p);
    else flushRun();
  }
  flushRun();
  return fragments;
}
