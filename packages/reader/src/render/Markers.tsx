import type { ReactNode } from 'react';
import { CubeIcon, FlaskIcon, ImageIcon, MusicNotesIcon, PackageIcon, PlayIcon, ScissorsIcon } from '@phosphor-icons/react';
import { MEDIA_ICON_SIZE, SNIP_ICON_SIZE, type EmbedObject } from '@chalk-format/model';
import type { Book } from '../book.js';
import { useAssetUrl } from './assets.js';

export const embedIcon = (o: EmbedObject, size = 28): ReactNode => {
  if (o.plugin === 'chalk.lab') return <FlaskIcon size={size} weight="duotone" />;
  switch (o.embed) {
    case 'video': return <PlayIcon size={size} weight="fill" />;
    case 'audio': return <MusicNotesIcon size={size} weight="duotone" />;
    case 'model3d': return <CubeIcon size={size} weight="duotone" />;
    default: return <PackageIcon size={size} weight="duotone" />;
  }
};

/** Positioned at an object's box, in page units. */
export function Box({ x, y, width, height, className, children, label, onActivate }: {
  x: number; y: number; width: number; height: number; className?: string | undefined; children?: ReactNode; label?: string | undefined; onActivate?: (() => void) | undefined;
}) {
  const style = { left: x, top: y, width, height };
  return onActivate
    ? <button type="button" className={`chalk-box ${className ?? ''}`} style={style} aria-label={label} onClick={onActivate}>{children}</button>
    : <div className={`chalk-box ${className ?? ''}`} style={style} aria-label={label}>{children}</div>;
}

/**
 * A media card: the poster scaled to cover the box (or a neutral tile), the kind's glyph and an optional
 * caption. What a reader draws for an embed before it plays, and for a plugin it cannot run (spec 1.1 §2.2).
 */
export function EmbedCard({ book, o, caption, onActivate, label }: { book: Book; o: EmbedObject; caption?: string | undefined; onActivate?: (() => void) | undefined; label?: string | undefined }) {
  const poster = useAssetUrl(book, o.poster);
  return (
    <Box x={o.x} y={o.y} width={o.width} height={o.height} className="chalk-card" label={label} {...(onActivate ? { onActivate } : {})}>
      {poster && <img src={poster} alt="" draggable={false} />}
      <span className="chalk-card-glyph" style={{ width: Math.min(96, o.width * 0.22, o.height * 0.3), height: Math.min(96, o.width * 0.22, o.height * 0.3) }}>
        {embedIcon(o, Math.min(44, o.width * 0.1, o.height * 0.14))}
      </span>
      {caption && <span className="chalk-card-caption">{caption}</span>}
    </Box>
  );
}

/** A 56 × 56 marker at the object's x, y (icon display mode, and snips: spec 1.0 §3.4). */
export function IconMarker({ x, y, kind, glyph, label, onActivate }: { x: number; y: number; kind: 'media' | 'snip'; glyph: ReactNode; label: string; onActivate?: (() => void) | undefined }) {
  const s = kind === 'snip' ? SNIP_ICON_SIZE : MEDIA_ICON_SIZE;
  return <Box x={x} y={y} width={s} height={s} className={`chalk-marker is-${kind}`} label={label} {...(onActivate ? { onActivate } : {})}>{glyph}</Box>;
}

export const snipGlyph = <ScissorsIcon size={26} weight="bold" />;
export const imageGlyph = <ImageIcon size={26} weight="duotone" />;
