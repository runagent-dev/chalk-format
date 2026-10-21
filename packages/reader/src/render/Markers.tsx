import type { CSSProperties, ReactNode } from 'react';
import {
  AtomIcon, BookOpenIcon, CalculatorIcon, CubeIcon, DnaIcon, DropIcon, EyeIcon, FilmStripIcon, FlaskIcon, GearIcon, GlobeIcon,
  ImageIcon, InfoIcon, LeafIcon, LightbulbIcon, LightningIcon, MagnetIcon, MusicNotesIcon, PackageIcon, PlanetIcon, PlayIcon,
  QuestionIcon, RulerIcon, ScissorsIcon, SpeakerHighIcon, StarIcon, ThermometerIcon, type Icon,
} from '@phosphor-icons/react';
import { MEDIA_ICON_SIZE, SNIP_ICON_SIZE, resolvePresentation, type EmbedObject, type IconName, type LessonObject } from '@chalk-format/model';
import type { Book } from '../book.js';
import { useAssetUrl } from './assets.js';

/** The artwork for each icon name of spec 1.3 §2. */
const ICONS: Record<IconName, Icon> = {
  play: PlayIcon, film: FilmStripIcon, music: MusicNotesIcon, speaker: SpeakerHighIcon, image: ImageIcon, cube: CubeIcon,
  flask: FlaskIcon, atom: AtomIcon, magnet: MagnetIcon, lightning: LightningIcon, thermometer: ThermometerIcon, drop: DropIcon,
  planet: PlanetIcon, globe: GlobeIcon, leaf: LeafIcon, dna: DnaIcon, ruler: RulerIcon, calculator: CalculatorIcon, gear: GearIcon,
  info: InfoIcon, question: QuestionIcon, lightbulb: LightbulbIcon, star: StarIcon, eye: EyeIcon, book: BookOpenIcon,
};

/** The kind's own icon (spec 1.3 §2 defaults); null for a plugin, which gets a package. */
export function defaultIconName(o: LessonObject): IconName | null {
  if (o.type === 'image') return 'image';
  if (o.type !== 'embed') return null;
  if (o.plugin === 'chalk.lab') return 'flask';
  return o.embed === 'video' ? 'play' : o.embed === 'audio' ? 'music' : o.embed === 'model3d' ? 'cube' : null;
}

/** The icon an image or embed shows: the author's choice, else the kind's. */
export function objectGlyph(o: LessonObject, size: number): ReactNode {
  const name = resolvePresentation(o as EmbedObject).icon ?? defaultIconName(o);
  const C = name ? ICONS[name] : PackageIcon;
  return <C size={size} weight={name === 'play' ? 'fill' : 'duotone'} />;
}

/** The author's accent as style variables, with ink chosen for contrast (spec 1.3 §1). */
export function accentStyle(accent: string | undefined): CSSProperties | undefined {
  if (!accent) return undefined;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(accent.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  // white text needs contrast against the colour; past ~0.18 luminance dark ink reads better
  return { '--chalk-object-accent': accent, '--chalk-object-accent-ink': lum > 0.18 ? 'oklch(20% 0.02 260)' : 'oklch(99% 0 0)' } as CSSProperties;
}

/** Called with the activated element, so the reader can see how big it is on screen. */
export type Activate = (el: HTMLElement) => void;

/** Positioned at an object's box, in page units. */
export function Box({ x, y, width, height, className, children, label, title, onActivate, style, id }: {
  x: number; y: number; width: number; height: number; className?: string | undefined; children?: ReactNode; label?: string | undefined;
  title?: string | undefined; onActivate?: Activate | undefined; style?: CSSProperties | undefined; id?: string | undefined;
}) {
  const s = { left: x, top: y, width, height, ...style };
  return onActivate
    ? <button type="button" className={`chalk-box ${className ?? ''}`} style={s} aria-label={label} title={title} data-chalk-id={id} onClick={(e) => onActivate(e.currentTarget)}>{children}</button>
    : <div className={`chalk-box ${className ?? ''}`} style={s} aria-label={label} title={title} data-chalk-id={id}>{children}</div>;
}

/**
 * A media card: the poster scaled to cover the box (or a neutral tile), the object's icon and its caption.
 * What a reader draws for an embed before it plays, and for a plugin it cannot run (spec 1.1 §2.2).
 */
export function EmbedCard({ book, o, caption, onActivate, label }: { book: Book; o: EmbedObject; caption?: string | undefined; onActivate?: Activate | undefined; label?: string | undefined }) {
  const poster = useAssetUrl(book, o.poster);
  const p = resolvePresentation(o);
  const disc = Math.min(96, o.width * 0.22, o.height * 0.3);
  return (
    <Box x={o.x} y={o.y} width={o.width} height={o.height} className="chalk-card" label={p.label ?? label} id={o.id} style={accentStyle(p.accent)} {...(onActivate ? { onActivate } : {})}>
      {poster && <img src={poster} alt="" draggable={false} />}
      <span className="chalk-card-glyph" style={{ width: disc, height: disc }}>{objectGlyph(o, Math.min(44, o.width * 0.1, o.height * 0.14))}</span>
      {(p.label ?? caption) && <span className="chalk-card-caption">{p.label ?? caption}</span>}
    </Box>
  );
}

/** A 56 × 56 marker at the object's x, y (icon display mode, and snips: spec 1.0 §3.4). */
export function IconMarker({ x, y, kind, glyph, label, accent, onActivate }: { x: number; y: number; kind: 'media' | 'snip'; glyph: ReactNode; label: string; accent?: string | undefined; onActivate?: Activate | undefined }) {
  const s = kind === 'snip' ? SNIP_ICON_SIZE : MEDIA_ICON_SIZE;
  return <Box x={x} y={y} width={s} height={s} className={`chalk-marker is-${kind}`} label={label} title={label || undefined} style={accentStyle(accent)} {...(onActivate ? { onActivate } : {})}>{glyph}</Box>;
}

export const snipGlyph = <ScissorsIcon size={26} weight="bold" />;
