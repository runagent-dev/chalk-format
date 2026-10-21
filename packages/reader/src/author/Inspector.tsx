import { useId, type ReactNode } from 'react';
import { TrashIcon } from '@phosphor-icons/react';
import { ICON_NAMES, isLabObject, type IconName, type Lesson, type LessonObject, type Presentation } from '@chalk-format/model';
import { edit } from '../annotate/state.js';
import { kindOf, usePresenter } from '../present.js';
import type { AuthorStrings } from './i18n.js';

/** A few accents to pick from; any colour through the picker. */
const SWATCHES = ['#1f4d8f', '#2f6f4e', '#b42318', '#c2621a', '#7c3aed', '#0e7c66', '#334155'];

/**
 * The selected object's properties (spec 1.3 presentation): how it sits on the page, what a tap opens, its label,
 * icon and colour, playback. Each control changes the book at once; typing in a field is one undo step.
 */
export function Inspector({ o, pageId, apply, onDelete, t }: {
  o: LessonObject | null; pageId: string | null;
  apply: (fn: (l: Lesson) => Lesson, gesture?: string) => void;
  onDelete: () => void; t: AuthorStrings;
}) {
  const pr = usePresenter();
  if (!o || !pageId) return <p className="chalk-insp-empty">{t.nothing}</p>;
  const kind = kindOf(o);
  const media = o.type === 'image' || o.type === 'embed';
  const own: Presentation = media ? (o.presentation ?? {}) : {};
  const p = pr.present(o);
  const icon = media && o.displayMode === 'icon';

  /** Set one presentation field (undefined clears it); the field goes away when nothing is left in it. */
  const setP = (k: keyof Presentation, v: unknown, gesture?: string) => {
    if (!media) return;
    const next: Record<string, unknown> = { ...own, [k]: v };
    if (v === undefined || v === '' || v === false) delete next[k];
    const rest: Record<string, unknown> = { ...o };
    delete rest.presentation;
    apply(edit.replace(pageId, (Object.keys(next).length ? { ...rest, presentation: next } : rest) as LessonObject), gesture);
  };
  const setObj = (patch: Record<string, unknown>, gesture?: string) => apply(edit.replace(pageId, { ...o, ...patch } as LessonObject), gesture);

  return (
    <div className="chalk-insp">
      <div className="chalk-insp-kind">
        <span className="chalk-insp-glyph">{pr.glyph(o, 20)}</span>
        <strong>{kind ? t[kind] : t.other}</strong>
      </div>

      {media && (
        <Seg label={t.display} value={o.displayMode ?? 'full'} options={[['full', t.full], ['icon', t.icon]]}
          onChange={(v) => setObj({ displayMode: v === 'full' ? undefined : 'icon' })} />
      )}
      {o.type === 'embed' && !icon && (o.embed === 'model3d' || o.embed === 'video' || isLabObject(o)) && (
        <Seg label={t.show} value={own.show ?? 'card'} options={[['card', t.card], ['live', t.live]]} onChange={(v) => setP('show', v === 'card' ? undefined : v)} />
      )}
      {media && o.type === 'embed' && o.embed !== 'audio' && (
        <Seg label={t.open} value={p.open} options={icon ? [['popup', t.popup], ['fullscreen', t.fullscreen]] : [['inline', t.inline], ['popup', t.popup], ['fullscreen', t.fullscreen]]}
          onChange={(v) => setP('open', v === (icon ? 'popup' : 'inline') ? undefined : v)} />
      )}
      {o.type === 'image' && (
        <Seg label={t.open} value={p.open} options={icon ? [['popup', t.popup], ['fullscreen', t.fullscreen]] : [['none', t.none], ['popup', t.popup], ['fullscreen', t.fullscreen]]}
          onChange={(v) => setP('open', v === (icon ? 'popup' : 'none') ? undefined : v)} />
      )}

      {isLabObject(o) && (
        <Field label={t.labTitle}>
          {(id) => <input id={id} type="text" value={o.lab.title} maxLength={200}
            onChange={(e) => setObj({ lab: { ...o.lab, title: e.target.value } }, `title-${o.id}`)} />}
        </Field>
      )}
      {media && (
        <Field label={t.label} hint={t.labelHint}>
          {(id) => <input id={id} type="text" value={own.label ?? ''} maxLength={200} onChange={(e) => setP('label', e.target.value || undefined, `label-${o.id}`)} />}
        </Field>
      )}

      {media && (
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
      )}

      {media && (
        <fieldset className="chalk-insp-field">
          <legend>{t.accent}</legend>
          <div className="chalk-insp-swatches">
            <button type="button" className="chalk-insp-swatch is-none" aria-pressed={!own.accent} title={t.accentNone} aria-label={t.accentNone} onClick={() => setP('accent', undefined)} />
            {SWATCHES.map((c) => <button key={c} type="button" className="chalk-insp-swatch" style={{ background: c }} aria-pressed={own.accent?.toLowerCase() === c} aria-label={c} title={c} onClick={() => setP('accent', c)} />)}
            <input type="color" aria-label={t.accent} value={own.accent ?? '#1f4d8f'} onChange={(e) => setP('accent', e.target.value, `accent-${o.id}`)} />
          </div>
        </fieldset>
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

      <button type="button" className="chalk-insp-delete" onClick={onDelete}><TrashIcon size={16} /> {t.remove}</button>
    </div>
  );
}

function Seg<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
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

function Field({ label, hint, children }: { label: string; hint?: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="chalk-insp-field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {hint && <small>{hint}</small>}
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return <label className="chalk-insp-toggle"><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /><span>{label}</span></label>;
}
