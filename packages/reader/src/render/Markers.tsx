import type { CSSProperties, ReactNode } from 'react';
import { MEDIA_ICON_SIZE, SNIP_ICON_SIZE, type EmbedObject, type LessonObject } from '@chalk-format/model';
import type { Book } from '../book.js';
import { kindOf, usePresenter } from '../present.js';
import { useAssetUrl } from './assets.js';

/** Called with the activated element, so the reader can see how big it is on screen. */
export type Activate = (el: HTMLElement) => void;

/** Positioned at an object's box, in page units. */
export function Box({ x, y, width, height, className, children, label, title, onActivate, style, id, kind }: {
  x: number; y: number; width: number; height: number; className?: string | undefined; children?: ReactNode; label?: string | undefined;
  title?: string | undefined; onActivate?: Activate | undefined; style?: CSSProperties | undefined; id?: string | undefined; kind?: string | null | undefined;
}) {
  const s = { left: x, top: y, width, height, ...style };
  const a = { 'aria-label': label, title, 'data-chalk-id': id, 'data-kind': kind ?? undefined };
  return onActivate
    ? <button type="button" className={`chalk-box ${className ?? ''}`} style={s} {...a} onClick={(e) => onActivate(e.currentTarget)}>{children}</button>
    : <div className={`chalk-box ${className ?? ''}`} style={s} {...a}>{children}</div>;
}

/**
 * A media card: the poster scaled to cover the box (or a neutral tile), the object's icon and its caption.
 * What a reader draws for an embed before it plays, and for a plugin it cannot run (spec 1.1 §2.2).
 */
export function EmbedCard({ book, o, caption, onActivate, label }: { book: Book; o: EmbedObject; caption?: string | undefined; onActivate?: Activate | undefined; label?: string | undefined }) {
  const poster = useAssetUrl(book, o.poster);
  const pr = usePresenter(), p = pr.present(o);
  const disc = Math.min(96, o.width * 0.22, o.height * 0.3);
  return (
    <Box x={o.x} y={o.y} width={o.width} height={o.height} className="chalk-card" label={p.label ?? label} id={o.id} kind={kindOf(o)} style={pr.accent(o)} {...(onActivate ? { onActivate } : {})}>
      {poster && <img src={poster} alt="" draggable={false} />}
      <span className="chalk-card-glyph" style={{ width: disc, height: disc }}>{pr.glyph(o, Math.min(44, o.width * 0.1, o.height * 0.14))}</span>
      {(p.label ?? caption) && <span className="chalk-card-caption">{p.label ?? caption}</span>}
    </Box>
  );
}

/** A 56 × 56 marker at the object's x, y (icon display mode, and snips: spec 1.0 §3.4). */
export function IconMarker({ o, label, onActivate }: { o: LessonObject; label: string; onActivate?: Activate | undefined }) {
  const pr = usePresenter(), kind = kindOf(o);
  const s = o.type === 'snip' ? SNIP_ICON_SIZE : MEDIA_ICON_SIZE;
  return (
    <Box x={o.x} y={o.y} width={s} height={s} className={`chalk-marker is-${o.type === 'snip' ? 'snip' : 'media'}`} label={label} title={label || undefined}
      kind={kind} style={pr.accent(o)} {...(onActivate ? { onActivate } : {})}>
      {pr.glyph(o, 26)}
    </Box>
  );
}
