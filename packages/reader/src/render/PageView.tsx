import { memo, type ReactNode } from 'react';
import { getPageSize, type LessonObject, type LessonPage, type PageBackground } from '@chalk-format/model';
import type { Book } from '../book.js';
import { useAssetUrl } from './assets.js';
import { inkPath } from './ink.js';
import { TextLayer } from './TextLayer.js';

/** Objects drawn as HTML by the reader (media, labs, snips, icon-mode markers): it plugs in their behaviour. */
export type HtmlObject = Extract<LessonObject, { type: 'embed' | 'snip' | 'image' }>;
export type HtmlObjectRenderer = (o: HtmlObject, page: LessonPage) => ReactNode;

export type PageViewProps = {
  book: Book;
  page: LessonPage;
  /** Screen pixels per page unit. */
  scale: number;
  /** Draw content, or only the sized box (pages far from the view). */
  live: boolean;
  renderHtmlObject: HtmlObjectRenderer;
  /** Selectable / searchable text from the source (spec 1.0 §3.2). */
  textLayer?: boolean | undefined;
  /** Search hits to highlight, in page units. */
  highlights?: { x: number; y: number; width: number; height: number; current?: boolean }[] | undefined;
  /** Drawn above everything (the annotation surface). */
  overlay?: ReactNode | undefined;
  /** Live embeds (a running lab, a 3D viewer) in screen pixels above the page, so they stay sharp at any zoom. */
  active?: ReactNode | undefined;
  label?: string | undefined;
};

/**
 * One page: its background, then its objects in array order (later on top, spec 1.0 §3.2). Vector objects
 * are batched into SVG runs; text and embeds are HTML elements between those runs, so a mix of types still
 * draws in the book's order. Everything lives in page units inside one box scaled to the screen.
 */
export const PageView = memo(function PageView(p: PageViewProps) {
  const { width, height } = getPageSize(p.page);
  return (
    <div className="chalk-page" style={{ width: width * p.scale, height: height * p.scale }} aria-label={p.label} role="img">
      {p.live && (
        <div className="chalk-page-units" style={{ width, height, transform: `scale(${p.scale})` }}>
          <Background book={p.book} bg={p.page.background} width={width} height={height} />
          {runs(p.page.objects).map((run, i) =>
            run.kind === 'svg'
              ? <svg key={i} className="chalk-layer" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>{run.items.map((o) => <VectorObject key={o.id} o={o} book={p.book} />)}</svg>
              : <HtmlItem key={run.item.id} o={run.item} page={p.page} render={p.renderHtmlObject} />)}
          {p.textLayer !== false && p.page.textLayer && <TextLayer runs={p.page.textLayer} />}
          {p.highlights && p.highlights.length > 0 && (
            <svg className="chalk-layer chalk-hits" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
              {p.highlights.map((h, i) => <rect key={i} x={h.x} y={h.y} width={h.width} height={h.height} rx={2} className={h.current ? 'is-current' : undefined} />)}
            </svg>
          )}
          {p.overlay}
        </div>
      )}
      {p.live && p.active && <div className="chalk-page-active">{p.active}</div>}
    </div>
  );
});

type Run = { kind: 'svg'; items: LessonObject[] } | { kind: 'html'; item: LessonObject };
const isHtml = (o: LessonObject) => o.type === 'text' || o.type === 'embed' || o.type === 'snip' || (o.type === 'image' && o.displayMode === 'icon');
function runs(objects: readonly LessonObject[]): Run[] {
  const out: Run[] = [];
  for (const o of objects) {
    if (isHtml(o)) { out.push({ kind: 'html', item: o }); continue; }
    const last = out[out.length - 1];
    if (last && last.kind === 'svg') last.items.push(o); else out.push({ kind: 'svg', items: [o] });
  }
  return out;
}

