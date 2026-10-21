import { memo } from 'react';
import type { TextRun } from '@chalk-format/model';

// Run widths measured once per font size and text, with the same font the layer is drawn in.
let ctx: CanvasRenderingContext2D | null = null;
const widths = new Map<string, number>();
function measure(text: string, fontSize: number): number {
  const key = `${fontSize}|${text}`;
  const hit = widths.get(key); if (hit !== undefined) return hit;
  ctx ??= document.createElement('canvas').getContext('2d');
  let w = text.length * fontSize * 0.5;
  if (ctx) { ctx.font = `${fontSize}px "Noto Sans", "Noto Sans Bengali", sans-serif`; w = ctx.measureText(text).width; }
  widths.set(key, w);
  return w;
}

/**
 * The page's text layer (spec 1.0 §3.2): positioned plain text from the source, not drawn, there for
 * selection, copying, search and screen readers. Each run is stretched to its recorded width so a
 * selection covers the printed words.
 */
export const TextLayer = memo(function TextLayer({ runs }: { runs: readonly TextRun[] }) {
  return (
    <div className="chalk-textlayer">
      {runs.map((r, i) => {
        const natural = measure(r.text, r.fontSize);
        const sx = natural > 0 && r.width > 0 ? r.width / natural : 1;
        return (
          <span key={i} style={{ left: r.x, top: r.y, fontSize: r.fontSize, transform: `scaleX(${sx})` }}>{r.text}</span>
        );
      })}
    </div>
  );
});
