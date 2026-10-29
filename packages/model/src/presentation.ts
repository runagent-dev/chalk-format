import { z } from 'zod';

/**
 * Presentation (spec 1.3): how the author wants an image or embed presented. What it should look like is the
 * reader's; the book only names choices from fixed lists. `show`, `open` and `icon` accept any value, so a
 * later version can add some: values a reader does not know mean the default (spec 1.3 §1).
 */

export const ICON_NAMES = [
  'play', 'film', 'music', 'speaker', 'image', 'cube',
  'flask', 'atom', 'magnet', 'lightning', 'thermometer', 'drop', 'planet', 'globe', 'leaf', 'dna',
  'ruler', 'calculator', 'gear',
  'info', 'question', 'lightbulb', 'star', 'eye', 'book',
] as const;
export type IconName = (typeof ICON_NAMES)[number];

export const SHOW_VALUES = ['card', 'live'] as const;
// `window` (spec 1.6) is a floating window over the page, not a dimmed dialog; a reader that does not know it uses the default (spec 1.3 §1)
export const OPEN_VALUES = ['inline', 'popup', 'window', 'fullscreen', 'none'] as const;
export type Show = (typeof SHOW_VALUES)[number];
export type Open = (typeof OPEN_VALUES)[number];

export const presentationSchema = z.looseObject({
  show: z.string().optional(),
  open: z.string().optional(),
  label: z.string().min(1).max(200).optional(),
  icon: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/).optional(),
  /** A colour value, never CSS. */
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  autoplay: z.boolean().optional(),
  loop: z.boolean().optional(),
  muted: z.boolean().optional(),
  autoRotate: z.boolean().optional(),
});
export type Presentation = z.infer<typeof presentationSchema>;

/** What an object's presentation means, every default filled in and unknown values replaced. */
export type ResolvedPresentation = {
  show: Show; open: Open; label?: string; icon?: IconName; accent?: string;
  autoplay: boolean; loop: boolean; muted: boolean; autoRotate: boolean;
};

const oneOf = <T extends string>(list: readonly T[], v: string | undefined): T | undefined => (list as readonly string[]).includes(v ?? '') ? (v as T) : undefined;

/** Spec 1.3 §1 defaults, for an image or an embed. */
export function resolvePresentation(o: { type: string; displayMode?: string | undefined; presentation?: Presentation | undefined }): ResolvedPresentation {
  const p = o.presentation ?? {};
  const icon = o.displayMode === 'icon';
  let open = oneOf(OPEN_VALUES, p.open) ?? (o.type === 'image' && !icon ? 'none' : icon ? 'popup' : 'inline');
  if (o.type === 'embed' && open === 'none') open = icon ? 'popup' : 'inline';
  if (icon && open === 'inline') open = 'popup';
  if (o.type === 'image' && open === 'inline') open = 'popup';
  const iconName = oneOf(ICON_NAMES, p.icon);
  return {
    show: o.type === 'embed' && !icon ? (oneOf(SHOW_VALUES, p.show) ?? 'card') : 'card',
    open,
    ...(p.label ? { label: p.label } : {}),
    ...(iconName ? { icon: iconName } : {}),
    ...(p.accent ? { accent: p.accent.toLowerCase() } : {}),
    autoplay: p.autoplay === true, loop: p.loop === true, muted: p.muted === true, autoRotate: p.autoRotate === true,
  };
}
