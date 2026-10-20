import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getPageSize, type LessonPage } from '@chalk-format/model';
import type { Book } from './book.js';
import type { Fit, Layout } from './config.js';
import { PageView, type HtmlObjectRenderer } from './render/PageView.js';

const GAP = 16;   // px between pages and rows
const PAD = 16;   // px around the column
const READING_WIDTH = 900;   // fit 'auto': widest a page is drawn at zoom 1, in CSS px

export type ViewerHandle = {
  /** Scroll to a page (0-based). */
  goTo(index: number, smooth?: boolean): void;
  /** Scroll so a point on a page (page units) is in view, a third of the way down (search hits). */
  reveal(index: number, x: number, y: number): void;
  /** Zoom to an absolute factor, keeping the point at (clientX, clientY), or the view's centre, still. */
  zoomTo(zoom: number, anchor?: { clientX: number; clientY: number }): void;
  /** The scroll element (for the reader's keyboard and gesture handling). */
  readonly element: HTMLDivElement | null;
};

export type ViewerProps = {
  book: Book;
  pages: readonly LessonPage[];
  layout: Layout;
  fit: Fit;
  zoom: number;
  zoomRange: { min: number; max: number };
  onZoom: (zoom: number) => void;
  onPage: (index: number) => void;
  /** The page shown in single layout (and where to start). */
  page: number;
  renderHtmlObject: HtmlObjectRenderer;
  textLayer: boolean;
  /** Pointer gestures for panning and pinch zoom; off while a drawing tool owns the pointer. */
  gestures: boolean;
  highlights?: (pageIndex: number) => { x: number; y: number; width: number; height: number; current?: boolean }[] | undefined;
  pageOverlay?: (page: LessonPage, index: number, scale: number) => ReactNode;
  pageActive?: (page: LessonPage, index: number, scale: number) => ReactNode;
  pageLabel: (index: number) => string;
};

type Row = { pages: number[]; top: number; height: number; width: number };

/**
 * The scrolling column of pages. Continuous: pages one under another. Spread: the cover alone, then pairs.
 * Single: one page at a time. Only rows near the view get their content (`live`), so a long book stays
 * cheap; the rest are correctly sized boxes, so the scroll bar and positions are right from the start.
 */
