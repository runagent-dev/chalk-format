import { describe, expect, it } from 'vitest';
import { isValidElement } from 'react';
import type { LessonObject } from '@chalk-format/model';
import { DEFAULT_PRESENTATION, createPresenter } from './present.js';

const model = { id: 'm', type: 'embed', embed: 'model3d', x: 0, y: 0, width: 400, height: 300, url: 'm.glb' } as LessonObject;
const authored = { ...model, id: 'a', presentation: { show: 'card', accent: '#2f6f4e', icon: 'ruler' } } as LessonObject;
const video = { id: 'v', type: 'embed', embed: 'video', x: 0, y: 0, width: 320, height: 180, url: 'v.mp4', presentation: { show: 'live', autoplay: true } } as LessonObject;
const cfg = (o: Partial<typeof DEFAULT_PRESENTATION>) => ({ ...DEFAULT_PRESENTATION, ...o });

describe('the presenter (spec 1.3 §5)', () => {
  it('fills in what the author left out from the host defaults; the author wins', () => {
    const pr = createPresenter(cfg({ defaults: { model3d: { show: 'live', autoRotate: true, accent: '#7c3aed' } } }));
    expect(pr.present(model)).toMatchObject({ show: 'live', autoRotate: true, accent: '#7c3aed' });
    expect(pr.present(authored)).toMatchObject({ show: 'card', autoRotate: true, accent: '#2f6f4e', icon: 'ruler' });
  });

  it("can ignore authors' colours, falling back to the host's", () => {
    const pr = createPresenter(cfg({ authorAccents: false, defaults: { model3d: { accent: '#7c3aed' } } }));
    expect(pr.present(authored).accent).toBe('#7c3aed');
    expect(createPresenter(cfg({ authorAccents: false })).present(authored).accent).toBeUndefined();
  });

  it('ignores a host accent that is not #rrggbb', () => {
    expect(createPresenter(cfg({ defaults: { model3d: { accent: 'rebeccapurple' } } })).present(model).accent).toBeUndefined();
  });

  it('never starts anything by itself when live media is off', () => {
    expect(createPresenter(cfg({ live: false })).present(video)).toMatchObject({ show: 'card', autoplay: false });
  });

  it("draws the host's artwork: by icon name first, then by kind", () => {
    const pr = createPresenter(cfg({ icons: { ruler: 'R', model3d: (s: number) => `cube ${s}` } }));
    const text = (n: unknown) => (isValidElement(n) ? JSON.stringify((n.props as { children: unknown }).children) : String(n));
    expect(text(pr.glyph(authored, 20))).toBe('"R"');
    expect(text(pr.glyph(model, 20))).toBe('"cube 20"');
  });

  it('gives accents readable ink', () => {
    const pr = createPresenter(DEFAULT_PRESENTATION);
    expect(pr.accent({ ...authored, presentation: { accent: '#ffe066' } } as LessonObject)).toMatchObject({ '--chalk-object-accent-ink': 'oklch(20% 0.02 260)' });
    expect(pr.accent(authored)).toMatchObject({ '--chalk-object-accent-ink': 'oklch(99% 0 0)' });
  });
});
