import { createContext, useContext, type CSSProperties, type ReactNode } from 'react';
import {
  AtomIcon, BookOpenIcon, CalculatorIcon, CubeIcon, DnaIcon, DropIcon, EyeIcon, FilmStripIcon, FlaskIcon, GearIcon, GlobeIcon,
  ImageIcon, InfoIcon, LeafIcon, LightbulbIcon, LightningIcon, MagnetIcon, MusicNotesIcon, PackageIcon, PlanetIcon, PlayIcon,
  QuestionIcon, RulerIcon, ScissorsIcon, SpeakerHighIcon, StarIcon, ThermometerIcon, type Icon,
} from '@phosphor-icons/react';
import { resolvePresentation, type EmbedObject, type IconName, type LessonObject, type Presentation, type ResolvedPresentation } from '@chalk-format/model';
import type { Locale } from './config.js';

/**
 * Presentation as a host app sees it (spec 1.3 §5): the author's choices, merged with the host's defaults, icons
 * and colours. One presenter per reader, handed down through context, so every card, marker and player asks the
 * same question the same way.
 */

/** What kind of thing an object is, for the host's per-kind settings. */
export type KindId = 'image' | 'video' | 'audio' | 'model3d' | 'lab' | 'plugin' | 'snip';

export function kindOf(o: LessonObject): KindId | null {
  if (o.type === 'image') return 'image';
  if (o.type === 'snip') return 'snip';
  if (o.type !== 'embed') return null;
  if (o.plugin === 'chalk.lab') return 'lab';
  return o.embed === 'plugin' ? 'plugin' : o.embed;
}

/** An icon of the host's own: an element, or a function given the size to draw it at. */
export type IconArt = ReactNode | ((size: number) => ReactNode);

/** What a host's renderer for a kind is given (`config.renderers`). */
export type MediaRendererProps = {
  object: EmbedObject;
  /** The media's URL (the asset from the book or a store, or the object's `url`); null while it loads. */
  src: string | null;
  poster: string | null;
  presentation: ResolvedPresentation;
  /** In the page (sized to the object's box) or in a dialog (sized by the dialog). */
  where: 'page' | 'popup';
  locale: Locale;
  theme: 'light' | 'dark';
};
export type MediaRenderers = Partial<Record<'video' | 'audio' | 'model3d', (p: MediaRendererProps) => ReactNode>>;

export type PresentationConfig = {
  /** Artwork per icon name (spec 1.3 §2) or per kind; replaces the built-in icon wherever it would be drawn. */
  icons: Partial<Record<IconName | KindId, IconArt>>;
  /** Presentation for objects whose author did not set it, per kind. What the author set always wins
   *  (except accents, see `authorAccents`). Accents are `#rrggbb`. */
  defaults: Partial<Record<KindId, Presentation>>;
  /** Use the colours authors gave their objects. Off: your `defaults` accents (or the theme's) everywhere. */
  authorAccents: boolean;
  /** Let media start by itself: `show: live` and autoplay. Off (e.g. to save data): always a card, nothing plays
   *  until tapped. */
  live: boolean;
};

export const DEFAULT_PRESENTATION: PresentationConfig = { icons: {}, defaults: {}, authorAccents: true, live: true };

const BUILT_IN: Record<IconName, Icon> = {
  play: PlayIcon, film: FilmStripIcon, music: MusicNotesIcon, speaker: SpeakerHighIcon, image: ImageIcon, cube: CubeIcon,
  flask: FlaskIcon, atom: AtomIcon, magnet: MagnetIcon, lightning: LightningIcon, thermometer: ThermometerIcon, drop: DropIcon,
  planet: PlanetIcon, globe: GlobeIcon, leaf: LeafIcon, dna: DnaIcon, ruler: RulerIcon, calculator: CalculatorIcon, gear: GearIcon,
  info: InfoIcon, question: QuestionIcon, lightbulb: LightbulbIcon, star: StarIcon, eye: EyeIcon, book: BookOpenIcon,
};
const KIND_ICON: Partial<Record<KindId, IconName>> = { image: 'image', video: 'play', audio: 'music', model3d: 'cube', lab: 'flask' };
const HEX = /^#[0-9a-fA-F]{6}$/;

