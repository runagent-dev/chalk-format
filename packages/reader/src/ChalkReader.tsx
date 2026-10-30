import { forwardRef, useCallback, useDeferredValue, useEffect, useImperativeHandle, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { LAB_MANIFEST_TYPE, getPageSize, isLabObject, labManifestSchema, labObjectFromManifest, generateId, type EmbedObject, type LabObject, type LessonObject, type LessonPage } from '@chalk-format/model';
import { openBook, type AssetResolver, type Book, type BookSource } from './book.js';
import { resolveConfig, type Fit, type Layout, type Locale, type ReaderConfig, type ReaderConfigInput } from './config.js';
import { num, strings } from './i18n.js';
import { Dock } from './Dock.js';
import { Viewer, type ViewerHandle } from './Viewer.js';
import { Box, EmbedCard, IconMarker } from './render/Markers.js';
import { PresenterProvider, createPresenter, usePresenter, type Presenter } from './present.js';
import { PageView, type HtmlObjectRenderer } from './render/PageView.js';
import { AudioEmbed, LabFrame, ModelViewer, VideoEmbed, localLabStorage, type LabStorage } from './render/Embeds.js';
import { Modal } from './render/Modal.js';
import { FloatingWindow } from './render/FloatingWindow.js';
import { aspectFor, type Box as WindowBox } from './render/windowGeometry.js';
import { useAssetUrl } from './render/assets.js';
import { packOverlay, unpackOverlay, type BookPatch, type MergeReport, type PatchResult } from '@chalk-format/container';
import type { Overlay } from '@chalk-format/model';
import { useAnnotations } from './annotate/state.js';
import { Surface, type Pen } from './annotate/Surface.js';
import { ToolsMenu } from './annotate/ToolsMenu.js';
import type { ToolId } from './config.js';
import { Panel } from './panels/Panel.js';
import { useAuthoring } from './author/state.js';
import { AuthorSurface } from './author/AuthorSurface.js';
import { InsertMenu } from './author/InsertMenu.js';
import { AuthorSidebar, DEFAULT_TOOLS, type InsertDefaults, type ToolSettings } from './author/Sidebar.js';
import { ACCEPT, mediaKindOf, naturalSize, objectFromFile, objectFromItem, videoPoster, type MediaKind } from './author/insert.js';
import type { LibraryItem } from '@chalk-format/store';
import { AuthorRail, SHORTCUTS, type AuthorTool } from './author/AuthorRail.js';
import { authorStrings } from './author/i18n.js';
import { runPatchSave, runSave, saveHostLink, singleFlight, throttled, type SaveProgress } from './author/save-run.js';
import { edit } from './annotate/state.js';
import type { Lesson } from '@chalk-format/model';
import { Search } from './panels/Search.js';
import { Thumbnails } from './panels/Thumbnails.js';
import { searchBook } from './search.js';
import { isLibrarySource, isStreamSource, isStreamed, openLibraryStreamedBook, openStreamedBook, windowAround, type LibrarySource, type StreamedBook } from './stream.js';
import { loadBookLinks, type LibraryBookLinks } from '@chalk-format/store';
import { newLookup, resetLookup, withLibraries } from './libraries.js';
import type { Library } from '@chalk-format/store';
import type { StreamText } from '@chalk-format/model';

export type ChalkReaderProps = {
  /**
   * The book: bytes, a File/Blob or a URL; or a book in a library, `{ library, slug, token? }` (spec 1.7, "Books in a library": found by its
   * tags, its pages and media fetched from the library as they are needed). Or pass an already opened `book`.
   */
  source?: BookSource | LibrarySource;
  book?: Book;
  /**
   * A book from a library: its links item (which sentences of which pages have questions, and the keys of those questions), once it has
   * arrived, so the host can offer "questions for this line"; null when the book has none. Not called when it could not be fetched.
   */
  onBookLinks?: (links: LibraryBookLinks | null, book: StreamedBook) => void;
  /** Fetches assets a thin book does not carry. */
  resolveAsset?: AssetResolver;
  /** Libraries to find media in, first first (this device, a folder, a library server): what a book does not carry
   *  comes from the first that has it; what none has is shown as not found. Author mode's gallery lists them. */
  libraries?: Library[];
  /** The libraries were connected, removed or reordered in the reader's own panel. */
  onLibrariesChange?: (libraries: Library[]) => void;
  config?: ReaderConfigInput;
  /** 0-based page index, whenever it changes. */
  onPageChange?: (index: number, page: LessonPage) => void;
  /** A lab reported progress (Host API `progress`). */
  onLabProgress?: (progress: { step?: { done: number; total: number }; score?: number; completed?: boolean }, where: { objectId: string; labId: string; page: number }) => void;
  /** Where labs keep their saved state. Default: this browser (config.persistence 'local'), or nowhere ('none'). */
  labStorage?: LabStorage;
  /** The student's notes (a Chalk overlay). Pass it to control them; else they start from defaultOverlay or this browser. */
  overlay?: Overlay;
  defaultOverlay?: Overlay;
  /** After every change to the notes. */
  onOverlayChange?: (overlay: Overlay) => void;
  /** Authoring (config.authoring): after every change to the book. */
  onLessonChange?: (lesson: Lesson) => void;
  /** Authoring: whether the book has changes that are not saved yet, when that changes (for the host's own "unsaved" notice or Save button). */
  onDirtyChange?: (dirty: boolean) => void;
  /** Authoring: the saved book. Without it, Save downloads the .chalk file. */
  onSave?: (bytes: Uint8Array, lesson: Lesson) => void | Promise<void>;
  /**
   * Authoring, streamed books: the patch save. When given, Save sends only the pages that changed since the last save and the media added since
   * (a patch, usually a few kilobytes) instead of the whole book: the host merges it with what it has and answers with the new version and the
   * pages it wrote (`PatchResult`, see `mergeBook` and `applyStreamPatch` in @chalk-format/container). No picture of the book is fetched for it.
   * It is used instead of `onSave` for a streamed book; a book opened from a .chalk file still saves as a whole through `onSave`. Throw to say
   * the patch was not kept (the book stays unsaved).
   */
  onSavePatch?: (patch: BookPatch, media: Map<string, { type: string; bytes: Uint8Array }>) => Promise<PatchResult>;
  /** Authoring: after a patch save whose merge with someone else's work had to decide something (the host's report, only when it is not empty). */
  onMergeReport?: (report: MergeReport) => void;
  /**
   * Authoring: where a save is, from the click on (before the pictures are fetched): `collecting` (with how many of the book's assets are in
   * hand), `packing`, `handing-over` (the host's `onSave` runs). Called at most about ten times a second.
   */
  onSaveProgress?: (progress: SaveProgress) => void;
  /** Authoring: true when a save starts and false when it ends (saved or failed), for the host's own Save button. */
  onSavingChange?: (saving: boolean) => void;
  /** Authoring: the mode, controlled by the host (e.g. its own switch). The dock's switch reports through onModeChange. */
  mode?: 'read' | 'author';
  /** Authoring: when the reader switches between reading and authoring. */
  onModeChange?: (mode: 'read' | 'author') => void;
  className?: string;
  style?: CSSProperties;
};

export type ReaderHandle = {
  goTo(page: number): void;
  next(): void;
  prev(): void;
  zoomTo(zoom: number): void;
  /** Authoring: saves the book as the Save button does (through `onSave`, else a download). Resolves true once saved, false when it was not (the reader is not authoring, or the save failed). Called while a save is already running, it joins that save: no second one starts, and it resolves with the first one's result. */
  save(): Promise<boolean>;
  readonly book: Book | null;
};

/** The reference reader for `.chalk` books (docs/reader-plan.md). */
export const ChalkReader = forwardRef<ReaderHandle, ChalkReaderProps>(function ChalkReader(props, ref) {
  const config = useMemo(() => resolveConfig(props.config), [props.config]);
  const [opened, setOpened] = useState<{ book: Book | null; error: string | null }>({ book: props.book ?? null, error: null });

  // a library source is an object a host may write inline: it is the same book while its fields are the same
  const source = props.source;
  const sourceKey = isLibrarySource(source) ? JSON.stringify([source.library, source.slug, source.token ?? null]) : source;
  useEffect(() => {
    if (props.book) { setOpened({ book: props.book, error: null }); return; }
    if (!source) return;
    let live = true, mine: Book | null = null;
    setOpened({ book: null, error: null });
    const o = props.resolveAsset ? { resolveAsset: props.resolveAsset } : {};
    // a book in a library; a streamed book (spec 1.4), named by its index or its directory; anything else is a .chalk
    (isLibrarySource(source) ? openLibraryStreamedBook(source, o) : isStreamSource(source) ? openStreamedBook(source, o) : openBook(source, o)).then(
      (b) => { if (live) { mine = b; setOpened({ book: b, error: null }); } else b.dispose(); },
      (e: unknown) => { if (live) setOpened({ book: null, error: e instanceof Error ? e.message : String(e) }); },
    );
    return () => { live = false; mine?.dispose(); };
  }, [sourceKey, props.book, props.resolveAsset]);   // eslint-disable-line react-hooks/exhaustive-deps

  // a library book's links go to the host once, after the book is open (they are not needed to draw a page)
  const onBookLinks = useRef(props.onBookLinks);
  onBookLinks.current = props.onBookLinks;
  const wantsLinks = Boolean(props.onBookLinks);
  useEffect(() => {
    const b = opened.book;
    if (!wantsLinks || !b || !isStreamed(b) || !b.library) return;
    let live = true;
    loadBookLinks(b.library).then((links) => { if (live) onBookLinks.current?.(links, b); }, () => {});
    return () => { live = false; };
  }, [opened.book, wantsLinks]);

  const t = strings(config.locale);
  if (opened.error) return <Shell config={config} className={props.className} style={props.style}><div className="chalk-state is-error" role="alert"><strong>{t.failed}</strong><span>{opened.error}</span></div></Shell>;
  if (!opened.book) return <Shell config={config} className={props.className} style={props.style}><div className="chalk-state" role="status"><span className="chalk-spinner" aria-hidden />{t.loading}</div></Shell>;
  return <Reader key={opened.book.lesson.id} {...props} book={opened.book} config={config} handleRef={ref} />;
});

const noSubscribe = () => () => {};

/** "3 items not found": what the connected libraries do not have, and where in the book it is used. */
function MissingChip({ lesson, missing, t, locale, onGo }: { lesson: Lesson; missing: ReadonlySet<string>; t: ReturnType<typeof strings>; locale: Locale; onGo: (page: number) => void }) {
  const [open, setOpen] = useState(false);
  const uses = useMemo(() => {
    const out: { key: string; page: number; what: string }[] = [];
    lesson.pages.forEach((p, i) => {
      if (missing.has((p.background as { assetId?: string }).assetId ?? '')) out.push({ key: '', page: i, what: t.page });
      for (const o of p.objects) {
        const ids = o.type === 'image' ? [o.assetId] : o.type === 'embed' ? [o.assetId, o.poster, o.lab?.entry].filter(Boolean) as string[] : [];
        const hit = ids.find((k) => missing.has(k));
        if (!hit) continue;
        const what = o.type === 'image' ? t.image : o.type === 'embed' ? (isLabObject(o) ? o.lab.title : o.presentation?.label ?? (o.embed === 'model3d' ? t.model3d : o.embed === 'video' ? t.video : o.embed === 'audio' ? t.audio : o.embed)) : '';
        out.push({ key: hit, page: i, what });
      }
    });
    return out;
  }, [lesson, missing, missing.size, t]);   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="chalk-missing">
      <button type="button" className="chalk-missing-chip" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {t.missingCount.replace('{n}', num(locale, missing.size))}
      </button>
      {open && (
        <div className="chalk-missing-list" role="dialog" aria-label={t.missingTitle}>
          <strong>{t.missingTitle}</strong>
          <ul>{uses.map((u, i) => <li key={i}><button type="button" onClick={() => { onGo(u.page); setOpen(false); }}>{u.what} · {t.page} {num(locale, u.page + 1)}</button></li>)}</ul>
          <p>{t.missingHint}</p>
        </div>
      )}
    </div>
  );
}
const NO_LIBRARIES: Library[] = [];

