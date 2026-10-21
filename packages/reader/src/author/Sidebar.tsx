import { useState, type ReactNode } from 'react';
import { CubeIcon, FileArrowUpIcon, FilmStripIcon, FlaskIcon, ImageIcon, MusicNotesIcon, NotebookIcon, XIcon } from '@phosphor-icons/react';
import { getPageSize, type Lesson, type LessonObject, type LessonPage, type Presentation } from '@chalk-format/model';
import type { Locale } from '../config.js';
import { strings } from '../i18n.js';
import { usePresenter } from '../present.js';
import { TOOL_ICON } from '../annotate/ToolsMenu.js';
import type { AuthorTool } from './AuthorRail.js';
import { Colors, Field, PresentationFields, Section, Seg, TEXT_SIZES, WIDTHS, numbers } from './controls.js';
import { Inspector, kindName } from './Inspector.js';
import type { MediaKind } from './insert.js';
import type { AuthorStrings } from './i18n.js';

/** What the drawing tools draw next (author mode): set in the sidebar while the tool is out. */
export type ToolSettings = {
  pen: { color: string; size: number };
  highlighter: { color: string; size: number };
  text: { color: string; fontSize: number };
  shape: { stroke: string; fill: string; width: number };
};
export const DEFAULT_TOOLS: ToolSettings = {
  pen: { color: '#1f2a44', size: 4 },
  highlighter: { color: '#ffe066', size: 6 },
  text: { color: '#1f2a44', fontSize: 30 },
  shape: { stroke: '#1f2a44', fill: 'transparent', width: 3 },
};
const PEN_SIZES = [2, 3, 4, 6, 8, 12];
const HIGHLIGHTS = ['#ffe066', '#a5f3a1', '#9fd3ff', '#ffb3c7', '#ffc48a'];

/** How media of a kind is presented when added (author mode), until the author changes it on the object. */
export type InsertDefaults = Partial<Record<MediaKind, { displayMode?: 'icon'; presentation?: Presentation }>>;

const MEDIA_ICON: Record<MediaKind, ReactNode> = {
  image: <ImageIcon size={20} />, video: <FilmStripIcon size={20} />, audio: <MusicNotesIcon size={20} />, model3d: <CubeIcon size={20} />, lab: <FlaskIcon size={20} />,
};

/** A stand-in object of a kind, carrying the defaults, so the presentation controls can show them. */
function standIn(kind: MediaKind, d: InsertDefaults[MediaKind]): LessonObject {
  const base = { id: `new-${kind}`, x: 0, y: 0, width: 400, height: 300, ...(d?.displayMode ? { displayMode: d.displayMode } : {}), ...(d?.presentation ? { presentation: d.presentation } : {}) };
  if (kind === 'image') return { ...base, type: 'image', assetId: '' };
  if (kind === 'lab') return { ...base, type: 'embed', embed: 'plugin', plugin: 'chalk.lab', lab: { id: 'new', version: '1.0.0', title: '', entry: `c1:${'a'.repeat(25)}a` } } as LessonObject;
  return { ...base, type: 'embed', embed: kind };
}

/**
 * The author's right sidebar, as in a design tool: it shows what the moment needs. The selected object's
 * properties; else the media being added; else the drawing tool's settings; else the page and the book.
 */
