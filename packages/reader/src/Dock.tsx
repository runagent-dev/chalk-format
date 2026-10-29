import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ignoreWhile } from './author/save-run.js';
import {
  ArrowClockwiseIcon, ArrowCounterClockwiseIcon, ArrowsInIcon, ArrowsOutIcon, BookOpenIcon, CaretLeftIcon, CaretRightIcon,
  DotsThreeIcon, DownloadSimpleIcon, EyeIcon, FloppyDiskIcon, FolderOpenIcon, PencilSimpleIcon, PlusCircleIcon, MagnifyingGlassIcon, MinusIcon, MoonIcon, PlusIcon, RowsIcon, SquaresFourIcon, SunIcon, TranslateIcon, FileIcon,
} from '@phosphor-icons/react';
import type { CustomDockItem, DockItemId, Fit, Layout, Locale, ReaderConfig } from './config.js';
import { num, strings } from './i18n.js';

export type DockActions = Partial<{
  prev: () => void; next: () => void; goTo: (index: number) => void;
  zoomIn: () => void; zoomOut: () => void; fit: () => void; setLayout: (l: Layout) => void;
  thumbnails: () => void; search: () => void;
  undo: () => void; redo: () => void; exportNotes: () => void; importNotes: () => void;
  theme: () => void; language: () => void; fullscreen: () => void;
  mode: () => void; add: () => void; save: () => void;
}>;

export type DockProps = {
  config: ReaderConfig;
  dock: Exclude<ReaderConfig['dock'], false>;
  locale: Locale;
  page: number; pageCount: number; zoom: number; fit: Fit; layout: Layout;
  dark: boolean; fullscreen: boolean;
  /** Panels open now (their buttons show as pressed). */
  open?: { thumbnails?: boolean; search?: boolean; tools?: boolean };
  canUndo?: boolean; canRedo?: boolean;
  actions: DockActions;
  /** The tools button and its popover (annotations), supplied by the reader. */
  tools?: ReactNode;
  /** Authoring, when the host allows it: which mode, unsaved changes, and the words for its buttons. */
  author?: { on: boolean; dirty: boolean; saving?: boolean; t: { edit: string; preview: string; add: string; save: string; saveShort: string; unsaved: string; saving: string } } | undefined;
};

const WIDTH: Record<string, number> = { page: 96, '|': 13, more: 40 };
const HEIGHT: Record<string, number> = { page: 48, '|': 13, more: 40 };
/** How much an item is needed on a small screen: higher stays in the dock longer. Custom items sit mid-way. */
const NEED: Record<string, number> = {
  mode: 99, add: 98, save: 97, tools: 100, page: 95, next: 90, prev: 89, undo: 80, search: 70, thumbnails: 65, redo: 60, zoomIn: 40, zoomOut: 39, fit: 35, layout: 30,
  export: 20, import: 19, theme: 15, language: 14, fullscreen: 10,
};
const need = (id: string) => NEED[id] ?? 50;