function Shell({ config, className, style, children, theme }: { config: ReaderConfig; className?: string | undefined; style?: CSSProperties | undefined; children: React.ReactNode; theme?: 'light' | 'dark' }) {
  const dark = theme ?? (config.theme === 'system' ? (typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : config.theme);
  return <div className={`chalk-reader ${className ?? ''}`} data-theme={dark} lang={config.locale} style={style}>{children}</div>;
}

function useSystemDark() {
  const q = typeof matchMedia !== 'undefined' ? matchMedia('(prefers-color-scheme: dark)') : null;
  const [dark, setDark] = useState(!!q?.matches);
  useEffect(() => { if (!q) return; const f = () => setDark(q.matches); q.addEventListener('change', f); return () => q.removeEventListener('change', f); }, [q]);
  return dark;
}

function Reader(props: Omit<ChalkReaderProps, 'config'> & { book: Book; config: ReaderConfig; handleRef: React.ForwardedRef<ReaderHandle> }) {
  const { book: original, config } = props;
  // a streamed book changes as its pages arrive: draw again each time
  useSyncExternalStore(isStreamed(original) ? original.subscribe : noSubscribe, () => original.lesson);
  const streamed = isStreamed(original) ? original : null;
  // its search file, once a search begins (spec 1.4 §4)
  const [streamText, setStreamText] = useState<StreamText | null>(null);
  // authoring: the reader shows the author's working copy, in both modes. Read mode is the student's reader over
  // it (notes and all); author mode edits the book itself, without the notes.
  const authoringOn = config.authoring.enabled;
  // libraries: one lookup per set of libraries (a new set asks again: switching libraries can find what was missing)
  const libs = props.libraries ?? NO_LIBRARIES;
  const lookup = useRef(newLookup()).current;
  const [seenLibs, setSeenLibs] = useState(libs);
  if (seenLibs !== libs) { setSeenLibs(libs); resetLookup(lookup); }
  const [, missingChanged] = useState(0);
  useEffect(() => { const f = () => missingChanged((n) => n + 1); lookup.listeners.add(f); return () => { lookup.listeners.delete(f); }; }, [lookup]);
  const originalWithLibraries = useMemo(() => withLibraries(original, libs, lookup), [original, libs, lookup]);
  const au = useAuthoring(original, props.onLessonChange, { bytes: originalWithLibraries.assetBytes });
  // controlled by the host when it passes `mode` (the dock's switch then only asks, through onModeChange)
  const [modeState, setModeState] = useState<'read' | 'author'>(authoringOn ? config.authoring.startIn : 'read');
  const mode = props.mode ?? modeState;
  // editing needs every page: a streamed book loads the rest first, then author mode begins
  const author = authoringOn && mode === 'author' && (!streamed || streamed.complete);
  // the notes sit on the book as it was when author mode began, and move onto the edited book once, on the way
  // back to reading (not on every step of a drag)
  const notesBase = useRef(original.lesson);
  if (!author) notesBase.current = authoringOn ? au.lesson : original.lesson;
  const ann = useAnnotations(notesBase.current, { overlay: props.overlay, defaultOverlay: props.defaultOverlay, onOverlayChange: props.onOverlayChange, persistence: config.persistence });
  const [sel, setSel] = useState<{ pageId: string; id: string } | null>(null);
  const [authorTool, setAuthorToolState] = useState<AuthorTool>('select');
  // the media type being added (its options are in the sidebar), what drawing tools draw, how added media starts
  const [adding, setAdding] = useState<MediaKind | null>(null);
  // where the media being added goes when it was chosen from the right-click menu (that page, that point); else the middle of the current page
  // `from` is the current page when the spot was chosen: turning to another page forgets the spot (what is added then goes to the middle
  // of the page in view, not to a page the author has left)
  const [addAt, setAddAt] = useState<{ pageId: string; x: number; y: number; from: number } | null>(null);
  useEffect(() => { if (!adding) setAddAt(null); }, [adding]);
  // the right-click menu: the page point it was opened at, and where to draw it (px from the reader's top left)
  const [insertMenu, setInsertMenu] = useState<{ pageId: string; x: number; y: number; left: number; top: number } | null>(null);
  const closeInsertMenu = useCallback(() => setInsertMenu(null), []);
  const [toolSettings, setToolSettings] = useState<ToolSettings>(DEFAULT_TOOLS);
  const [insertDefaults, setInsertDefaults] = useState<InsertDefaults>({});
  const setAuthorTool = useCallback((x: AuthorTool) => { setAuthorToolState(x); setAdding(null); if (x !== 'select') setSel(null); }, []);
  const authorPen: Pen = useMemo(() => {
    const s = toolSettings, base = { tool: authorTool, color: s.pen.color, highlight: s.highlighter.color, size: s.pen.size, textSize: s.text.fontSize };
    if (authorTool === 'highlighter') return { ...base, size: s.highlighter.size };
    if (authorTool === 'text') return { ...base, color: s.text.color };
    if (authorTool === 'rect' || authorTool === 'ellipse' || authorTool === 'line' || authorTool === 'arrow') return { ...base, color: s.shape.stroke, size: s.shape.width, fill: s.shape.fill };
    return base;
  }, [toolSettings, authorTool]);
  const book = useMemo(() => withLibraries(authoringOn ? au.book : original, libs, lookup), [authoringOn, au.book, original, libs, lookup]);
  const lesson = author ? au.lesson : ann.lesson;
  const pages = lesson.pages;
  const viewer = useRef<ViewerHandle>(null);
  const root = useRef<HTMLDivElement>(null);
  const narrow = () => (root.current?.clientWidth ?? 1000) < 720;
  const systemDark = useSystemDark();

  const startPage = useMemo(() => {
    const ip = config.initialPage;
    const i = typeof ip === 'number' ? ip - 1 : pages.findIndex((p) => p.id === ip);
    return Math.min(Math.max(0, i), Math.max(0, pages.length - 1));
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  const [page, setPage] = useState(startPage);
  const [zoom, setZoom] = useState(1);
  const [layout, setLayout] = useState<Layout>(config.layout);
  const [fit, setFit] = useState<Fit>(config.fit);
  const [theme, setTheme] = useState<'light' | 'dark' | null>(config.theme === 'system' ? null : config.theme);
  const [locale, setLocale] = useState<Locale>(config.locale);
  const [fullscreen, setFullscreen] = useState(false);
  // a side dock on a phone-width reader would cover the page: it goes to the bottom there
  const [rootWidth, setRootWidth] = useState(1000);
  useEffect(() => { const e = root.current; if (!e) return; const ro = new ResizeObserver(() => setRootWidth(e.clientWidth)); ro.observe(e); return () => ro.disconnect(); }, []);
  const dockPos = config.dock ? (rootWidth < 720 && (config.dock.position === 'left' || config.dock.position === 'right') ? 'bottom' : config.dock.position) : null;
  // the dock: the author's in author mode; in read mode the host's, with the mode switch first when authoring is on
  const dockItems = !config.dock ? [] : author ? config.authoring.dock
    : authoringOn && !config.dock.items.includes('mode') ? ['mode' as const, '|' as const, ...config.dock.items] : config.dock.items;
  const dockCfg = config.dock && dockPos ? { ...config.dock, position: dockPos, items: dockItems } : null;
  const [panel, setPanel] = useState<'thumbnails' | 'search' | null>(null);
  const [query, setQuery] = useState('');
  const [hit, setHit] = useState(0);
  const deferredQuery = useDeferredValue(query);
  // one live embed at a time (a running lab or a 3D viewer), and at most one dialog
  // the one live embed (model or lab); `auto` when it started by itself rather than by a tap
  const [active, setActive] = useState<{ id: string; page: number; auto?: boolean } | null>(null);
  const activeRef = useRef(active); activeRef.current = active;
  // the floating window (spec 1.6 `open: window`): one at a time, not a dialog: the page stays usable
  const [floating, setFloating] = useState<{ o: LessonObject; anchor: WindowBox | null; opener: HTMLElement | null } | null>(null);
  const floatingRef = useRef(floating); floatingRef.current = floating;
  const windowOpen = floating !== null;
  const [modal, setModal] = useState<{ kind: 'snip'; pageId: string } | { kind: 'media'; o: LessonObject; full?: boolean } | null>(null);
  const modalRef = useRef(modal); modalRef.current = modal;
  const dialogOpen = modal !== null;
  const storage = props.labStorage ?? (config.persistence === 'local' ? localLabStorage : null);
  const hits = useMemo(() => {
    if (panel !== 'search' && !deferredQuery) return [];
    const st = streamText;
    const searchable = streamed && st ? { ...lesson, pages: lesson.pages.map((p) => (streamed.isLoaded(p.id) ? p : { ...p, textLayer: st.pages[p.id] ?? [] })) } : lesson;
    return searchBook(searchable, deferredQuery);
  }, [lesson, deferredQuery, panel, streamText, streamed]);
  // the pen: tool, colours and size
  const A = config.annotations;
  const [tool, setTool] = useState<ToolId>(A.defaultTool);
  const [color, setColor] = useState(A.colors[0] ?? '#1f2a44');
  const [highlight, setHighlight] = useState(A.highlighterColors[0] ?? '#ffe066');
  const [size, setSize] = useState(A.sizes[Math.min(1, A.sizes.length - 1)] ?? 4);
  const drawing = config.features.annotations && tool !== 'pan' && !author;
  const pen: Pen = useMemo(() => ({ tool, color, highlight, size, textSize: [24, 34, 48][Math.max(0, A.sizes.indexOf(size))] ?? 30 }), [tool, color, highlight, size, A.sizes]);
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(null), 3500); return () => clearTimeout(id); }, [toast]);
  const notesFile = useRef<HTMLInputElement>(null);
  useEffect(() => setHit(0), [deferredQuery]);

  // a host changing its config takes effect (the playground does this)
  useEffect(() => setLayout(config.layout), [config.layout]);
  useEffect(() => setFit(config.fit), [config.fit]);
  useEffect(() => setTheme(config.theme === 'system' ? null : config.theme), [config.theme]);
  useEffect(() => setLocale(config.locale), [config.locale]);

  const dark = theme ?? (systemDark ? 'dark' : 'light');
  const pr = useMemo(() => createPresenter(config.presentation, config.renderers, { locale, theme: dark }), [config.presentation, config.renderers, locale, dark]);
  const t = strings(locale);
  const onPage = props.onPageChange;
  const changePage = useCallback((i: number) => { setPage((prev) => { if (prev !== i) onPage?.(i, pages[i]!); return i; }); }, [onPage, pages]);

  useEffect(() => { const id = requestAnimationFrame(() => viewer.current?.goTo(startPage)); return () => cancelAnimationFrame(id); }, [startPage]);

  const goTo = useCallback((i: number) => { const n = Math.min(Math.max(0, i), pages.length - 1); viewer.current?.goTo(n, true); if (layout === 'single') changePage(n); }, [pages.length, layout, changePage]);
  const step = layout === 'spread' ? 2 : 1;
  const next = useCallback(() => goTo(page + step), [goTo, page, step]);
  const prev = useCallback(() => goTo(page - step), [goTo, page, step]);
  const zoomBy = useCallback((f: number) => viewer.current?.zoomTo(zoom * f), [zoom]);


  useEffect(() => {
    const f = () => setFullscreen(document.fullscreenElement === root.current);
    document.addEventListener('fullscreenchange', f); return () => document.removeEventListener('fullscreenchange', f);
  }, []);
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen(); else void root.current?.requestFullscreen?.();
  }, []);

  const onKey = (e: React.KeyboardEvent) => {
    if (!config.features.keyboard || e.defaultPrevented) return;
    // keys typed into a text field are the field's (Ctrl+Z there undoes the typing); a radio or a checkbox is not one
    const el = e.target as HTMLElement;
    const typing = el.tagName === 'TEXTAREA' || el.isContentEditable || (el.tagName === 'INPUT' && !/^(radio|checkbox|range|color|button|submit|reset|file)$/.test((el as HTMLInputElement).type));
    if (typing) return;
    const k = e.key, mod = e.ctrlKey || e.metaKey;
    if (mod && k.toLowerCase() === 'f' && config.features.search) { e.preventDefault(); setPanel('search'); return; }
    if ((config.features.annotations || author) && mod && (k.toLowerCase() === 'z' || k.toLowerCase() === 'y')) {
      const h = author ? au : ann;
      e.preventDefault(); if (k.toLowerCase() === 'y' || e.shiftKey) h.redo(); else h.undo(); return;
    }
    // arrow keys move the selected object in author mode, not the page
    if (author && sel && k.startsWith('Arrow')) return;
    if (k === 'PageDown' || (k === 'ArrowRight' && !mod) || (k === ' ' && layout === 'single')) { e.preventDefault(); next(); }
    else if (k === 'PageUp' || (k === 'ArrowLeft' && !mod)) { e.preventDefault(); prev(); }
    else if (k === 'Home') { e.preventDefault(); goTo(0); }
    else if (k === 'End') { e.preventDefault(); goTo(pages.length - 1); }
    else if (k === '+' || k === '=') { e.preventDefault(); zoomBy(config.zoom.step); }
    else if (k === '-') { e.preventDefault(); zoomBy(1 / config.zoom.step); }
    else if (k === '0') { e.preventDefault(); viewer.current?.zoomTo(1); }
  };

  const onLabProgress = props.onLabProgress;
  // a tap that opens an object somewhere else than its box (spec 1.3 `open`)
  // `window` opens beside the object that was tapped (`el`), as the one live thing: a running lab or model on the page makes way for it
  const openElsewhere = useCallback((o: LessonObject, open: string, el?: HTMLElement) => {
    if (open === 'window') {
      const r = root.current?.getBoundingClientRect(), b = el?.getBoundingClientRect();
      setActive(null); setModal(null);
      setFloating({ o, anchor: r && b ? { x: b.left - r.left, y: b.top - r.top, w: b.width, h: b.height } : null, opener: el ?? null });
      return;
    }
    setFloating(null);
    setModal({ kind: 'media', o, full: open === 'fullscreen' });
  }, []);
  const closeFloating = useCallback(() => setFloating(null), []);
  const renderHtmlObject: HtmlObjectRenderer = useCallback((o, pg) => {
    const f = config.features, pi = pages.indexOf(pg);
    if (o.type === 'snip') return f.snips ? <IconMarker o={o} label={t.openSnip} onActivate={() => setModal({ kind: 'snip', pageId: o.snipPageId })} /> : null;
    if (o.type === 'image') {
      const p = pr.present(o);
      const open = p.open === 'none' ? undefined : (el: HTMLElement) => openElsewhere(o, p.open, el);
      if (o.displayMode === 'icon') return <IconMarker o={o} label={p.label ?? t.image} onActivate={open} />;
      return <OpenableImage book={book} o={o} label={p.label ?? t.image} onActivate={open} />;
    }
    if (o.type !== 'embed') return null;
    const p = pr.present(o);
    const lab = isLabObject(o) ? o : null;
    const canRun = lab ? f.labs : o.embed === 'model3d' ? f.model3d : o.embed === 'video' || o.embed === 'audio' ? f.media : false;
    const label = p.label ?? lab?.lab.title ?? (o.embed === 'model3d' ? t.model3d : o.embed === 'video' ? t.video : o.embed === 'audio' ? t.audio : t.unsupported);
    if (o.displayMode === 'icon') return <IconMarker o={o} label={label} onActivate={canRun ? (el: HTMLElement) => openElsewhere(o, p.open, el) : undefined} />;
    if (!canRun) return <EmbedCard book={book} o={o} caption={o.embed === 'plugin' && !lab ? t.unsupported : lab?.lab.title} label={label} />;
    const elsewhere = p.open === 'popup' || p.open === 'fullscreen' || p.open === 'window' ? (el: HTMLElement) => openElsewhere(o, p.open, el) : undefined;
    if (o.embed === 'video') return <VideoEmbed book={book} o={o} label={label} onOpen={elsewhere} notFound={t.notFound} />;
    if (o.embed === 'audio') return <AudioEmbed book={book} o={o} locale={locale} />;
    // in its box on the page, unless that box is too small on this screen to use: then a larger view
    // a lab needs room for its controls; a model only needs to be big enough to turn
    // the student asked for this one, so it takes the place of an open window (one live thing at a time, spec 1.3 §1)
    const start = elsewhere ?? ((el: HTMLElement) => { setFloating(null); if (tooSmall(el, Boolean(lab))) setModal({ kind: 'media', o }); else setActive({ id: o.id, page: pi }); });
    return <EmbedCard book={book} o={o} caption={lab ? `${lab.lab.title} · ${t.startLab}` : undefined} label={lab ? `${t.startLab}: ${lab.lab.title}` : label} onActivate={start} notFound={t.notFound} />;
  }, [book, config.features, t, locale, pages, openElsewhere, pr]);

  // previews (thumbnails, snips inside a dialog): the same cards and markers, but inert
  const renderPreview: HtmlObjectRenderer = useCallback((o) => {
    if (o.type === 'snip') return <IconMarker o={o} label={t.openSnip} />;
    if (o.type === 'image') return o.displayMode === 'icon' ? <IconMarker o={o} label="" /> : <OpenableImage book={book} o={o} label="" />;
    if (o.type !== 'embed') return null;
    if (o.displayMode === 'icon') return <IconMarker o={o} label="" />;
    return <EmbedCard book={book} o={o} caption={isLabObject(o) ? o.lab.title : undefined} notFound={t.notFound} />;
  }, [book, t]);

  // the live embed on a page, drawn in screen pixels above it
  const pageActive = useCallback((pg: LessonPage, i: number, scale: number) => {
    if (streamed && !streamed.isLoaded(pg.id)) return <div className="chalk-page-loading" role="status" aria-label={t.loading}><span className="chalk-spinner" /></div>;
    if (!active || active.page !== i) return undefined;
    const o = pg.objects.find((x) => x.id === active.id);
    if (!o || o.type !== 'embed') return undefined;
    const style = { left: o.x * scale, top: o.y * scale, width: o.width * scale, height: o.height * scale };
    if (isLabObject(o)) return <LabFrame book={book} o={o} style={style} locale={locale} theme={dark} storage={storage}
      onProgress={(p) => onLabProgress?.(p, { objectId: o.id, labId: o.lab.id, page: i })} onStop={() => setActive(null)} />;
    return <ModelViewer book={book} o={o} style={style} />;
  }, [active, book, locale, dark, storage, onLabProgress, streamed, t.loading]);

  // a live embed stops once its page is well out of view (it would be off screen, using the phone's power)
  useEffect(() => { if (active && Math.abs(active.page - page) > 1) setActive(null); }, [page, active]);

  // what starts by itself: a model or lab the author made live (spec 1.3), or any lab with labs.autoStart. It starts
  // once at least half of it is on screen and it is big enough there to use; one at a time, and never in place of
  // one the student started with a tap. Nothing is downloaded for objects the student does not scroll to.
  useEffect(() => {
    const f = config.features;
    const wants = (x: LessonObject) => {
      if (x.type !== 'embed' || x.displayMode === 'icon' || x.embed === 'video' || x.embed === 'audio') return false;
      if (isLabObject(x)) return f.labs && (config.labs.autoStart || pr.present(x).show === 'live');
      return x.embed === 'model3d' && f.model3d && pr.present(x).show === 'live';
    };
    const objects = new Map((pages[page]?.objects ?? []).filter(wants).map((o) => [o.id, o]));
    if (!objects.size || author) return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const id = (e.target as HTMLElement).dataset.chalkId, o = id ? objects.get(id) : undefined;
        if (!o || e.intersectionRatio < 0.5 || tooSmall(e.target as HTMLElement, isLabObject(o))) continue;
        const cur = activeRef.current;
        // never in place of what the student opened: a tapped-open window is theirs, and so is a tapped-open lab
        if (cur?.id === o.id || (cur && !cur.auto) || floatingRef.current || modalRef.current) continue;
        setActive({ id: o.id, page, auto: true });
      }
    }, { threshold: [0, 0.5] });
    // the cards are drawn after the page is laid out
    const raf = requestAnimationFrame(() => {
      for (const id of objects.keys()) { const el = root.current?.querySelector(`[data-chalk-id="${CSS.escape(id)}"]`); if (el) io.observe(el); }
    });
    return () => { cancelAnimationFrame(raf); io.disconnect(); };
    // `windowOpen` and `dialogOpen` restart it when a window or dialog closes: what became visible meanwhile starts now (and nothing starts behind one that is open)
  }, [page, pages, config.labs.autoStart, config.features, pr, author, windowOpen, dialogOpen]);

  const noActive = useCallback(() => undefined, []);
  // streamed books: the pages around the current one, nearest first (spec 1.4 §5)
  // once the reader settles on a page: scrolling past pages does not ask for each of them
  useEffect(() => {
    if (!streamed) return;
    const id = setTimeout(() => streamed.want(windowAround(page, pages.length, config.streaming.window)), 150);
    return () => clearTimeout(id);
  }, [streamed, page, pages.length, config.streaming.window]);
  const wantsAuthor = authoringOn && mode === 'author';
  // while the rest of a streamed book loads for editing, say how far it is (not a notice that fades: it stays until the book is whole)
  const [loadProgress, setLoadProgress] = useState<{ done: number; total: number } | null>(null);
  useEffect(() => {
    if (!streamed || !wantsAuthor || streamed.complete) { setLoadProgress(null); return; }
    let last = 0;
    const show = () => setLoadProgress({ done: streamed.loadedPages, total: streamed.totalPages });
    show();
    // pages arrive many times a second: draw the count a few times a second
    const off = streamed.subscribe(() => { const now = Date.now(); if (now - last >= 200) { last = now; show(); } });
    streamed.loadAll().then(
      () => setLoadProgress(null),
      (e: unknown) => { setLoadProgress(null); setToast(e instanceof Error ? e.message : String(e)); },
    );
    return off;
  }, [streamed, wantsAuthor]);   // eslint-disable-line react-hooks/exhaustive-deps
  // search a streamed book with its text file: pages not loaded yet are searched by their text runs
  useEffect(() => { if (streamed && (panel === 'search' || query)) void streamed.searchText().then(setStreamText); }, [streamed, panel, query]);
  const pageLabel = useCallback((i: number) => `${t.page} ${num(locale, i + 1)}`, [t, locale]);

  // search hits on each page; the current one marked
  const byPage = useMemo(() => {
    const m = new Map<number, { x: number; y: number; width: number; height: number; current?: boolean }[]>();
    hits.forEach((h, i) => { const l = m.get(h.page) ?? []; l.push({ x: h.x, y: h.y, width: h.width, height: h.height, current: i === hit }); m.set(h.page, l); });
    return m;
  }, [hits, hit]);
  const highlights = useCallback((i: number) => byPage.get(i), [byPage]);
  const showHit = useCallback((i: number) => {
    const h = hits[i]; if (!h) return;
    setHit(i); viewer.current?.reveal(h.page, h.x + h.width / 2, h.y);
  }, [hits]);
  const stepHit = useCallback((d: 1 | -1) => { if (hits.length) showHit((hit + d + hits.length) % hits.length); }, [hits.length, hit, showHit]);

  const editableOn = useCallback((pageId: string) => (o: LessonObject) => A.editBase || ann.isOwn(pageId, o), [A.editBase, ann.isOwn]);   // eslint-disable-line react-hooks/exhaustive-deps
  const pageOverlay = useCallback((pg: LessonPage, _i: number, scale: number) =>
    drawing ? <Surface page={pg} scale={scale} pen={pen} editable={editableOn(pg.id)} apply={ann.apply} textPrompt={t.textPrompt} /> : undefined,
  [drawing, pen, editableOn, ann.apply, t.textPrompt]);

  // the author's tools speak the authoring language (English by default), whatever the reader's language is
  const authorLocale = config.authoring.locale;
  const at_ = authorStrings(authorLocale);
  const setMode = useCallback((m: 'read' | 'author') => {
    if (props.mode === undefined) setModeState(m);
    props.onModeChange?.(m);
  }, [props.mode, props.onModeChange]);   // eslint-disable-line react-hooks/exhaustive-deps
  // a new mode starts clean: no selection, no live media, no dialog or panel, the select tool
  const firstMode = useRef(true);
  useEffect(() => {
    if (firstMode.current) { firstMode.current = false; return; }
    setSel(null); setActive(null); setModal(null); setFloating(null); setPanel(null); setAuthorToolState('select'); setAdding(null); setInsertMenu(null);
  }, [author]);
  // media files onto a page: where they were dropped, or the middle of the page for the + button
  const addFiles = useCallback(async (files: File[], pg: LessonPage, where?: { x: number; y: number }) => {
    const size = getPageSize(pg);
    let last: string | null = null, refused = 0;
    for (const [n, f] of files.entries()) {
      const p0 = where ?? { x: size.width / 2, y: size.height / 2 };
      const made = await objectFromFile(f, size, { x: p0.x + n * 24, y: p0.y + n * 24 }, au.addAsset).catch(() => null);
      if (!made) { refused++; continue; }
      // how the author said media of this kind should start (sidebar, while adding)
      const k = mediaKindOf(f), d = k ? insertDefaults[k] : undefined;
      const o = d && (made.type === 'image' || made.type === 'embed')
        ? { ...made, ...(d.displayMode ? { displayMode: d.displayMode } : {}), ...(d.presentation && Object.keys(d.presentation).length ? { presentation: d.presentation } : {}) } as LessonObject
        : made;
      au.apply(edit.add(pg.id, o)); last = o.id;
    }
    if (last) { setSel({ pageId: pg.id, id: last }); setAdding(null); }
    if (refused) setToast(at_.notPlaceable);
  }, [au, at_, insertDefaults]);
  const mediaFile = useRef<HTMLInputElement>(null);
  // the page and point media being added goes to: where the author right-clicked, else the middle of the current page (`at` unset)
  // and an open menu goes with it: a choice made after the page turned would otherwise bring the left page's spot back
  useEffect(() => { setAddAt((a) => (a && a.from !== page ? null : a)); setInsertMenu(null); }, [page]);
  const target = useCallback((): { pg: LessonPage | undefined; at?: { x: number; y: number } } => {
    const pg = addAt ? pages.find((x) => x.id === addAt.pageId) : undefined;
    return pg && addAt ? { pg, at: { x: addAt.x, y: addAt.y } } : { pg: pages[page] };
  }, [addAt, pages, page]);
  // a library item onto the current page: placed from the facts the library keeps (a lab from its manifest), with
  // how the author said media of this kind should start
  const placeItem = useCallback(async (item: LibraryItem, lib: Library) => {
    const { pg, at } = target(); if (!pg) return;
    const size = getPageSize(pg), mid = at ?? { x: size.width / 2, y: size.height / 2 };
    let made: LessonObject | null;
    if (item.type === LAB_MANIFEST_TYPE) {
      const raw = await lib.get(item.key);
      try { made = raw ? labObjectFromManifest(labManifestSchema.parse(JSON.parse(new TextDecoder().decode(raw.bytes))), { id: generateId('lab'), x: 0, y: 0, locale: lesson.locale, width: Math.round(size.width * 0.6) }) : null; }
      catch (e) { setToast(e instanceof Error ? e.message : String(e)); return; }
      if (made && 'width' in made) made = { ...made, x: Math.round(mid.x - made.width / 2), y: Math.round(mid.y - made.height / 2) } as LessonObject;
    } else made = objectFromItem(item, size, mid);
    if (!made) { setToast(at_.notPlaceable); return; }
    const k = item.type.startsWith('video/') ? 'video' : item.type.startsWith('audio/') ? 'audio' : item.type.startsWith('image/') ? 'image' : item.type === 'model/gltf-binary' ? 'model3d' : 'lab';
    const d = insertDefaults[k];
    const o = d && (made.type === 'image' || made.type === 'embed')
      ? { ...made, ...(d.displayMode ? { displayMode: d.displayMode } : {}), ...(d.presentation && Object.keys(d.presentation).length ? { presentation: d.presentation } : {}) } as LessonObject
      : made;
    au.apply(edit.add(pg.id, o)); setSel({ pageId: pg.id, id: o.id }); setAdding(null);
  }, [target, lesson.locale, au, at_, insertDefaults]);
  // files into a library (the author chose which), then onto the page: kept once, findable and reusable afterwards
  const uploadTo = useCallback(async (files: File[], lib: Library) => {
    if (!lib.put) return;
    setToast(at_.uploading);
    for (const f of files) {
      const kind = mediaKindOf(f); if (!kind || kind === 'lab') { setToast(at_.notPlaceable); continue; }
      const bytes = new Uint8Array(await f.arrayBuffer());
      const type = kind === 'model3d' ? 'model/gltf-binary' : f.type || 'application/octet-stream';
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
      try {
        const natural = kind === 'image' || kind === 'video' ? await naturalSize(kind, url) : null;
        // a video's poster from its frames, into the same library
        let poster: string | undefined;
        if (kind === 'video') { const p = await videoPoster(url); if (p) poster = (await lib.put({ bytes: new Uint8Array(await p.arrayBuffer()), type: 'image/webp', title: `${f.name} (poster)` })).key; }
        const item = await lib.put({ bytes, type, filename: f.name, title: f.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' '), ...(natural ? { meta: natural } : {}), ...(poster ? { poster } : {}) });
        await placeItem(item, lib);
      } catch (e) { setToast(e instanceof Error ? e.message : String(e)); return; }
      finally { URL.revokeObjectURL(url); }
    }
    setToast(null);
  }, [at_, placeItem]);
  // one save at a time: a second click, Ctrl/⌘+S or handle.save() while one runs joins it. From the click the dock's Save button is busy and the
  // status line says what the save is doing (the pictures are fetched first, which takes seconds on a big book), and the host hears it too.
  const saveFlight = useRef(singleFlight<boolean>());
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const savingRef = useRef(false);
  const hostSaveEvents = useRef({ progress: props.onSaveProgress, change: props.onSavingChange });
  hostSaveEvents.current = { progress: props.onSaveProgress, change: props.onSavingChange };
  // what the host hears of a save; made when the reader mounts and ended when it goes away (a save still running then reports `false` once and goes quiet)
  const saveHost = useRef<ReturnType<typeof saveHostLink> | null>(null);
  saveHost.current ??= saveHostLink(() => hostSaveEvents.current);
  const activeShow = useRef<{ cancel: () => void } | null>(null);
  useEffect(() => {
    const link = saveHost.current!;
    link.attach();
    return () => link.detach(() => activeShow.current?.cancel());
  }, []);
  const saveBook = useCallback((): Promise<boolean> => saveFlight.current.run(async () => {
    let saved: Lesson;
    const noteFor = (p: SaveProgress) => p.phase === 'collecting' && p.total
      ? at_.savingPictures.replace('{done}', num(authorLocale, p.done ?? 0)).replace('{total}', num(authorLocale, p.total))
      : p.phase === 'packing' ? at_.savingPacking : p.phase === 'handing-over' ? (props.onSave || props.onSavePatch ? at_.savingUploading : at_.saving) : at_.saving;
    const ev = saveHost.current!.get();
    const show = throttled((p: SaveProgress) => { setSaveNote(noteFor(p)); ev.progress(p); }, 100);
    activeShow.current = show;
    // the counter is throttled; the first report, a change of phase and the last picture show at once
    const progress = (p: SaveProgress) => { show(p); if (p.phase !== 'collecting' || p.done === undefined || p.done === p.total) show.flush(); };
    savingRef.current = true; setToast(null); setSaving(true); ev.start();   // a message from before gives way to the save's own
    try {
      // the patch save: a streamed book and a host that takes patches. Only the pages that changed travel; no picture of the book is fetched.
      if (props.onSavePatch && au.canPatch) {
        try {
          const { built, result } = await runPatchSave({
            build: (pr) => au.savePatch(pr),
            hand: (b) => props.onSavePatch!(b.patch, b.media),
            progress,
          });
          au.adoptPatch(built, result);
          const notes = result.report?.notes.length ?? 0;
          if (notes) props.onMergeReport?.(result.report);
          // the host could not restore pictures another save had taken out of the book: they are sent again, once, as a patch of nothing but their bytes
          let missing = 0;
          if (result.unresolved?.length) {
            const again = await runPatchSave({ build: (pr) => au.savePatchMedia(result.unresolved!, pr), hand: (b) => props.onSavePatch!(b.patch, b.media), progress });
            au.adoptPatch(again.built, again.result);
            missing = again.result.unresolved?.length ?? 0;
          }
          setToast(missing ? at_.savedMissing.replace('{n}', num(authorLocale, missing)) : notes ? at_.savedMerged.replace('{n}', num(authorLocale, notes)) : at_.saved);
          return true;
        } catch (e) {
          // not saved: the unsaved mark and the leave-page warning stay
          setToast(`${at_.saveFailed}: ${e instanceof Error ? e.message : String(e)}`);
          return false;
        }
      }
      try {
        const built = await runSave({
          build: (pr) => au.save(pr),
          hand: async ({ bytes, lesson: l }) => {
            if (props.onSave) await props.onSave(bytes, l);
            else {
              const a = document.createElement('a');
              a.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/vnd.chalk+zip' }));
              a.download = `${l.title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'book'}.chalk`;
              a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
            }
          },
          progress,
        });
        saved = built.lesson;
      } catch (e) {
        // not saved: the unsaved mark and the leave-page warning stay
        setToast(`${at_.saveFailed}: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      }
      au.markSaved(saved);
      setToast(at_.saved);
      return true;
    } finally {
      show.cancel(); if (activeShow.current === show) activeShow.current = null; savingRef.current = false; setSaving(false); setSaveNote(null); ev.end();
    }
  }), [au, props.onSave, props.onSavePatch, props.onMergeReport, at_, authorLocale]);   // eslint-disable-line react-hooks/exhaustive-deps
  useImperativeHandle(props.handleRef, () => ({ goTo: (n) => goTo(n - 1), next, prev, zoomTo: (z) => viewer.current?.zoomTo(z), save: () => (authoringOn ? saveBook() : Promise.resolve(false)), book }), [goTo, next, prev, book, saveBook, authoringOn]);
  // Ctrl or Cmd+S saves the book while it is being edited, wherever on the page the keyboard focus is (the browser's own "save page" is no use
  // here); a text field outside the reader keeps its keys, and a key another handler already took is left alone
  const saveRef = useRef(saveBook);
  saveRef.current = saveBook;
  useEffect(() => {
    if (!author) return;
    const onSaveKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== 's') return;
      const t = e.target as HTMLElement | null;
      if (t && !root.current?.contains(t) && t.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      e.preventDefault();
      if (savingRef.current) { setToast(at_.alreadySaving); return; }   // one save at a time
      // a text still being typed in the reader is part of the book: leaving the field commits it, then the book is saved
      const field = document.activeElement;
      if (field instanceof HTMLElement && root.current?.contains(field) && field.matches('textarea, input')) {
        field.blur();
        setTimeout(() => void saveRef.current(), 30);
      } else void saveRef.current();
    };
    document.addEventListener('keydown', onSaveKey);
    return () => document.removeEventListener('keydown', onSaveKey);
  }, [author, at_]);   // eslint-disable-line react-hooks/exhaustive-deps
  // the host hears when the book becomes unsaved or saved (its own notice, its own Save button)
  const onDirtyChange = useRef(props.onDirtyChange);
  onDirtyChange.current = props.onDirtyChange;
  const dirty = authoringOn && au.dirty;
  useEffect(() => { onDirtyChange.current?.(dirty); }, [dirty]);
  // unsaved work is not lost to a closed tab without a warning
  useEffect(() => {
    if (!authoringOn || !au.dirty) return;
    const f = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = at_.leave; };
    addEventListener('beforeunload', f); return () => removeEventListener('beforeunload', f);
  }, [authoringOn, au.dirty, at_]);
  // tool shortcuts in author mode (V select, P pen, H highlighter, E eraser, T text, R O L A shapes), wherever the
  // focus is on the page, except while typing in a field
  useEffect(() => {
    if (!author) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === 'TEXTAREA' || el.isContentEditable || el.tagName === 'SELECT' || (el.tagName === 'INPUT' && !/^(radio|checkbox|range|color|button|submit|reset|file)$/.test((el as HTMLInputElement).type)));
      const x = SHORTCUTS[e.key.toLowerCase()];
      if (!x || typing || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      e.preventDefault(); setAuthorTool(x);
    };
    addEventListener('keydown', onKey); return () => removeEventListener('keydown', onKey);
  }, [author, setAuthorTool]);
  // the eraser of author mode takes drawings, text and shapes; media is removed by selecting it
  const erasable = useCallback((o: LessonObject) => o.type !== 'image' && o.type !== 'embed' && o.type !== 'snip', []);
  // a right-click on a page opens the menu of what can be added there (any tool; the browser's own menu stays for fields)
  const insertMenuOn = config.authoring.contextMenu;
  const openInsertMenu = useCallback((e: React.MouseEvent, pg: LessonPage, scale: number) => {
    if (!insertMenuOn) return;   // the host turned it off: the browser's own menu stays
    // a text being typed (a note, a text object) keeps the browser's menu: cut, copy, paste, spelling
    if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) return;
    const surface = (e.target as HTMLElement).closest('.chalk-surface')?.getBoundingClientRect(), box = root.current?.getBoundingClientRect();
    if (!surface || !box) return;
    e.preventDefault();
    setInsertMenu({ pageId: pg.id, x: Math.round((e.clientX - surface.left) / scale), y: Math.round((e.clientY - surface.top) / scale), left: e.clientX - box.left, top: e.clientY - box.top });
  }, [insertMenuOn]);
  useEffect(() => { if (!insertMenuOn) setInsertMenu(null); }, [insertMenuOn]);
  const authorOverlay = useCallback((pg: LessonPage, _i: number, scale: number) => (
    <div style={{ display: 'contents' }} onContextMenu={(e) => openInsertMenu(e, pg, scale)}>
      {authorTool === 'select'
        ? <AuthorSurface page={pg} scale={scale} selected={sel?.pageId === pg.id ? sel.id : null}
            onSelect={(id) => setSel(id ? { pageId: pg.id, id } : null)} apply={au.apply}
            onDropFiles={(files, p) => void addFiles(files, pg, p)} labels={{ resize: at_.resize, drop: at_.drop }} />
        : <Surface page={pg} scale={scale} pen={authorPen} editable={erasable} apply={au.apply} textPrompt={strings(authorLocale).textPrompt} />}
      {addAt?.pageId === pg.id && <span className="chalk-author-target" aria-hidden style={{ left: addAt.x, top: addAt.y, '--s': scale } as CSSProperties} />}
    </div>
  ), [sel, au.apply, addFiles, at_, authorTool, authorPen, erasable, authorLocale, openInsertMenu, addAt]);
  // + in the rail, or the right-click menu (with the page point it was opened at): that kind of media, with its options in the sidebar
  const pickMedia = useCallback((kind: MediaKind, at?: { pageId: string; x: number; y: number }) => { setAuthorToolState('select'); setSel(null); setAdding(kind); setAddAt(at ? { ...at, from: page } : null); }, [page]);
  // every opening sets what the picker offers (a cancelled one never reports back, so nothing is left narrowed)
  const openPicker = useCallback((accept: string) => { const input = mediaFile.current; if (!input) return; input.accept = accept; input.click(); }, []);
  const chooseFile = useCallback((kind: MediaKind) => openPicker({ image: 'image/*', video: 'video/*', audio: 'audio/*', model3d: '.glb,model/gltf-binary', lab: '.html,text/html' }[kind]), [openPicker]);
  const selectedObject = useMemo(() => {
    if (!sel) return null;
    return lesson.pages.find((p) => p.id === sel.pageId)?.objects.find((o) => o.id === sel.id) ?? null;
  }, [sel, lesson]);
  const sidebar = author && (rootWidth >= 720 || !!selectedObject || !!adding);
  // a selection that was undone away is gone
  useEffect(() => { if (sel && !selectedObject) setSel(null); }, [sel, selectedObject]);
  // on a phone the properties sheet covers the lower part: bring a newly selected object up above it
  useEffect(() => {
    if (!sel || !narrow()) return;
    const id = requestAnimationFrame(() => root.current?.querySelector(`.chalk-viewer [data-chalk-id="${CSS.escape(sel.id)}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
    return () => cancelAnimationFrame(id);
  }, [sel?.id]);   // eslint-disable-line react-hooks/exhaustive-deps

  const exportNotes = useCallback(async () => {
    const bytes = await packOverlay(ann.overlay);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/vnd.chalk+zip' }));
    a.download = `${book.lesson.title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'book'} · notes.chalk`;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    setToast(t.notesSaved);
  }, [ann.overlay, book.lesson.title, t]);
  const importNotes = useCallback(async (f: File) => {
    try { const { overlay } = await unpackOverlay(new Uint8Array(await f.arrayBuffer())); ann.load(overlay); setToast(t.notesOpened); }
    catch (e) { setToast(`${t.notesFailed}: ${e instanceof Error ? e.message : String(e)}`); }
  }, [ann, t]);
  const closeModal = useCallback(() => setModal(null), []);
  const togglePanel = (which: 'thumbnails' | 'search') => setPanel((p) => (p === which ? null : which));

  return (
    <PresenterProvider value={pr}>
    <div ref={root} className={`chalk-reader ${props.className ?? ''}`} data-theme={dark} data-dock={dockPos ?? 'none'} data-panel={panel ?? undefined} data-sidebar={sidebar ? '' : undefined} data-mode={authoringOn ? mode : undefined} lang={locale} style={props.style} onKeyDown={onKey}>
      <Viewer
        ref={viewer} book={book} pages={pages} layout={layout} fit={fit} zoom={zoom} zoomRange={config.zoom}
        onZoom={setZoom} onPage={changePage} page={page} renderHtmlObject={author ? renderPreview : renderHtmlObject}
        textLayer={config.features.textSelection && !drawing && !author} gestures={!drawing} pageLabel={pageLabel} highlights={highlights}
        pageActive={author ? noActive : pageActive} pageOverlay={author ? authorOverlay : pageOverlay} pdfWorkerSrc={config.pdfWorkerSrc}
      />
      {modal && (
        <Modal title={modal.kind === 'snip' ? (book.lesson.snipPages.find((p) => p.id === modal.pageId)?.title ?? t.openSnip) : modalTitle(modal.o, t, pr)}
          closeLabel={t.close} onClose={closeModal} container={root.current} wide={modal.kind === 'snip' || (modal.o.type === 'embed' && modal.o.embed !== 'audio')}
          full={modal.kind === 'media' && modal.full === true}>
          {modal.kind === 'snip'
            ? <SnipView book={book} pageId={modal.pageId} renderHtmlObject={renderHtmlObject} />
            : <MediaInModal book={book} o={modal.o} locale={locale} theme={dark} storage={storage} onClose={closeModal} />}
        </Modal>
      )}
      {floating && !author && (
        <FloatingWindow
          key={floating.o.id} title={modalTitle(floating.o, t, pr)} closeLabel={t.close} hint={t.windowHint} container={root.current}
          aspect={aspectFor(floating.o as { width: number; height: number }, config.window.aspect, floating.o.type === 'embed' && floating.o.embed === 'audio')}
          layout={config.window.layout} anchor={floating.anchor} opener={floating.opener} render={config.window.render} onClose={closeFloating}>
          <MediaInModal book={book} o={floating.o} locale={locale} theme={dark} storage={storage} onClose={closeFloating} fill />
        </FloatingWindow>
      )}
      {author && insertMenuOn && insertMenu && (
        <InsertMenu at={{ x: insertMenu.left, y: insertMenu.top }} t={at_} onClose={closeInsertMenu}
          onPick={(kind) => {
            pickMedia(kind, { pageId: insertMenu.pageId, x: insertMenu.x, y: insertMenu.y }); setInsertMenu(null);
            // the menu's item goes away with it: focus moves on to the picker it opened, not to the page's body
            requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('.chalk-sidebar :is(input, button, select):not([disabled])')?.focus({ preventScroll: true }));
          }} />
      )}
      {author && <AuthorRail tool={authorTool} onTool={setAuthorTool} adding={adding} onMedia={pickMedia} locale={authorLocale} t={at_} />}
      {sidebar && (
        <AuthorSidebar lesson={au.lesson} page={sel ? au.lesson.pages.find((x) => x.id === sel.pageId) : pages[page]} selected={selectedObject}
          tool={authorTool} adding={adding} tools={toolSettings} onTools={setToolSettings} defaults={insertDefaults} onDefaults={setInsertDefaults}
          apply={au.apply} onSelect={(id) => { const pg = pages[page]; if (pg) setSel({ pageId: pg.id, id }); }}
          onDelete={() => { if (sel) au.apply(edit.remove(sel.pageId, new Set([sel.id]))); setSel(null); }}
          libraries={libs} onLibrariesChange={props.onLibrariesChange} onPickItem={(it, lib) => void placeItem(it, lib)} onUploadTo={(fs, lib) => void uploadTo(fs, lib)}
          onChooseFile={chooseFile} onDropFiles={(fs) => { const { pg, at } = target(); if (pg) void addFiles(fs, pg, at); }}
          onClose={rootWidth < 720 ? () => { setSel(null); setAdding(null); } : undefined} closeLabel={strings(authorLocale).close} locale={authorLocale} t={at_} />
      )}
      {authoringOn && (
        <input ref={mediaFile} type="file" accept={ACCEPT} multiple hidden
          onChange={(e) => { const fs = [...(e.target.files ?? [])]; const { pg, at } = target(); if (fs.length && pg) void addFiles(fs, pg, at); e.target.value = ''; }} />
      )}
      {panel === 'thumbnails' && config.features.thumbnails && (
        <Panel title={t.thumbnails} closeLabel={t.close} onClose={() => setPanel(null)}>
          <Thumbnails book={book} pages={pages} current={page} locale={locale} renderHtmlObject={renderPreview} pdfWorkerSrc={config.pdfWorkerSrc}
            onPick={(i) => { goTo(i); if (narrow()) setPanel(null); }} />
        </Panel>
      )}
      {panel === 'search' && config.features.search && (
        <Panel title={t.search} closeLabel={t.close} onClose={() => setPanel(null)}>
          <Search locale={locale} query={query} onQuery={setQuery} hits={hits} current={hit}
            onPick={(i) => { showHit(i); if (narrow()) setPanel(null); }} onStep={stepHit} />
        </Panel>
      )}
      <input ref={notesFile} type="file" accept=".chalk,application/vnd.chalk+zip,application/zip" hidden
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void importNotes(f); e.target.value = ''; }} />
      {loadProgress
        ? <div className="chalk-toast" role="status">{at_.loadingProgress.replace('{done}', num(authorLocale, loadProgress.done)).replace('{total}', num(authorLocale, loadProgress.total))}</div>
        : (toast ?? saveNote) && <div className="chalk-toast" role="status">{toast ?? saveNote}</div>}
      {lookup.missing.size > 0 && <MissingChip lesson={lesson} missing={lookup.missing} t={t} locale={locale} onGo={(i) => goTo(i)} />}
      {dockCfg && (
        <Dock
          config={config} dock={dockCfg} locale={author ? authorLocale : locale} page={page} pageCount={pages.length} zoom={zoom} fit={fit} layout={layout} dark={dark === 'dark'} fullscreen={fullscreen}
          open={{ thumbnails: panel === 'thumbnails', search: panel === 'search' }}
          canUndo={author ? au.canUndo : ann.canUndo} canRedo={author ? au.canRedo : ann.canRedo}
          author={authoringOn ? { on: author, dirty: au.dirty, saving, t: at_ } : undefined}
          tools={A.tools.length > 1 ? <ToolsMenu config={A} locale={locale} tool={tool} color={color} highlight={highlight} size={size}
            onTool={setTool} onColor={setColor} onHighlight={setHighlight} onSize={setSize} up={dockCfg.position !== 'top'} /> : undefined}
          actions={{
            undo: author ? au.undo : ann.undo, redo: author ? au.redo : ann.redo,
            // the dock's own add goes to the page in view, never to a spot chosen earlier from the right-click menu
            mode: () => setMode(author ? 'read' : 'author'), add: () => { setAddAt(null); openPicker(ACCEPT); }, save: () => void saveBook(),
            exportNotes: () => void exportNotes(), importNotes: () => notesFile.current?.click(),
            prev, next, goTo, thumbnails: () => togglePanel('thumbnails'), search: () => togglePanel('search'), zoomIn: () => zoomBy(config.zoom.step), zoomOut: () => zoomBy(1 / config.zoom.step),
            fit: () => { setFit((f) => (f === 'page' ? (config.fit === 'page' ? 'auto' : config.fit) : 'page')); viewer.current?.zoomTo(1); }, setLayout,
            theme: () => setTheme(dark === 'dark' ? 'light' : 'dark'), language: () => setLocale((l) => (l === 'bn' ? 'en' : 'bn')), fullscreen: toggleFullscreen,
          }}
        />
      )}
    </div>
    </PresenterProvider>
  );
}

const modalTitle = (o: LessonObject, t: ReturnType<typeof strings>, pr: Presenter) =>
  (o.type === 'image' || o.type === 'embed' ? pr.present(o).label : undefined)
  ?? (o.type === 'embed' ? (isLabObject(o) ? o.lab.title : o.embed === 'model3d' ? t.model3d : o.embed === 'video' ? t.video : o.embed === 'audio' ? t.audio : o.embed) : t.image);

/** Is a card too small on this screen to use the object in its box? A lab needs room for its controls; a model
 *  only needs to be big enough to turn (spec 1.3 §1: such an object MAY open in a popup instead). */
function tooSmall(el: HTMLElement, lab: boolean): boolean {
  const r = el.getBoundingClientRect(), [w, h] = lab ? [440, 260] : [240, 180];
  return r.width < w || r.height < h;
}

/** A full-size image, drawn as HTML so that it can be tapped when its author made it open (spec 1.3). */
function OpenableImage({ book, o, label, onActivate }: { book: Book; o: Extract<LessonObject, { type: 'image' }>; label: string; onActivate?: ((el: HTMLElement) => void) | undefined }) {
  const url = useAssetUrl(book, o.assetId);
  return (
    <Box x={o.x} y={o.y} width={o.width} height={o.height} className="chalk-image-open" label={label} id={o.id} {...(onActivate ? { onActivate } : {})}>
      {url ? <img src={url} alt="" draggable={false} /> : <span className="chalk-placeholder" />}
    </Box>
  );
}

/** A snip page (spec 1.0 §3.4), fitted to the dialog. */
function SnipView({ book, pageId, renderHtmlObject }: { book: Book; pageId: string; renderHtmlObject: HtmlObjectRenderer }) {
  const pg = book.lesson.snipPages.find((p) => p.id === pageId);
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => { const e = box.current; if (!e) return; const ro = new ResizeObserver(() => setW(e.clientWidth)); ro.observe(e); return () => ro.disconnect(); }, []);
  if (!pg) return null;
  const size = getPageSize(pg), scale = w ? Math.min(w / size.width, (window.innerHeight * 0.7) / size.height) : 0;
  return <div ref={box} className="chalk-snip">{scale > 0 && <PageView book={book} page={pg} scale={scale} live renderHtmlObject={renderHtmlObject} />}</div>;
}

