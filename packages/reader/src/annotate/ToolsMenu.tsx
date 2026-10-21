import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowUpRightIcon, CircleIcon, CursorIcon, EraserIcon, HandIcon, HighlighterIcon, LineSegmentIcon, PenNibIcon, SquareIcon, TextTIcon,
} from '@phosphor-icons/react';
import type { Locale, ReaderConfig, ToolId } from '../config.js';
import { strings } from '../i18n.js';

export const TOOL_ICON: Record<ToolId, (size: number) => ReactNode> = {
  pan: (s) => <HandIcon size={s} />, select: (s) => <CursorIcon size={s} />, pen: (s) => <PenNibIcon size={s} />,
  highlighter: (s) => <HighlighterIcon size={s} />, eraser: (s) => <EraserIcon size={s} />, text: (s) => <TextTIcon size={s} />,
  rect: (s) => <SquareIcon size={s} />, ellipse: (s) => <CircleIcon size={s} />, line: (s) => <LineSegmentIcon size={s} />, arrow: (s) => <ArrowUpRightIcon size={s} />,
};

/** The dock's tools button: the current tool (with its colour), and a popover to change tool, colour and size. */
export function ToolsMenu({ config, locale, tool, color, highlight, size, onTool, onColor, onHighlight, onSize, up }: {
  config: ReaderConfig['annotations']; locale: Locale; tool: ToolId; color: string; highlight: string; size: number;
  onTool: (t: ToolId) => void; onColor: (c: string) => void; onHighlight: (c: string) => void; onSize: (s: number) => void;
  /** Open upward (dock at the bottom) or downward. */
  up: boolean;
}) {
  const t = strings(locale);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    addEventListener('pointerdown', close); addEventListener('keydown', esc);
    return () => { removeEventListener('pointerdown', close); removeEventListener('keydown', esc); };
  }, [open]);
  const drawing = tool !== 'pan' && tool !== 'select' && tool !== 'eraser';
  const swatches = tool === 'highlighter' ? config.highlighterColors : config.colors;
  const current = tool === 'highlighter' ? highlight : color;
  return (
    <span ref={wrap} className="chalk-tools">
      <button type="button" className="chalk-dock-btn" aria-label={`${t.tools}: ${t[tool]}`} data-tip={`${t.tools}: ${t[tool]}`}
        aria-expanded={open} aria-pressed={tool !== 'pan'} onClick={() => setOpen((o) => !o)}>
        {TOOL_ICON[tool](20)}
        {drawing && <span className="chalk-tools-dot" style={{ background: current }} />}
      </button>
      {open && (
        <div className={`chalk-popover ${up ? 'is-up' : 'is-down'}`} role="dialog" aria-label={t.tools}>
          <div className="chalk-tool-grid" role="radiogroup" aria-label={t.tools}>
            {config.tools.map((id) => (
              <button key={id} type="button" role="radio" aria-checked={tool === id} className="chalk-tool" onClick={() => { onTool(id); if (id === 'pan') setOpen(false); }}>
                {TOOL_ICON[id](22)}<span>{t[id]}</span>
              </button>
            ))}
          </div>
          {drawing && (
            <>
              <div className="chalk-swatches" role="radiogroup" aria-label={t.color}>
                {swatches.map((c) => (
                  <button key={c} type="button" role="radio" aria-checked={current === c} aria-label={c} className="chalk-swatch" style={{ background: c }}
                    onClick={() => (tool === 'highlighter' ? onHighlight(c) : onColor(c))} />
                ))}
              </div>
              {tool !== 'highlighter' && (
                <div className="chalk-sizes" role="radiogroup" aria-label={t.size}>
                  {config.sizes.map((s, i) => (
                    <button key={s} type="button" role="radio" aria-checked={size === s} aria-label={`${t.size} ${i + 1}`} className="chalk-size" onClick={() => onSize(s)}>
                      <span style={{ width: 6 + i * 6, height: 6 + i * 6, background: color }} />
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </span>
  );
}