function Background({ book, bg, width, height }: { book: Book; bg: PageBackground; width: number; height: number }) {
  const imageId = bg.type === 'image' ? bg.assetId : bg.type === 'pdf_page' ? bg.renderedImageAssetId : undefined;
  const url = useAssetUrl(book, imageId);
  const color = bg.type === 'color' ? bg.color : '#fff';
  return (
    <div className="chalk-bg" style={{ width, height, background: color }}>
      {imageId && url && <img src={url} alt="" draggable={false} width={width} height={height} decoding="async" />}
      {bg.type === 'pdf_page' && !imageId && <div className="chalk-bg-missing">PDF</div>}
    </div>
  );
}

/** Spec 1.0 §3.4: the arrow head is at (x2, y2), length and width max(8, 3 × strokeWidth). */
function arrowHead(x1: number, y1: number, x2: number, y2: number, strokeWidth: number): string {
  const len = Math.max(8, 3 * strokeWidth), half = len / 2;
  const a = Math.atan2(y2 - y1, x2 - x1), bx = x2 - len * Math.cos(a), by = y2 - len * Math.sin(a);
  const nx = -Math.sin(a) * half, ny = Math.cos(a) * half;
  return `${x2},${y2} ${bx + nx},${by + ny} ${bx - nx},${by - ny}`;
}

function VectorObject({ o, book }: { o: LessonObject; book: Book }) {
  switch (o.type) {
    case 'rect': return <rect x={o.x} y={o.y} width={o.width} height={o.height} fill={o.fill} stroke={o.stroke} strokeWidth={o.strokeWidth} />;
    case 'ellipse': return <ellipse cx={o.x + o.width / 2} cy={o.y + o.height / 2} rx={Math.abs(o.width) / 2} ry={Math.abs(o.height) / 2} fill={o.fill} stroke={o.stroke} strokeWidth={o.strokeWidth} />;
    case 'ink': return <path d={inkPath(o.points, o.size)} transform={`translate(${o.x} ${o.y})`} fill={o.color} />;
    case 'line': return <line x1={o.x} y1={o.y} x2={o.x2} y2={o.y2} stroke={o.stroke} strokeWidth={o.strokeWidth} strokeLinecap="round" />;
    case 'arrow': {
      // the shaft stops at the head's base so a thick line does not poke through the tip
      const len = Math.max(8, 3 * o.strokeWidth), a = Math.atan2(o.y2 - o.y, o.x2 - o.x);
      return (
        <g>
          <line x1={o.x} y1={o.y} x2={o.x2 - len * 0.9 * Math.cos(a)} y2={o.y2 - len * 0.9 * Math.sin(a)} stroke={o.stroke} strokeWidth={o.strokeWidth} strokeLinecap="round" />
          <polygon points={arrowHead(o.x, o.y, o.x2, o.y2, o.strokeWidth)} fill={o.stroke} />
        </g>
      );
    }
    case 'vector': return <path d={o.path} transform={`translate(${o.x} ${o.y})`} fill={o.fill ?? 'none'} stroke={o.stroke} strokeWidth={o.strokeWidth} />;
    case 'image': return <ImageObject o={o} book={book} />;
    default: return null;
  }
}

function ImageObject({ o, book }: { o: Extract<LessonObject, { type: 'image' }>; book: Book }) {
  const url = useAssetUrl(book, o.assetId);
  return url ? <image href={url} x={o.x} y={o.y} width={o.width} height={o.height} preserveAspectRatio="none" /> : <rect x={o.x} y={o.y} width={o.width} height={o.height} className="chalk-placeholder" />;
}

function HtmlItem({ o, page, render }: { o: LessonObject; page: LessonPage; render: HtmlObjectRenderer }) {
  if (o.type === 'text') {
    return <div className="chalk-text" style={{ left: o.x, top: o.y, fontSize: o.fontSize, color: o.fill }}>{o.text}</div>;
  }
  if (o.type === 'embed' || o.type === 'snip' || o.type === 'image') return <>{render(o, page)}</>;
  return null;
}
