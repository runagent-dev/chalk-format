import { useId, type ReactNode } from 'react';
import { ICON_NAMES, isLabObject, type IconName, type LessonObject, type Presentation } from '@chalk-format/model';
import { usePresenter } from '../present.js';
import type { AuthorStrings } from './i18n.js';

/** The sidebar's building blocks (author mode), shared by every view of it. */

/** A few accents to pick from; any colour through the picker. */
export const SWATCHES = ['#1f4d8f', '#2f6f4e', '#b42318', '#c2621a', '#7c3aed', '#0e7c66', '#334155'];
/** Ink, text and shape colours. */
export const INKS = ['#1f2a44', '#c0392b', '#1565c0', '#2e7d32', '#ef6c00', '#7c3aed', '#ffffff'];
export const TEXT_SIZES = [16, 20, 24, 30, 36, 48, 64];
export const WIDTHS = [1, 2, 3, 4, 6, 10];
/** Options for a number choice, the current value included even when it is not one of the usual ones. */
export const numbers = (list: number[], cur: number): [string, string][] => [...new Set([...list, cur])].sort((a, b) => a - b).map((n) => [String(n), String(n)]);

export function Section({ title, children }: { title?: string; children: ReactNode }) {
  return <section className="chalk-side-section">{title && <h3>{title}</h3>}{children}</section>;
}