export const Viewer = forwardRef<ViewerHandle, ViewerProps>(function Viewer(p, ref) {
  const el = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [scroll, setScroll] = useState({ top: 0 });
  const anchor = useRef<{ fx: number; fy: number; ax: number; ay: number } | null>(null);
  const zoomRef = useRef(p.zoom); zoomRef.current = p.zoom;

  useLayoutEffect(() => {
    const e = el.current; if (!e) return;
    const ro = new ResizeObserver(() => setBox({ w: e.clientWidth, h: e.clientHeight }));
    ro.observe(e); setBox({ w: e.clientWidth, h: e.clientHeight });
    return () => ro.disconnect();
  }, []);

  // rows of page indexes for the layout
  const groups = useMemo(() => {
    const n = p.pages.length, out: number[][] = [];
    if (p.layout === 'single') out.push([Math.min(Math.max(0, p.page), n - 1)]);
    else if (p.layout === 'spread' && box.w >= 720) { if (n) out.push([0]); for (let i = 1; i < n; i += 2) out.push(i + 1 < n ? [i, i + 1] : [i]); }
    else for (let i = 0; i < n; i++) out.push([i]);
    return out;
  }, [p.pages.length, p.layout, p.page, box.w]);

  // fit scale: every row fits the width (the gaps between pages are screen pixels), and with fit page the
  // tallest page fits the height too
  const fitScale = useMemo(() => {
    if (!box.w || !p.pages.length) return 1;
    let fit = Infinity;
    for (const g of groups) {
      const sizes = g.map((i) => getPageSize(p.pages[i]!));
      fit = Math.min(fit, (box.w - 2 * PAD - (g.length - 1) * GAP) / sizes.reduce((a, s) => a + s.width, 0));
      if (p.fit === 'auto') fit = Math.min(fit, READING_WIDTH / Math.max(...sizes.map((s) => s.width)));
      if (p.fit === 'page' && box.h) fit = Math.min(fit, (box.h - 2 * PAD) / Math.max(...sizes.map((s) => s.height)));
    }
    return Math.max(0.01, fit);
  }, [box.w, box.h, groups, p.pages, p.fit]);
  const scale = fitScale * p.zoom;

  const rows: Row[] = useMemo(() => {
    let top = PAD;
    return groups.map((g) => {
      const sizes = g.map((i) => getPageSize(p.pages[i]!));
      const r = { pages: g, top, height: Math.max(...sizes.map((s) => s.height)) * scale, width: sizes.reduce((a, s) => a + s.width * scale, 0) + (g.length - 1) * GAP };
      top += r.height + GAP;
      return r;
    });
  }, [groups, p.pages, scale]);
  const contentH = rows.length ? rows[rows.length - 1]!.top + rows[rows.length - 1]!.height + PAD : 0;
  const contentW = Math.max(box.w, ...rows.map((r) => r.width + 2 * PAD));

  // keep the zoom anchor still: the content point under it before the zoom is under it after
  useLayoutEffect(() => {
    const e = el.current, a = anchor.current; if (!e || !a) return;
    anchor.current = null;
    e.scrollLeft = a.fx * contentW - a.ax;
    e.scrollTop = a.fy * contentH - a.ay;
  }, [scale, contentW, contentH]);

  const onScroll = useCallback(() => {
    const e = el.current; if (!e) return;
    setScroll({ top: e.scrollTop });
  }, []);

  // the current page: the row with most of itself on screen (the first on a tie), so a short page at the
  // top counts and a page only peeking in at the bottom does not
  useEffect(() => {
    if (p.layout === 'single' || !rows.length || !box.h) return;
    const top = scroll.top, bottom = scroll.top + box.h;
    let best = 0, bestSeen = -1;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      if (r.top > bottom) break;
      const seen = Math.max(0, Math.min(bottom, r.top + r.height) - Math.max(top, r.top)) / Math.min(r.height, box.h);
      if (seen > bestSeen + 0.01) { best = i; bestSeen = seen; }
    }
    p.onPage(rows[best]!.pages[0]!);
  }, [scroll.top, rows, box.h, p.layout]);   // eslint-disable-line react-hooks/exhaustive-deps

  useImperativeHandle(ref, () => ({
    get element() { return el.current; },
    goTo(index, smooth = false) {
      const e = el.current; if (!e) return;
      if (p.layout === 'single') { p.onPage(index); e.scrollTo({ top: 0 }); return; }
      const row = rows.find((r) => r.pages.includes(index)); if (!row) return;
      e.scrollTo({ top: row.top - PAD, behavior: smooth ? 'smooth' : 'auto' });
    },
    reveal(index, x, y) {
      const e = el.current; if (!e) return;
      if (p.layout === 'single' && index !== p.page) p.onPage(index);
      const row = rows.find((r) => r.pages.includes(index)) ?? rows[0]; if (!row) return;
      let left = Math.max(PAD, (contentW - row.width) / 2);
      for (const i of row.pages) { if (i === index) break; left += getPageSize(p.pages[i]!).width * scale + GAP; }
      e.scrollTo({ top: row.top + y * scale - e.clientHeight / 3, left: left + x * scale - e.clientWidth / 2, behavior: 'smooth' });
    },
    zoomTo(z, at) {
      const e = el.current; if (!e) return;
      const nz = Math.min(p.zoomRange.max, Math.max(p.zoomRange.min, z));
      if (nz === zoomRef.current) return;
      const rect = e.getBoundingClientRect();
      const ax = at ? at.clientX - rect.left : e.clientWidth / 2, ay = at ? at.clientY - rect.top : e.clientHeight / 2;
      anchor.current = { fx: (e.scrollLeft + ax) / contentW, fy: (e.scrollTop + ay) / Math.max(1, contentH), ax, ay };
      p.onZoom(nz);
    },
  }), [rows, contentW, contentH, scale, p]);

  // ctrl/⌘ + wheel (and trackpad pinch, which browsers send as ctrl + wheel) zooms at the pointer
  useEffect(() => {
    const e = el.current; if (!e) return;
    const onWheel = (w: WheelEvent) => {
      if (!w.ctrlKey && !w.metaKey) return;
      w.preventDefault();
      const z = zoomRef.current * Math.exp(-w.deltaY * 0.01);
      const nz = Math.min(p.zoomRange.max, Math.max(p.zoomRange.min, z));
      const rect = e.getBoundingClientRect(), ax = w.clientX - rect.left, ay = w.clientY - rect.top;
      anchor.current = { fx: (e.scrollLeft + ax) / contentW, fy: (e.scrollTop + ay) / Math.max(1, contentH), ax, ay };
      p.onZoom(nz);
    };
    e.addEventListener('wheel', onWheel, { passive: false });
    return () => e.removeEventListener('wheel', onWheel);
  }, [p, contentW, contentH]);

  // two-finger pinch on touch screens (one finger scrolls natively)
  const pinch = useRef<{ ids: Map<number, { x: number; y: number }>; start?: { d: number; z: number } }>({ ids: new Map() });
  const onPointerDown = (e: React.PointerEvent) => { if (p.gestures && e.pointerType === 'touch') pinch.current.ids.set(e.pointerId, { x: e.clientX, y: e.clientY }); };
  const onPointerMove = (e: React.PointerEvent) => {
    const g = pinch.current; if (!g.ids.has(e.pointerId)) return;
    g.ids.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (g.ids.size !== 2) return;
    const [a, b] = [...g.ids.values()] as [{ x: number; y: number }, { x: number; y: number }];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (!g.start) { g.start = { d, z: zoomRef.current }; return; }
    const z = g.start.z * (d / g.start.d), e2 = el.current; if (!e2) return;
    const nz = Math.min(p.zoomRange.max, Math.max(p.zoomRange.min, z));
    const rect = e2.getBoundingClientRect(), ax = (a.x + b.x) / 2 - rect.left, ay = (a.y + b.y) / 2 - rect.top;
    anchor.current = { fx: (e2.scrollLeft + ax) / contentW, fy: (e2.scrollTop + ay) / Math.max(1, contentH), ax, ay };
    p.onZoom(nz);
  };
  const onPointerUp = (e: React.PointerEvent) => { const g = pinch.current; g.ids.delete(e.pointerId); if (g.ids.size < 2) delete g.start; };

  const near = (r: Row) => r.top + r.height > scroll.top - box.h && r.top < scroll.top + 2 * box.h;
  return (
    <div
      ref={el} className="chalk-viewer" onScroll={onScroll} tabIndex={0}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      style={{ touchAction: p.gestures ? 'pan-x pan-y' : 'none' }}
    >
      <div className="chalk-column" style={{ width: contentW, height: contentH }}>
        {rows.map((r) => (
          <div key={r.pages.join('-')} className="chalk-row" style={{ top: r.top, height: r.height, width: r.width, left: Math.max(PAD, (contentW - r.width) / 2) }}>
            {r.pages.map((i) => (
              <PageView
                key={p.pages[i]!.id} book={p.book} page={p.pages[i]!} scale={scale} live={near(r)}
                renderHtmlObject={p.renderHtmlObject} textLayer={p.textLayer} highlights={p.highlights?.(i)}
                overlay={p.pageOverlay?.(p.pages[i]!, i, scale)} active={p.pageActive?.(p.pages[i]!, i, scale)} label={p.pageLabel(i)}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
});