/** Icon-mode media opened in the dialog, at a comfortable size. */
function MediaInModal({ book, o, locale, theme, storage, onClose, fill }: { book: Book; o: LessonObject; locale: Locale; theme: 'light' | 'dark'; storage: LabStorage | null; onClose: () => void; fill?: boolean }) {
  const url = useAssetUrl(book, o.type === 'image' ? o.assetId : o.type === 'embed' ? o.assetId : undefined);
  const pr = usePresenter();
  const mediaClass = fill ? 'chalk-window-media' : 'chalk-modal-media';
  if (o.type === 'image') return url ? <img className={mediaClass} src={url} alt={pr.present(o).label ?? ''} /> : null;
  if (o.type !== 'embed') return null;
  const big = fill ? { position: 'relative' as const, width: '100%', height: '100%' } : { position: 'relative' as const, width: '100%', aspectRatio: o.embed === 'model3d' ? '4 / 3' : '16 / 9' };
  if (isLabObject(o)) return <LabFrame book={book} o={o as LabObject} style={fill ? { position: 'relative', width: '100%', height: '100%' } : { position: 'relative', width: '100%', height: '100%', minHeight: 'min(70vh, 560px)' }} locale={locale} theme={theme} storage={storage} onStop={onClose} />;
  if (o.embed === 'model3d') return <ModelViewer book={book} o={o} style={big} where="popup" />;
  const p = pr.present(o);
  // opened by a tap: the student asked, so it plays (with sound unless the author muted it)
  const R = pr.renderers.video;
  if (o.embed === 'video' && R) return <div className={fill ? 'chalk-window-custom-media' : 'chalk-modal-custom'}>{R({ object: o, src: url ?? null, poster: null, presentation: p, where: 'popup', ...pr.env })}</div>;
  if (o.embed === 'video') return url ? <video className={mediaClass} src={url} controls autoPlay playsInline loop={p.loop} muted={p.muted} /> : null;
  if (o.embed === 'audio') return <ModalAudio book={book} o={o} locale={locale} />;
  return null;
}

function ModalAudio({ book, o, locale }: { book: Book; o: EmbedObject; locale: Locale }) {
  // the in-page player, at a fixed size inside the dialog
  return (
    <div className="chalk-modal-audio">
      <div className="chalk-page-units" style={{ position: 'relative', width: 480, height: 96, transform: 'none' }}>
        <AudioEmbed book={book} o={{ ...o, x: 0, y: 0, width: 480, height: 96 }} locale={locale} />
      </div>
    </div>
  );
}
