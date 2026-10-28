import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { XIcon } from '@phosphor-icons/react';
import { SHEET_BELOW, STEP, STEP_BIG, fit, move, openBox, resize, sheetBox, type Box, type Dir, type Size } from './windowGeometry.js';
import type { RenderWindow, WindowLayout } from './windowTypes.js';

/**
 * The floating window (spec 1.6): media that opens over the page without hiding it. Not a dialog in the modal sense: no backdrop, the page behind
 * stays scrollable and usable, and a keyboard user is not trapped. It is drawn into the reader's own root, so the theme tokens apply.
 *
 * Layouts: `floating` (move by the header, resize by the edges and corners, arrow keys move it, Alt+arrows resize it), `side` (a panel on one
 * side, full height), and, whenever the reader is narrower than SHEET_BELOW, a sheet across the bottom. The strip the reader's dock uses is left
 * free, so the dock stays reachable. Hosts restyle it through the `chalk-window*` classes, `data-layout` and the `--chalk-window-*` variables,
 * or replace the chrome with `render`.
 */

/** The strip of the reader the dock uses, per dock position (the page keeps the same room: styles.css). */
const DOCK_STRIP = { bottom: 72, top: 72, left: 84, right: 84 } as const;
const DIRS: Dir[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

type Area = { left: number; top: number; size: Size };

/** The part of the reader the window may use: all of it, less the dock's strip. */
function areaOf(el: HTMLElement): Area {
  const w = el.clientWidth, h = el.clientHeight, dock = el.getAttribute('data-dock');
  const strip = dock === 'bottom' || dock === 'top' || dock === 'left' || dock === 'right' ? DOCK_STRIP[dock] : 0;
  return {
    left: dock === 'left' ? strip : 0,
    top: dock === 'top' ? strip : 0,
    size: { w: w - (dock === 'left' || dock === 'right' ? strip : 0), h: h - (dock === 'top' || dock === 'bottom' ? strip : 0) },
  };
}

export function FloatingWindow({ title, closeLabel, hint, container, aspect, layout, anchor, opener, render, onClose, children }: {
  title: string; closeLabel: string;
  /** Said once to assistive technology: how to move and resize with the keyboard. */
  hint: string;
  container: HTMLElement | null;
  /** The body's width / height, or null for a free shape. */
  aspect: number | null;
  layout: WindowLayout;
  /** The object that opened it, in the reader's coordinates: the window opens beside it, not over it, when it can. */
  anchor?: Box | null | undefined;
  /** What was tapped to open it: focus goes back there when the window closes (unless the student already moved on to something else). */
  opener?: HTMLElement | null | undefined;
  render?: RenderWindow | undefined;
  onClose: () => void;
  children: ReactNode;
}) {
  const win = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState<Area | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  const [busy, setBusy] = useState(false);
  const boxRef = useRef<Box | null>(null); boxRef.current = box;

  // the room the window has: measured now and whenever the reader changes size
  useLayoutEffect(() => {
    if (!container) return;
    const measure = () => setArea(areaOf(container));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(container);
    return () => ro.disconnect();
  }, [container]);

  const narrow = Boolean(container && container.clientWidth < SHEET_BELOW);
  const kind: 'floating' | 'side' | 'sheet' = narrow ? 'sheet' : layout.kind === 'side' ? 'side' : 'floating';

  // where it opens (once), and kept inside the reader when that changes size
  useLayoutEffect(() => {
    if (!area) return;
    setBox((b) => (b ? fit(b, area.size, aspect) : openBox(area.size, aspect, anchor ? { ...anchor, x: anchor.x - area.left, y: anchor.y - area.top } : null)));
    // the anchor and aspect are of this window's own object: a new object is a new window (the caller keys it)
  }, [area]); // eslint-disable-line react-hooks/exhaustive-deps

  // focus returns to what opened the window when it closes; the page behind is never made inert
  const openerRef = useRef(opener); openerRef.current = opener;
  useEffect(() => {
    const before = (openerRef.current ?? document.activeElement) as HTMLElement | null;
    return () => {
      // only when focus was lost with the window (it is on the page itself): if the student tapped another card, which replaces this window, focus is already theirs
      const now = document.activeElement;
      if (before && document.contains(before) && (!now || now === document.body)) before.focus?.({ preventScroll: true });
    };
  }, []);
  // ...and moves into the window once it exists: the first render has no room measured yet and draws nothing, so this cannot be a mount-only effect
  const shown = Boolean(container && area && box);
  useEffect(() => { if (shown) win.current?.focus({ preventScroll: true }); }, [shown]);

  const place = useCallback((next: Box) => setBox(next), []);
  const drag = useRef<{ id: number; x: number; y: number; start: Box; dir: Dir | 'move' } | null>(null);

  const down = (dir: Dir | 'move') => (e: ReactPointerEvent<HTMLElement>) => {
    if (kind !== 'floating' || !boxRef.current || (e.button !== 0 && e.pointerType === 'mouse')) return;
    if (dir === 'move' && (e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, start: boxRef.current, dir };
    setBusy(true);
  };
  const moved = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId || !area) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    place(d.dir === 'move' ? move(d.start, dx, dy, area.size) : resize(d.start, d.dir, dx, dy, area.size, aspect));
  };
  const up = (e: ReactPointerEvent<HTMLElement>) => {
    if (drag.current?.id === e.pointerId) { drag.current = null; setBusy(false); }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); onClose(); return; }
    // arrows on the header (or the window itself) move it; with Alt they resize it. Elsewhere in the window they belong to the media.
    const onChrome = e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('chalk-window-head');
    const arrow = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, [number, number]>)[e.key];
    if (!arrow || !onChrome || kind !== 'floating' || !boxRef.current || !area) return;
    e.preventDefault(); e.stopPropagation();
    const s = e.shiftKey ? STEP_BIG : STEP;
    place(e.altKey ? resize(boxRef.current, 'se', arrow[0] * s, arrow[1] * s, area.size, aspect) : move(boxRef.current, arrow[0] * s, arrow[1] * s, area.size));
  };

  if (!container || !area || !box) return null;

  const sheet = kind === 'sheet' ? sheetBox(area.size, aspect) : null;
  const style: CSSProperties & Record<string, string | number> = kind === 'floating'
    ? { '--chalk-window-x': `${area.left + box.x}px`, '--chalk-window-y': `${area.top + box.y}px`, '--chalk-window-w': `${box.w}px`, '--chalk-window-h': `${box.h}px` }
    : kind === 'sheet' && sheet
      ? { '--chalk-window-x': `${area.left + sheet.x}px`, '--chalk-window-y': `${area.top + sheet.y}px`, '--chalk-window-w': `${sheet.w}px`, '--chalk-window-h': `${sheet.h}px` }
      : { '--chalk-window-side-w': layout.width };

  if (render) {
    return createPortal(
      <div ref={win} tabIndex={-1} className="chalk-window-layer chalk-window-custom" data-layout={kind} onKeyDown={onKeyDown}>
        {render({ title, onClose, aspect, kind, children })}
      </div>,
      container,
    );
  }

  return createPortal(
    <div className="chalk-window-layer" data-layout={kind} data-side={kind === 'side' ? layout.side : undefined}>
      <div
        ref={win} className={`chalk-window${busy ? ' is-busy' : ''}`} data-layout={kind} data-side={kind === 'side' ? layout.side : undefined}
        role="dialog" aria-modal="false" aria-label={title} aria-describedby={kind === 'floating' ? 'chalk-window-hint' : undefined}
        tabIndex={-1} style={style} onKeyDown={onKeyDown}
      >
        <header className="chalk-window-head" tabIndex={kind === 'floating' ? 0 : undefined} onPointerDown={down('move')} onPointerMove={moved} onPointerUp={up} onPointerCancel={up}>
          <h2>{title}</h2>
          <button type="button" className="chalk-icon-btn" aria-label={closeLabel} onClick={onClose}><XIcon size={18} weight="bold" /></button>
        </header>
        <div className="chalk-window-body">
          {aspect && kind !== 'floating'
            ? <div className="chalk-window-frame" style={{ '--chalk-window-aspect': String(aspect) } as CSSProperties}>{children}</div>
            : <div className="chalk-window-frame is-fill">{children}</div>}
        </div>
        {kind === 'floating' && DIRS.map((d) => (
          <span key={d} className="chalk-window-grip" data-dir={d} aria-hidden onPointerDown={down(d)} onPointerMove={moved} onPointerUp={up} onPointerCancel={up} />
        ))}
        {kind === 'floating' && <span id="chalk-window-hint" className="chalk-visually-hidden">{hint}</span>}
      </div>
    </div>,
    container,
  );
}