export function Seg<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  const name = useId();
  return (
    <fieldset className="chalk-insp-field">
      <legend>{label}</legend>
      <div className="chalk-insp-seg">
        {options.map(([v, l]) => (
          <label key={v} className={v === value ? 'is-on' : ''}>
            <input type="radio" name={name} checked={v === value} onChange={() => onChange(v)} />{l}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="chalk-insp-field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {hint && <small>{hint}</small>}
    </div>
  );
}

/** Colour swatches and a picker; `none` adds a "no colour" choice (transparent). */
export function Colors({ label, value, onChange, none, swatches = INKS }: { label: string; value: string; onChange: (c: string, gesture?: string) => void; none?: string; swatches?: string[] }) {
  const g = useId();
  const v = value.toLowerCase();
  return (
    <fieldset className="chalk-insp-field">
      <legend>{label}</legend>
      <div className="chalk-insp-swatches">
        {none && <button type="button" className="chalk-insp-swatch is-none" aria-pressed={v === 'transparent' || v === 'none'} title={none} aria-label={none} onClick={() => onChange('transparent')} />}
        {swatches.map((c) => <button key={c} type="button" className="chalk-insp-swatch" style={{ background: c }} aria-pressed={v === c.toLowerCase()} aria-label={c} title={c} onClick={() => onChange(c)} />)}
        <input type="color" aria-label={label} value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#1f2a44'} onChange={(e) => onChange(e.target.value, `color-${g}`)} />
      </div>
    </fieldset>
  );
}

export function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return <label className="chalk-insp-toggle"><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /><span>{label}</span></label>;
}

/** A number in page units (X, Y, W, H). Typing is one undo step per field. */
export function Num({ label, value, onChange, min }: { label: string; value: number; onChange: (v: number) => void; min?: number }) {
  const id = useId();
  return (
    <label className="chalk-num" htmlFor={id}>
      <span>{label}</span>
      <input id={id} type="number" inputMode="numeric" value={Math.round(value)} min={min}
        onChange={(e) => { const n = Number(e.target.value); if (e.target.value !== '' && Number.isFinite(n)) onChange(min !== undefined ? Math.max(min, n) : n); }} />
    </label>
  );
}

/**
 * How a piece of media is presented (spec 1.3): for a selected object, or for the media about to be added.
 * `o` may be a stand-in object (its type, kind and current choices) when nothing is on the page yet.
 */
export function PresentationFields({ o, setP, setDisplay, setLabTitle, t }: {
  o: LessonObject;
  setP: (k: keyof Presentation, v: unknown, gesture?: string) => void;
  setDisplay: (v: 'full' | 'icon') => void;
  setLabTitle?: ((v: string) => void) | undefined;
  t: AuthorStrings;
}) {
  const pr = usePresenter();
  if (o.type !== 'image' && o.type !== 'embed') return null;
  const own: Presentation = o.presentation ?? {};
  const p = pr.present(o);
  const icon = o.displayMode === 'icon';
  return (
    <>
      <Section title={t.presentation}>
        <Seg label={t.display} value={o.displayMode ?? 'full'} options={[['full', t.full], ['icon', t.icon]]} onChange={setDisplay} />
        {o.type === 'embed' && !icon && (o.embed === 'model3d' || o.embed === 'video' || isLabObject(o)) && (
          <Seg label={t.show} value={own.show ?? 'card'} options={[['card', t.card], ['live', t.live]]} onChange={(v) => setP('show', v === 'card' ? undefined : v)} />
        )}
        {o.type === 'embed' && o.embed !== 'audio' && (
          <Seg label={t.open} value={p.open} options={icon ? [['popup', t.popup], ['fullscreen', t.fullscreen]] : [['inline', t.inline], ['popup', t.popup], ['fullscreen', t.fullscreen]]}
            onChange={(v) => setP('open', v === (icon ? 'popup' : 'inline') ? undefined : v)} />
        )}
        {o.type === 'image' && (
          <Seg label={t.open} value={p.open} options={icon ? [['popup', t.popup], ['fullscreen', t.fullscreen]] : [['none', t.none], ['popup', t.popup], ['fullscreen', t.fullscreen]]}
            onChange={(v) => setP('open', v === (icon ? 'popup' : 'none') ? undefined : v)} />
        )}
        {o.type === 'embed' && (o.embed === 'video' || o.embed === 'audio' || o.embed === 'model3d') && (
          <fieldset className="chalk-insp-field">
            <legend>{t.playback}</legend>
            {o.embed !== 'model3d' && <Toggle label={t.autoplay} checked={!!own.autoplay} onChange={(v) => setP('autoplay', v)} />}
            {o.embed !== 'model3d' && <Toggle label={t.loop} checked={!!own.loop} onChange={(v) => setP('loop', v)} />}
            {o.embed === 'video' && <Toggle label={t.muted} checked={!!own.muted} onChange={(v) => setP('muted', v)} />}
            {o.embed === 'model3d' && <Toggle label={t.autoRotate} checked={!!own.autoRotate} onChange={(v) => setP('autoRotate', v)} />}
          </fieldset>
        )}
      </Section>
      <Section title={t.look}>
        {isLabObject(o) && setLabTitle && (
          <Field label={t.labTitle}>
            {(id) => <input id={id} type="text" value={o.lab.title} maxLength={200} onChange={(e) => setLabTitle(e.target.value)} />}
          </Field>
        )}
        <Field label={t.label} hint={t.labelHint}>
          {(id) => <input id={id} type="text" value={own.label ?? ''} maxLength={200} onChange={(e) => setP('label', e.target.value || undefined, `label-${o.id}`)} />}
        </Field>
        <fieldset className="chalk-insp-field">
          <legend>{t.iconPick}</legend>
          <div className="chalk-insp-icons" role="radiogroup" aria-label={t.iconPick}>
            <button type="button" role="radio" aria-checked={!own.icon} className="chalk-insp-icon is-default" title={t.iconDefault} onClick={() => setP('icon', undefined)}>{t.iconDefault}</button>
            {ICON_NAMES.map((n: IconName) => (
              <button key={n} type="button" role="radio" aria-checked={own.icon === n} aria-label={n} title={n} className="chalk-insp-icon" onClick={() => setP('icon', n)}>
                {pr.icon(n, 20)}
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset className="chalk-insp-field">
          <legend>{t.accent}</legend>
          <div className="chalk-insp-swatches">
            <button type="button" className="chalk-insp-swatch is-none" aria-pressed={!own.accent} title={t.accentNone} aria-label={t.accentNone} onClick={() => setP('accent', undefined)} />
            {SWATCHES.map((c) => <button key={c} type="button" className="chalk-insp-swatch" style={{ background: c }} aria-pressed={own.accent?.toLowerCase() === c} aria-label={c} title={c} onClick={() => setP('accent', c)} />)}
            <input type="color" aria-label={t.accent} value={own.accent ?? '#1f4d8f'} onChange={(e) => setP('accent', e.target.value, `accent-${o.id}`)} />
          </div>
        </fieldset>
      </Section>
    </>
  );
}