export type Presenter = {
  /** The object's presentation: the author's choices, the host's defaults, then spec 1.3 defaults. */
  present(o: LessonObject): ResolvedPresentation;
  /** The icon to draw for an object, `size` px. */
  glyph(o: LessonObject, size: number): ReactNode;
  /** Style variables for the object's accent, if it has one. */
  accent(o: LessonObject): CSSProperties | undefined;
  renderers: MediaRenderers;
  /** The reader's current language and theme, for renderers. */
  env: { locale: Locale; theme: 'light' | 'dark' };
};

export function createPresenter(cfg: PresentationConfig, renderers: MediaRenderers = {}, env: Presenter['env'] = { locale: 'bn', theme: 'light' }): Presenter {
  const cache = new WeakMap<LessonObject, ResolvedPresentation>();
  const present = (o: LessonObject): ResolvedPresentation => {
    const hit = cache.get(o); if (hit) return hit;
    const kind = kindOf(o);
    const own = o.type === 'image' || o.type === 'embed' ? o.presentation : undefined;
    const host = kind ? cfg.defaults[kind] : undefined;
    const merged: Presentation = { ...host, ...own };
    // whose colour: the author's (if allowed and valid), else the host's
    const accent = [cfg.authorAccents ? own?.accent : undefined, host?.accent].find((a) => a && HEX.test(a));
    if (accent) merged.accent = accent; else delete merged.accent;
    const r = o.type === 'image' || o.type === 'embed'
      ? resolvePresentation({ type: o.type, displayMode: o.displayMode, presentation: merged })
      : resolvePresentation({ type: o.type, presentation: merged });
    if (!cfg.live) { r.show = 'card'; r.autoplay = false; }
    cache.set(o, r);
    return r;
  };
  const art = (a: IconArt, size: number) => <span className="chalk-glyph" style={{ width: size, height: size, fontSize: size * 0.85 }}>{typeof a === 'function' ? a(size) : a}</span>;
  return {
    present,
    glyph(o, size) {
      const kind = kindOf(o), chosen = present(o).icon;
      // the author's named icon first (the host's artwork for that name, else ours); else the kind's
      if (chosen) { const h = cfg.icons[chosen]; if (h !== undefined) return art(h, size); const C = BUILT_IN[chosen]; return <C size={size} weight={chosen === 'play' ? 'fill' : 'duotone'} />; }
      const h = kind ? cfg.icons[kind] : undefined;
      if (h !== undefined) return art(h, size);
      if (kind === 'snip') return <ScissorsIcon size={size} weight="bold" />;
      const name = kind ? KIND_ICON[kind] : undefined;
      if (name) { const h2 = cfg.icons[name]; if (h2 !== undefined) return art(h2, size); const C = BUILT_IN[name]; return <C size={size} weight={name === 'play' ? 'fill' : 'duotone'} />; }
      return <PackageIcon size={size} weight="duotone" />;
    },
    accent(o) { return accentStyle(present(o).accent); },
    renderers,
    env,
  };
}

/** Style variables for an accent, with ink chosen for contrast (spec 1.3 §1). */
export function accentStyle(accent: string | undefined): CSSProperties | undefined {
  if (!accent || !HEX.test(accent)) return undefined;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(accent.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  // white text needs contrast against the colour; past ~0.18 luminance dark ink reads better
  return { '--chalk-object-accent': accent, '--chalk-object-accent-ink': lum > 0.18 ? 'oklch(20% 0.02 260)' : 'oklch(99% 0 0)' } as CSSProperties;
}

const PresenterContext = createContext<Presenter>(createPresenter(DEFAULT_PRESENTATION));
export const PresenterProvider = PresenterContext.Provider;
export const usePresenter = () => useContext(PresenterContext);
