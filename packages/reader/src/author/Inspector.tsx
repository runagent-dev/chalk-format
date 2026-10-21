import { ArrowLineDownIcon, ArrowLineUpIcon, TrashIcon } from '@phosphor-icons/react';
import type { Lesson, LessonObject, Presentation } from '@chalk-format/model';
import { edit } from '../annotate/state.js';
import { kindOf } from '../present.js';
import { Colors, Field, Num, PresentationFields, Section, Seg, TEXT_SIZES, WIDTHS, numbers } from './controls.js';
import type { AuthorStrings } from './i18n.js';

/** #rrggbbaa (a highlighter stroke): keep its see-through-ness when the colour changes. */
const alphaOf = (c: string) => (/^#[0-9a-f]{8}$/i.test(c) ? c.slice(7) : '');
const opaque = (c: string) => (/^#[0-9a-f]{8}$/i.test(c) ? c.slice(0, 7) : c);

/** An object's kind, in the sidebar's words. */
export const kindName = (o: LessonObject, t: AuthorStrings) => { const k = kindOf(o); return k ? t[k] : ((t as unknown as Record<string, string>)[o.type] ?? t.other); };

/** Move an object to the top or the bottom of its page (drawn last or first). */
const arrange = (pageId: string, id: string, to: 'front' | 'back') => (l: Lesson): Lesson => ({
  ...l,
  pages: l.pages.map((p) => {
    if (p.id !== pageId) return p;
    const o = p.objects.find((x) => x.id === id); if (!o) return p;
    const rest = p.objects.filter((x) => x.id !== id);
    return { ...p, objects: to === 'front' ? [...rest, o] : [o, ...rest] };
  }),
});

/**
 * The selected object in the sidebar: where it is and how big, its order on the page, and everything its kind
 * has (spec 1.3 presentation for media; words, size and colour for text; line, fill and thickness for shapes).
 * Each control changes the book at once; typing in a field is one undo step.
 */
export function Inspector({ o, pageId, apply, onDelete, t }: {
  o: LessonObject; pageId: string;
  apply: (fn: (l: Lesson) => Lesson, gesture?: string) => void;
  onDelete: () => void; t: AuthorStrings;
}) {
  const media = o.type === 'image' || o.type === 'embed';
  const setObj = (patch: Record<string, unknown>, gesture?: string) => apply(edit.replace(pageId, { ...o, ...patch } as LessonObject), gesture);
  /** Set one presentation field. A choice is kept even when it equals the default (false, 'card', 'inline'), so a
   *  host's default cannot override it; only "Default" (undefined) and an empty label clear the field. */
  const setP = (k: keyof Presentation, v: unknown, gesture?: string) => {
    if (!media) return;
    const next: Record<string, unknown> = { ...(o.presentation ?? {}), [k]: v };
    if (v === undefined || v === '') delete next[k];
    const rest: Record<string, unknown> = { ...o };
    delete rest.presentation;
    apply(edit.replace(pageId, (Object.keys(next).length ? { ...rest, presentation: next } : rest) as LessonObject), gesture);
  };
  const sized = 'width' in o && 'height' in o && !(media && o.displayMode === 'icon');
  const g = (k: string) => `geom-${o.id}-${k}`;

  return (
    <div className="chalk-insp">
      <Section title={t.position}>
        <div className="chalk-nums">
          <Num label="X" value={o.x} onChange={(v) => setObj(o.type === 'line' || o.type === 'arrow' ? { x: v, x2: o.x2 + v - o.x } : { x: v }, g('x'))} />
          <Num label="Y" value={o.y} onChange={(v) => setObj(o.type === 'line' || o.type === 'arrow' ? { y: v, y2: o.y2 + v - o.y } : { y: v }, g('y'))} />
          {sized && (
            <>
              {/* media keeps its proportions */}
              <Num label="W" value={o.width} min={8} onChange={(v) => setObj(media ? { width: v, height: Math.round((o.height * v) / o.width) } : { width: v }, g('w'))} />
              <Num label="H" value={o.height} min={8} onChange={(v) => setObj(media ? { height: v, width: Math.round((o.width * v) / o.height) } : { height: v }, g('h'))} />
            </>
          )}
        </div>
        <div className="chalk-side-row">
          <button type="button" className="chalk-side-btn" onClick={() => apply(arrange(pageId, o.id, 'front'))}><ArrowLineUpIcon size={16} /> {t.front}</button>
          <button type="button" className="chalk-side-btn" onClick={() => apply(arrange(pageId, o.id, 'back'))}><ArrowLineDownIcon size={16} /> {t.back}</button>
        </div>
      </Section>

      {media && (
        <PresentationFields o={o} setP={setP} t={t}
          setDisplay={(v) => setObj({ displayMode: v === 'full' ? undefined : 'icon' })}
          setLabTitle={o.type === 'embed' && o.lab ? (v) => setObj({ lab: { ...o.lab!, title: v } }, `title-${o.id}`) : undefined} />
      )}

      {o.type === 'text' && (
        <Section title={t.style}>
          <Field label={t.text}>
            {(id) => <textarea id={id} rows={3} value={o.text} onChange={(e) => setObj({ text: e.target.value }, `text-${o.id}`)} />}
          </Field>
          <Seg label={t.textSize} value={String(o.fontSize)} options={numbers(TEXT_SIZES, o.fontSize)} onChange={(v) => setObj({ fontSize: Number(v) })} />
          <Colors label={t.accent} value={o.fill} onChange={(c, gg) => setObj({ fill: c }, gg)} />
        </Section>
      )}
      {(o.type === 'rect' || o.type === 'ellipse') && (
        <Section title={t.style}>
          <Colors label={t.stroke} value={o.stroke} onChange={(c, gg) => setObj({ stroke: c }, gg)} />
          <Colors label={t.fill} value={o.fill} none={t.noFill} onChange={(c, gg) => setObj({ fill: c }, gg)} />
          <Seg label={t.thickness} value={String(o.strokeWidth)} options={numbers(WIDTHS, o.strokeWidth)} onChange={(v) => setObj({ strokeWidth: Number(v) })} />
        </Section>
      )}
      {(o.type === 'line' || o.type === 'arrow') && (
        <Section title={t.style}>
          <Colors label={t.stroke} value={o.stroke} onChange={(c, gg) => setObj({ stroke: c }, gg)} />
          <Seg label={t.thickness} value={String(o.strokeWidth)} options={numbers(WIDTHS, o.strokeWidth)} onChange={(v) => setObj({ strokeWidth: Number(v) })} />
        </Section>
      )}
      {o.type === 'ink' && (
        <Section title={t.style}>
          <Colors label={t.accent} value={opaque(o.color)} onChange={(c, gg) => setObj({ color: c + alphaOf(o.color) }, gg)} />
        </Section>
      )}

      <Section>
        <button type="button" className="chalk-insp-delete" onClick={onDelete}><TrashIcon size={16} /> {t.remove}</button>
      </Section>
    </div>
  );
}