export function AuthorSidebar(p: {
  lesson: Lesson; page: LessonPage | undefined; selected: LessonObject | null; tool: AuthorTool; adding: MediaKind | null;
  tools: ToolSettings; onTools: (s: ToolSettings) => void;
  defaults: InsertDefaults; onDefaults: (d: InsertDefaults) => void;
  apply: (fn: (l: Lesson) => Lesson, gesture?: string) => void;
  onSelect: (id: string) => void; onDelete: () => void;
  onChooseFile: (kind: MediaKind) => void; onDropFiles: (files: File[]) => void;
  /** A close button (phones, where the sidebar is a sheet over the page). */
  onClose?: (() => void) | undefined; closeLabel: string;
  locale: Locale; t: AuthorStrings;
}) {
  const { t, page } = p;
  const r = strings(p.locale);
  const pr = usePresenter();
  const [dropping, setDropping] = useState(false);

  let icon: ReactNode, title: string, hint: string | null = null, body: ReactNode;
  if (p.selected && page) {
    icon = glyphOf(p.selected, pr); title = kindName(p.selected, t);
    body = <Inspector o={p.selected} pageId={page.id} apply={p.apply} onDelete={p.onDelete} t={t} />;
  } else if (p.adding) {
    const kind = p.adding, d = p.defaults[kind] ?? {};
    const setD = (next: InsertDefaults[MediaKind]) => p.onDefaults({ ...p.defaults, [kind]: next });
    icon = MEDIA_ICON[kind]; title = `${t.add}: ${t[kind]}`; hint = t.addNote;
    body = (
      <div className="chalk-insp">
        <Section>
          <div className={`chalk-drop ${dropping ? 'is-over' : ''}`}
            onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDropping(true); } }}
            onDragLeave={() => setDropping(false)}
            onDrop={(e) => { e.preventDefault(); setDropping(false); const fs = [...e.dataTransfer.files]; if (fs.length) p.onDropFiles(fs); }}>
            <FileArrowUpIcon size={28} />
            <button type="button" className="chalk-side-btn is-primary" onClick={() => p.onChooseFile(kind)}>{t.chooseFile}</button>
            <small>{t.dropHere}</small>
          </div>
        </Section>
        <PresentationFields o={standIn(kind, d)} t={t}
          setDisplay={(v) => { const n = { ...d }; if (v === 'icon') n.displayMode = 'icon'; else delete n.displayMode; setD(n); }}
          setP={(k, v) => {
            const next: Record<string, unknown> = { ...(d.presentation ?? {}), [k]: v };
            if (v === undefined || v === '' || v === false) delete next[k];
            setD({ ...d, presentation: next as Presentation });
          }} />
      </div>
    );
  } else if (p.tool !== 'select') {
    const s = p.tools, set = (patch: Partial<ToolSettings>) => p.onTools({ ...s, ...patch });
    icon = TOOL_ICON[p.tool](20); title = r[p.tool]; hint = p.tool === 'eraser' ? t.eraserHint : t.toolHint;
    body = (
      <div className="chalk-insp">
        {p.tool === 'pen' && (
          <Section title={t.style}>
            <Colors label={t.accent} value={s.pen.color} onChange={(c) => set({ pen: { ...s.pen, color: c } })} />
            <Seg label={t.thickness} value={String(s.pen.size)} options={numbers(PEN_SIZES, s.pen.size)} onChange={(v) => set({ pen: { ...s.pen, size: Number(v) } })} />
          </Section>
        )}
        {p.tool === 'highlighter' && (
          <Section title={t.style}>
            <Colors label={t.accent} value={s.highlighter.color} swatches={HIGHLIGHTS} onChange={(c) => set({ highlighter: { ...s.highlighter, color: c } })} />
            <Seg label={t.thickness} value={String(s.highlighter.size)} options={numbers(PEN_SIZES, s.highlighter.size)} onChange={(v) => set({ highlighter: { ...s.highlighter, size: Number(v) } })} />
          </Section>
        )}
        {p.tool === 'text' && (
          <Section title={t.style}>
            <Seg label={t.textSize} value={String(s.text.fontSize)} options={numbers(TEXT_SIZES, s.text.fontSize)} onChange={(v) => set({ text: { ...s.text, fontSize: Number(v) } })} />
            <Colors label={t.accent} value={s.text.color} onChange={(c) => set({ text: { ...s.text, color: c } })} />
          </Section>
        )}
        {(p.tool === 'rect' || p.tool === 'ellipse' || p.tool === 'line' || p.tool === 'arrow') && (
          <Section title={t.style}>
            <Colors label={t.stroke} value={s.shape.stroke} onChange={(c) => set({ shape: { ...s.shape, stroke: c } })} />
            {(p.tool === 'rect' || p.tool === 'ellipse') && <Colors label={t.fill} value={s.shape.fill} none={t.noFill} onChange={(c) => set({ shape: { ...s.shape, fill: c } })} />}
            <Seg label={t.thickness} value={String(s.shape.width)} options={numbers(WIDTHS, s.shape.width)} onChange={(v) => set({ shape: { ...s.shape, width: Number(v) } })} />
          </Section>
        )}
      </div>
    );
  } else {
    icon = <NotebookIcon size={20} />; title = page?.title || t.page;
    const bg = page?.background;
    body = (
      <div className="chalk-insp">
        <Section title={t.book}>
          <Field label={t.title}>
            {(id) => <input id={id} type="text" value={p.lesson.title} maxLength={300} onChange={(e) => p.apply((l) => ({ ...l, title: e.target.value }), 'book-title')} />}
          </Field>
        </Section>
        {page && (
          <Section title={t.page}>
            <Field label={t.pageTitle}>
              {(id) => <input id={id} type="text" value={page.title} maxLength={300}
                onChange={(e) => p.apply((l) => ({ ...l, pages: l.pages.map((x) => (x.id === page.id ? { ...x, title: e.target.value } : x)) }), `page-title-${page.id}`)} />}
            </Field>
            {bg && (bg.type === 'blank' || bg.type === 'color')
              ? <Colors label={t.background} value={bg.type === 'color' ? bg.color : '#ffffff'} swatches={['#ffffff', '#fdf8ee', '#f3f6fa', '#eef7ee', '#1f2a44']}
                  onChange={(c, g) => p.apply((l) => ({ ...l, pages: l.pages.map((x) => (x.id === page.id ? { ...x, background: { type: 'color', color: c } } : x)) }), g)} />
              : <p className="chalk-side-note">{t.background}: {t.bgPicture}</p>}
            <p className="chalk-side-note">{(() => { const z = getPageSize(page); return `${Math.round(z.width)} × ${Math.round(z.height)}`; })()}</p>
          </Section>
        )}
        {page && (
          <Section title={t.layers}>
            {page.objects.length === 0 ? <p className="chalk-side-note">{t.noLayers}</p> : (
              <ul className="chalk-objlist">
                {[...page.objects].reverse().map((o) => (
                  <li key={o.id}>
                    <button type="button" className="chalk-objrow" onClick={() => p.onSelect(o.id)}>
                      <span className="chalk-objrow-glyph">{glyphOf(o, pr)}</span>
                      <span className="chalk-objrow-name">{kindName(o, t)}</span>
                      <span className="chalk-objrow-detail">{detailOf(o)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        )}
      </div>
    );
  }

  return (
    // Escape in a field leaves the field (as in design tools); a second Escape lets go of the selection
    <aside className="chalk-sidebar" aria-label={title}
      onKeyDown={(e) => { const el = e.target as HTMLElement; if (e.key === 'Escape' && el.matches('input, textarea')) { e.stopPropagation(); el.blur(); } }}>
      <header className="chalk-sidebar-head">
        <span className="chalk-insp-glyph">{icon}</span>
        <h2>{title}</h2>
        {p.onClose && <button type="button" className="chalk-icon-btn" aria-label={p.closeLabel} onClick={p.onClose}><XIcon size={18} weight="bold" /></button>}
      </header>
      {hint && <p className="chalk-sidebar-hint">{hint}</p>}
      <div className="chalk-sidebar-body">{body}</div>
    </aside>
  );
}

/** A small picture of an object for lists and headings. */
function glyphOf(o: LessonObject, pr: ReturnType<typeof usePresenter>): ReactNode {
  if (o.type === 'image' || o.type === 'embed' || o.type === 'snip') return pr.glyph(o, 18);
  if (o.type === 'text') return TOOL_ICON.text(18);
  if (o.type === 'rect' || o.type === 'ellipse' || o.type === 'line' || o.type === 'arrow') return TOOL_ICON[o.type](18);
  return TOOL_ICON.pen(18);
}
/** A few words that tell objects of one kind apart. */
function detailOf(o: LessonObject): string {
  if (o.type === 'text') return o.text.slice(0, 40);
  if (o.type === 'image' || o.type === 'embed') return o.presentation?.label ?? (o.type === 'embed' && o.lab ? o.lab.title : '');
  return '';
}