/** The floating dock. Items, order and position come from `config.dock`; what does not fit goes in "more". */
export function Dock(p: DockProps) {
  const t = strings(p.locale), f = p.config.features, a = p.actions;
  const vertical = p.dock.position === 'left' || p.dock.position === 'right';
  const wrap = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(Infinity);
  const [moreOpen, setMoreOpen] = useState(false);
  const [jump, setJump] = useState<string | null>(null);

  useLayoutEffect(() => {
    const e = wrap.current?.parentElement; if (!e) return;
    const ro = new ResizeObserver(() => setRoom((vertical ? e.clientHeight : e.clientWidth) - 24));
    ro.observe(e); return () => ro.disconnect();
  }, [vertical]);
  useEffect(() => { if (!moreOpen) return; const close = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) setMoreOpen(false); }; addEventListener('pointerdown', close); return () => removeEventListener('pointerdown', close); }, [moreOpen]);

  type Item = { id: string; node: ReactNode; label: string; run?: () => void; menuNode?: ReactNode };
  const btn = (id: string, label: string, icon: ReactNode, run: (() => void) | undefined, o: { pressed?: boolean; disabled?: boolean; primary?: string; busy?: boolean } = {}): Item | null =>
    run ? (() => { const go = o.busy ? ignoreWhile(() => true, run) : run; return { id, label, run: go, node: <DockButton key={id} label={label} icon={icon} onClick={go} pressed={o.pressed} disabled={o.disabled} primary={o.primary} busy={o.busy} /> }; })() : null;

  const build = (it: DockItemId | CustomDockItem): Item | null => {
    if (typeof it === 'object') return { id: it.id, label: it.label, run: it.onClick, node: <DockButton key={it.id} label={it.label} icon={it.icon} onClick={it.onClick} pressed={it.active} /> };
    switch (it) {
      case '|': return { id: '|', label: '', node: null };   // keyed by position below
      case 'prev': return btn('prev', t.prev, <CaretLeftIcon size={20} weight="bold" />, a.prev, { disabled: p.page <= 0 });
      case 'next': return btn('next', t.next, <CaretRightIcon size={20} weight="bold" />, a.next, { disabled: p.page >= p.pageCount - 1 });
      case 'page': return a.goTo ? {
        id: 'page', label: t.goTo,
        node: jump === null
          ? <button key="page" type="button" className="chalk-dock-page" onClick={() => setJump(String(p.page + 1))} aria-label={`${t.goTo}: ${t.page} ${p.page + 1} ${t.of} ${p.pageCount}`}>
              {num(p.locale, p.page + 1)}<span className="chalk-dock-page-total"> {t.of} {num(p.locale, p.pageCount)}</span>
            </button>
          : <form key="page" className="chalk-dock-page is-editing" onSubmit={(e) => { e.preventDefault(); const n = parseInt(jump, 10); if (n >= 1) a.goTo!(n - 1); setJump(null); }}>
              <input autoFocus inputMode="numeric" aria-label={t.goTo} value={jump} onChange={(e) => setJump(e.target.value.replace(/[^0-9০-৯]/g, '').replace(/[০-৯]/g, (d) => String('০১২৩৪৫৬৭৮৯'.indexOf(d))))} onBlur={() => setJump(null)} onKeyDown={(e) => { if (e.key === 'Escape') setJump(null); }} />
            </form>,
      } : null;
      case 'zoomOut': return btn('zoomOut', t.zoomOut, <MinusIcon size={20} weight="bold" />, a.zoomOut, { disabled: p.zoom <= p.config.zoom.min });
      case 'zoomIn': return btn('zoomIn', t.zoomIn, <PlusIcon size={20} weight="bold" />, a.zoomIn, { disabled: p.zoom >= p.config.zoom.max });
      case 'fit': return btn('fit', p.fit === 'page' ? t.fitWidth : t.fitPage, p.fit === 'page' ? <ArrowsOutIcon size={20} /> : <ArrowsInIcon size={20} />, a.fit);
      case 'layout': return a.setLayout ? btn('layout', `${t.layout}: ${t[p.layout]}`, p.layout === 'spread' ? <BookOpenIcon size={20} /> : p.layout === 'single' ? <FileIcon size={20} /> : <RowsIcon size={20} />,
        () => a.setLayout!(p.layout === 'continuous' ? 'single' : p.layout === 'single' ? 'spread' : 'continuous')) : null;
      case 'thumbnails': return f.thumbnails ? btn('thumbnails', t.thumbnails, <SquaresFourIcon size={20} />, a.thumbnails, { pressed: !!p.open?.thumbnails }) : null;
      case 'search': return f.search ? btn('search', t.search, <MagnifyingGlassIcon size={20} />, a.search, { pressed: !!p.open?.search }) : null;
      case 'tools': return f.annotations && p.tools ? { id: 'tools', label: t.tools, node: <span key="tools">{p.tools}</span> } : null;
      case 'mode': return p.author ? btn('mode', p.author.on ? p.author.t.preview : p.author.t.edit, p.author.on ? <EyeIcon size={20} /> : <PencilSimpleIcon size={20} />, a.mode, { pressed: p.author.on }) : null;
      case 'add': return p.author?.on ? btn('add', p.author.t.add, <PlusCircleIcon size={20} />, a.add) : null;
      case 'save': return p.author?.on ? btn('save', p.author.saving ? p.author.t.saving : p.author.dirty ? `${p.author.t.save} · ${p.author.t.unsaved}` : p.author.t.save,
        <span className={`chalk-dock-save ${p.author.saving ? 'is-busy' : p.author.dirty ? 'is-dirty' : ''}`}><FloppyDiskIcon size={20} /></span>, a.save,
        { ...(p.author.dirty || p.author.saving ? { primary: p.author.saving ? p.author.t.saving : p.author.t.saveShort } : {}), ...(p.author.saving ? { busy: true } : {}) }) : null;   // unsaved: the button is a labelled, filled one, so it cannot be missed
      case 'undo': return f.annotations || p.author?.on ? btn('undo', t.undo, <ArrowCounterClockwiseIcon size={20} />, a.undo, { disabled: !p.canUndo }) : null;
      case 'redo': return f.annotations || p.author?.on ? btn('redo', t.redo, <ArrowClockwiseIcon size={20} />, a.redo, { disabled: !p.canRedo }) : null;
      case 'export': return f.export && f.annotations ? btn('export', t.export, <DownloadSimpleIcon size={20} />, a.exportNotes) : null;
      case 'import': return f.export && f.annotations ? btn('import', t.import, <FolderOpenIcon size={20} />, a.importNotes) : null;
      case 'theme': return f.themeToggle ? btn('theme', t.theme, p.dark ? <SunIcon size={20} /> : <MoonIcon size={20} />, a.theme, { pressed: p.dark }) : null;
      case 'language': return f.languageToggle ? btn('language', t.language, <TranslateIcon size={20} />, a.language) : null;
      case 'fullscreen': return f.fullscreen && typeof document !== 'undefined' && document.fullscreenEnabled ? btn('fullscreen', t.fullscreen, p.fullscreen ? <ArrowsInIcon size={20} /> : <ArrowsOutIcon size={20} />, a.fullscreen, { pressed: p.fullscreen }) : null;
    }
  };

  // dividers only between groups that survived (no leading, trailing or double dividers)
  const items: Item[] = [];
  for (const it of p.dock.items) {
    const b = build(it); if (!b) continue;
    if (b.id === '|' && (!items.length || items[items.length - 1]!.id === '|')) continue;
    if (b.id === '|') b.node = <span key={`divider-${items.length}`} className="chalk-dock-divider" aria-hidden />;
    items.push(b);
  }
  while (items.length && items[items.length - 1]!.id === '|') items.pop();

  // overflow: what does not fit goes in "more", least needed first (a phone keeps tools and page turning),
  // and what stays keeps its order
  const itemWidth = (id: string) => (vertical ? HEIGHT[id] : WIDTH[id]) ?? 40;
  const total = items.reduce((s, i) => s + itemWidth(i.id), 12);
  let shown = items, hidden: Item[] = [];
  if (total > room) {
    const keep = new Set(items), byNeed = items.filter((i) => i.id !== '|').sort((x, y) => need(x.id) - need(y.id));
    const width = () => [...keep].reduce((s, i) => s + itemWidth(i.id), 12 + WIDTH.more!);
    for (const i of byNeed) { if (width() <= room) break; keep.delete(i); }
    shown = items.filter((i) => keep.has(i));
    // no leading, trailing or doubled dividers once items are gone
    shown = shown.filter((i, k) => i.id !== '|' || (k > 0 && k < shown.length - 1 && shown[k - 1]!.id !== '|'));
    hidden = items.filter((i) => !keep.has(i) && i.id !== '|');
  }

  return (
    <div ref={wrap} className={`chalk-dock is-${p.dock.position}`} role="toolbar" aria-label={t.tools} aria-orientation={vertical ? 'vertical' : 'horizontal'}>
      {shown.map((i) => i.node)}
      {hidden.length > 0 && (
        <span className="chalk-dock-more">
          <DockButton label="…" icon={<DotsThreeIcon size={22} weight="bold" />} onClick={() => setMoreOpen((o) => !o)} pressed={moreOpen} />
          {moreOpen && (
            <div className="chalk-menu" role="menu">
              {hidden.map((i) => i.run
                ? <button key={i.id} type="button" role="menuitem" className="chalk-menu-item" onClick={() => { setMoreOpen(false); i.run!(); }}>{i.label}</button>
                : <div key={i.id} className="chalk-menu-node">{i.node}</div>)}
            </div>
          )}
        </span>
      )}
    </div>
  );
}

export function DockButton({ label, icon, onClick, pressed, disabled, primary, busy }: { label: string; icon: ReactNode; onClick: () => void; pressed?: boolean | undefined; disabled?: boolean | undefined; primary?: string | undefined; busy?: boolean | undefined }) {
  return (
    <button type="button" className={`${primary ? 'chalk-dock-btn is-primary' : 'chalk-dock-btn'}${busy ? ' is-busy' : ''}`} aria-label={label} data-tip={label} onClick={onClick} disabled={disabled}
      {...(busy ? { 'aria-busy': true, 'aria-disabled': true } : {})}
      {...(pressed !== undefined ? { 'aria-pressed': pressed } : {})}>
      {icon}
      {primary ? <span className="chalk-dock-btn-text" aria-hidden>{primary}</span> : null}
    </button>
  );
}
