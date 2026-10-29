import { describe, expect, it } from 'vitest';
import { lessonObjectSchema } from './schema.js';
import { resolvePresentation } from './presentation.js';

const model = { id: 'm', type: 'embed', embed: 'model3d', x: 0, y: 0, width: 400, height: 300, assetId: 'c1:' + 'a'.repeat(25) + 'a' } as const;
const image = { id: 'i', type: 'image', x: 0, y: 0, width: 100, height: 100, assetId: 'img' } as const;

describe('presentation (spec 1.3)', () => {
  it('defaults to what 1.2 readers did', () => {
    expect(resolvePresentation(model)).toEqual({ show: 'card', open: 'inline', autoplay: false, loop: false, muted: false, autoRotate: false });
    expect(resolvePresentation({ ...model, displayMode: 'icon' }).open).toBe('popup');
    expect(resolvePresentation(image).open).toBe('none');
  });

  it('keeps what the author chose', () => {
    const r = resolvePresentation({ ...model, presentation: { show: 'live', open: 'fullscreen', label: 'স্ক্রু গজ', icon: 'ruler', accent: '#2F6F4E', autoRotate: true } });
    expect(r).toMatchObject({ show: 'live', open: 'fullscreen', label: 'স্ক্রু গজ', icon: 'ruler', accent: '#2f6f4e', autoRotate: true });
  });

  it('turns values from a later version into defaults, and never fails on them', () => {
    const o = { ...model, presentation: { show: 'hologram', open: 'sideways', icon: 'telescope', glow: true } };
    expect(lessonObjectSchema.safeParse(o).success).toBe(true);
    expect(resolvePresentation(o)).toMatchObject({ show: 'card', open: 'inline' });
    expect(resolvePresentation(o).icon).toBeUndefined();
  });

  it('fits the choice to the object: icons cannot be inline or live, embeds always open', () => {
    expect(resolvePresentation({ ...model, displayMode: 'icon', presentation: { open: 'inline', show: 'live' } })).toMatchObject({ open: 'popup', show: 'card' });
    expect(resolvePresentation({ ...model, presentation: { open: 'none' } }).open).toBe('inline');
    expect(resolvePresentation({ ...image, presentation: { open: 'inline' } }).open).toBe('popup');
  });

  it('knows the floating window (spec 1.6), for images and embeds, on the page or as an icon', () => {
    expect(resolvePresentation({ ...model, presentation: { open: 'window' } }).open).toBe('window');
    expect(resolvePresentation({ ...model, displayMode: 'icon', presentation: { open: 'window' } }).open).toBe('window');
    expect(resolvePresentation({ ...image, presentation: { open: 'window' } }).open).toBe('window');
    expect(resolvePresentation({ ...image, displayMode: 'icon', presentation: { open: 'window' } }).open).toBe('window');
    expect(lessonObjectSchema.safeParse({ ...model, presentation: { open: 'window' } }).success).toBe(true);
  });

  it('a reader that does not know a value (what a pre-1.6 reader does with `window`) uses the default for the object', () => {
    // a 1.3 reader's list of `open` values, as it was before `window`
    const old = ['inline', 'popup', 'fullscreen', 'none'];
    const asOldReader = (o: Parameters<typeof resolvePresentation>[0]) => {
      const p = o.presentation ?? {};
      return resolvePresentation({ ...o, presentation: { ...p, ...(p.open && !old.includes(p.open) ? { open: undefined } : {}) } as typeof p }).open;
    };
    expect(asOldReader({ ...model, presentation: { open: 'window' } })).toBe('inline');
    expect(asOldReader({ ...model, displayMode: 'icon', presentation: { open: 'window' } })).toBe('popup');
    expect(asOldReader({ ...image, presentation: { open: 'window' } })).toBe('none');
    expect(asOldReader({ ...image, displayMode: 'icon', presentation: { open: 'window' } })).toBe('popup');
  });

  it('refuses CSS in place of a colour, and an empty label', () => {
    expect(lessonObjectSchema.safeParse({ ...model, presentation: { accent: 'url(https://x)' } }).success).toBe(false);
    expect(lessonObjectSchema.safeParse({ ...image, presentation: { accent: 'red' } }).success).toBe(false);
    expect(lessonObjectSchema.safeParse({ ...image, presentation: { label: '' } }).success).toBe(false);
    expect(lessonObjectSchema.safeParse({ ...image, presentation: { label: 'x'.repeat(201) } }).success).toBe(false);
  });

  it('keeps presentation on images when parsed (images are not loose, so the field must be known)', () => {
    const r = lessonObjectSchema.parse({ ...image, presentation: { open: 'popup', label: 'চিত্র' } });
    expect(r).toMatchObject({ presentation: { open: 'popup', label: 'চিত্র' } });
  });
});
