import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CubeIcon, FilmStripIcon, FlaskIcon, ImageIcon, MusicNotesIcon, PlusIcon, ShapesIcon } from '@phosphor-icons/react';
import type { Locale, ToolId } from '../config.js';
import { strings } from '../i18n.js';
import { TOOL_ICON } from '../annotate/ToolsMenu.js';
import type { MediaKind } from './insert.js';
import type { AuthorStrings } from './i18n.js';

/** The author's tools. `select` moves and sizes things; the rest draw into the book. */
export type AuthorTool = Exclude<ToolId, 'pan'>;
export const SHAPES: AuthorTool[] = ['rect', 'ellipse', 'line', 'arrow'];
/** Keyboard shortcuts, as in ChalkBoard. */
export const SHORTCUTS: Record<string, AuthorTool> = { v: 'select', p: 'pen', h: 'highlighter', e: 'eraser', t: 'text', r: 'rect', o: 'ellipse', l: 'line', a: 'arrow' };
const KEY_OF = Object.fromEntries(Object.entries(SHORTCUTS).map(([k, v]) => [v, k.toUpperCase()])) as Record<AuthorTool, string>;
const MEDIA: { kind: MediaKind; icon: ReactNode }[] = [
  { kind: 'image', icon: <ImageIcon size={20} /> }, { kind: 'video', icon: <FilmStripIcon size={20} /> },
  { kind: 'audio', icon: <MusicNotesIcon size={20} /> }, { kind: 'model3d', icon: <CubeIcon size={20} /> }, { kind: 'lab', icon: <FlaskIcon size={20} /> },
];

/**
 * The tool rail of author mode (left side): select, pen, highlighter, eraser, text, shapes, media to add, and the
 * colour and thickness of what is drawn next.
 */
export function AuthorRail({ tool, onTool, color, onColor, highlight, onHighlight, size, onSize, colors, highlighterColors, sizes, onMedia, locale, t }: {
  tool: AuthorTool; onTool: (t: AuthorTool) => void;
  color: string; onColor: (c: string) => void; highlight: string; onHighlight: (c: string) => void; size: number; onSize: (s: number) => void;
  colors: string[]; highlighterColors: string[]; sizes: number[];
  onMedia: (kind: MediaKind) => void; locale: Locale; t: AuthorStrings;
}) {
  const r = strings(locale);
  const [fly, setFly] = useState<'shapes' | 'media' | 'style' | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [lastShape, setLastShape] = useState<AuthorTool>('rect');
  useEffect(() => { if (SHAPES.includes(tool)) setLastShape(tool); }, [tool]);
  useEffect(() => {
    if (!fly) return;
    const close = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) setFly(null); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setFly(null); };
    addEventListener('pointerdown', close); addEventListener('keydown', esc);
    return () => { removeEventListener('pointerdown', close); removeEventListener('keydown', esc); };
  }, [fly]);

  const name = (x: AuthorTool) => `${r[x]} (${KEY_OF[x]})`;
  const btn = (x: AuthorTool) => (
    <button key={x} type="button" className="chalk-rail-btn" aria-pressed={tool === x} aria-label={name(x)} title={name(x)} onClick={() => { onTool(x); setFly(null); }}>
      {TOOL_ICON[x](22)}
    </button>
  );
  const hl = tool === 'highlighter';
  const swatches = hl ? highlighterColors : colors, cur = hl ? highlight : color, pick = hl ? onHighlight : onColor;

  return (
    <div ref={wrap} className="chalk-rail" role="toolbar" aria-orientation="vertical" aria-label={t.tools}>
      {btn('select')}
      <span className="chalk-rail-sep" />
      {btn('pen')}{btn('highlighter')}{btn('eraser')}{btn('text')}
      <span className="chalk-rail-fly-wrap">
        <button type="button" className="chalk-rail-btn" aria-pressed={SHAPES.includes(tool)} aria-expanded={fly === 'shapes'} aria-label={t.shapes} title={t.shapes}
          onClick={() => (SHAPES.includes(tool) ? setFly(fly === 'shapes' ? null : 'shapes') : (onTool(lastShape), setFly('shapes')))}>
          {SHAPES.includes(tool) ? TOOL_ICON[tool](22) : <ShapesIcon size={22} />}
        </button>
        {fly === 'shapes' && <div className="chalk-rail-fly" role="group" aria-label={t.shapes}>{SHAPES.map(btn)}</div>}
      </span>
      <span className="chalk-rail-sep" />
      <span className="chalk-rail-fly-wrap">
        <button type="button" className="chalk-rail-btn is-add" aria-expanded={fly === 'media'} aria-label={t.add} title={t.add} onClick={() => setFly(fly === 'media' ? null : 'media')}>
          <PlusIcon size={22} weight="bold" />
        </button>
        {fly === 'media' && (
          <div className="chalk-rail-fly is-list" role="menu" aria-label={t.add}>
            {MEDIA.map((m) => (
              <button key={m.kind} type="button" role="menuitem" className="chalk-rail-item" onClick={() => { setFly(null); onMedia(m.kind); }}>
                {m.icon}<span>{t[m.kind]}</span>
              </button>
            ))}
          </div>
        )}
      </span>
      {tool !== 'select' && tool !== 'eraser' && (
        <>
          <span className="chalk-rail-sep" />
          <span className="chalk-rail-fly-wrap">
            <button type="button" className="chalk-rail-btn" aria-expanded={fly === 'style'} aria-label={`${r.color} · ${r.size}`} title={`${r.color} · ${r.size}`} onClick={() => setFly(fly === 'style' ? null : 'style')}>
              <span className="chalk-rail-dot" style={{ background: cur, width: 8 + Math.min(14, size), height: 8 + Math.min(14, size) }} />
            </button>
            {fly === 'style' && (
              <div className="chalk-rail-fly is-style" role="group" aria-label={r.color}>
                <div className="chalk-rail-swatches">
                  {swatches.map((c) => <button key={c} type="button" className="chalk-rail-swatch" style={{ background: c }} aria-label={c} aria-pressed={c === cur} onClick={() => pick(c)} />)}
                </div>
                <div className="chalk-rail-sizes">
                  {sizes.map((s) => (
                    <button key={s} type="button" className="chalk-rail-size" aria-label={`${r.size} ${s}`} aria-pressed={s === size} onClick={() => onSize(s)}>
                      <span style={{ width: Math.min(22, s * 1.6 + 2), height: Math.min(22, s * 1.6 + 2), background: cur }} />
                    </button>
                  ))}
                </div>
              </div>
            )}
          </span>
        </>
      )}
    </div>
  );
}
