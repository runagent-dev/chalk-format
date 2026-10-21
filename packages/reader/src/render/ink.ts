import { getStroke } from 'perfect-freehand';

/**
 * Ink as the spec's reference renders it (1.0 §3.4): the flat `[x1, y1, x2, y2, …]` points (offsets from
 * the object's x, y) turned into a smoothed, filled outline with simulated pressure, `size` the diameter.
 * Same perfect-freehand settings as the ChalkBook editor, so a stroke looks the same in both.
 */
export function inkPath(points: readonly number[], size: number, last = true): string {
  if (points.length < 2) return '';
  const pts: number[][] = [];
  for (let i = 0; i + 1 < points.length; i += 2) pts.push([points[i]!, points[i + 1]!]);
  const outline = getStroke(pts, { size, thinning: 0.5, smoothing: 0.5, streamline: 0.5, simulatePressure: true, last });
  return outlinePath(outline);
}

/** A closed path through the outline's midpoints with quadratic curves (perfect-freehand's own recipe). */
export function outlinePath(outline: readonly (readonly number[])[]): string {
  if (outline.length === 0) return '';
  const r = (v: number) => Math.round(v * 100) / 100;
  if (outline.length === 1) return `M ${r(outline[0]![0]!)} ${r(outline[0]![1]!)}`;
  const parts: (string | number)[] = ['M', r(outline[0]![0]!), r(outline[0]![1]!), 'Q'];
  for (let i = 0; i < outline.length; i++) {
    const [x0, y0] = outline[i]! as [number, number], [x1, y1] = outline[(i + 1) % outline.length]! as [number, number];
    parts.push(r(x0), r(y0), r((x0 + x1) / 2), r((y0 + y1) / 2));
  }
  parts.push('Z');
  return parts.join(' ');
}
