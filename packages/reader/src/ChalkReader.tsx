import { forwardRef, useCallback, useDeferredValue, useEffect, useImperativeHandle, useMemo, useRef, useState, type CSSProperties } from 'react';
import { getPageSize, isLabObject, type EmbedObject, type LabObject, type LessonObject, type LessonPage } from '@chalk-format/model';
import { openBook, type AssetResolver, type Book, type BookSource } from './book.js';
import { resolveConfig, type Fit, type Layout, type Locale, type ReaderConfig, type ReaderConfigInput } from './config.js';
import { num, strings } from './i18n.js';
import { Dock } from './Dock.js';
import { Viewer, type ViewerHandle } from './Viewer.js';
import { EmbedCard, IconMarker, embedIcon, imageGlyph, snipGlyph } from './render/Markers.js';
import { PageView, type HtmlObjectRenderer } from './render/PageView.js';
import { AudioEmbed, LabFrame, ModelViewer, VideoEmbed, localLabStorage, type LabStorage } from './render/Embeds.js';
import { Modal } from './render/Modal.js';
import { useAssetUrl } from './render/assets.js';
import { packOverlay, unpackOverlay } from '@chalk-format/container';
import type { Overlay } from '@chalk-format/model';
import { useAnnotations } from './annotate/state.js';
import { Surface, type Pen } from './annotate/Surface.js';
import { ToolsMenu } from './annotate/ToolsMenu.js';
import type { ToolId } from './config.js';
import { Panel } from './panels/Panel.js';
import { Search } from './panels/Search.js';
import { Thumbnails } from './panels/Thumbnails.js';
import { searchBook } from './search.js';

export type ChalkReaderProps = {
  /** The book: bytes, a File/Blob or a URL. Or pass an already opened `book`. */
  source?: BookSource;
  book?: Book;
  /** Fetches assets a thin book does not carry. */
  resolveAsset?: AssetResolver;
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
  className?: string;
  style?: CSSProperties;
};

export type ReaderHandle = {
  goTo(page: number): void;
  next(): void;
  prev(): void;
  zoomTo(zoom: number): void;
  readonly book: Book | null;
};

/** The reference reader for `.chalk` books (docs/reader-plan.md). */
export const ChalkReader = forwardRef<ReaderHandle, ChalkReaderProps>(function ChalkReader(props, ref) {
  const config = useMemo(() => resolveConfig(props.config), [props.config]);
  const [opened, setOpened] = useState<{ book: Book | null; error: string | null }>({ book: props.book ?? null, error: null });

  useEffect(() => {
    if (props.book) { setOpened({ book: props.book, error: null }); return; }
    if (!props.source) return;
    let live = true, mine: Book | null = null;
    setOpened({ book: null, error: null });
    openBook(props.source, props.resolveAsset ? { resolveAsset: props.resolveAsset } : {}).then(
      (b) => { if (live) { mine = b; setOpened({ book: b, error: null }); } else b.dispose(); },
      (e: unknown) => { if (live) setOpened({ book: null, error: e instanceof Error ? e.message : String(e) }); },
    );
    return () => { live = false; mine?.dispose(); };
  }, [props.source, props.book, props.resolveAsset]);

  const t = strings(config.locale);
  if (opened.error) return <Shell config={config} className={props.className} style={props.style}><div className="chalk-state is-error" role="alert"><strong>{t.failed}</strong><span>{opened.error}</span></div></Shell>;
  if (!opened.book) return <Shell config={config} className={props.className} style={props.style}><div className="chalk-state" role="status"><span className="chalk-spinner" aria-hidden />{t.loading}</div></Shell>;
  return <Reader key={opened.book.lesson.id} {...props} book={opened.book} config={config} handleRef={ref} />;
});

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
  const { book, config } = props;
  const ann = useAnnotations(book.lesson, { overlay: props.overlay, defaultOverlay: props.defaultOverlay, onOverlayChange: props.onOverlayChange, persistence: config.persistence });
  const lesson = ann.lesson;
  const pages = lesson.pages;
  const viewer = useRef<ViewerHandle>(null);
  const root = useRef<HTMLDivElement>(null);
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
  const dockCfg = config.dock && dockPos ? { ...config.dock, position: dockPos } : null;
  const [panel, setPanel] = useState<'thumbnails' | 'search' | null>(null);
  const [query, setQuery] = useState('');
  const [hit, setHit] = useState(0);
  const deferredQuery = useDeferredValue(query);
  // one live embed at a time (a running lab or a 3D viewer), and at most one dialog
  const [active, setActive] = useState<{ id: string; page: number } | null>(null);
  const [modal, setModal] = useState<{ kind: 'snip'; pageId: string } | { kind: 'media'; o: LessonObject } | null>(null);
  const storage = props.labStorage ?? (config.persistence === 'local' ? localLabStorage : null);
  const hits = useMemo(() => (panel === 'search' || deferredQuery ? searchBook(lesson, deferredQuery) : []), [lesson, deferredQuery, panel]);
  // the pen: tool, colours and size
  const A = config.annotations;
  const [tool, setTool] = useState<ToolId>(A.defaultTool);
  const [color, setColor] = useState(A.colors[0] ?? '#1f2a44');
  const [highlight, setHighlight] = useState(A.highlighterColors[0] ?? '#ffe066');
  const [size, setSize] = useState(A.sizes[Math.min(1, A.sizes.length - 1)] ?? 4);
  const drawing = config.features.annotations && tool !== 'pan';
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
  const t = strings(locale);
  const onPage = props.onPageChange;
  const changePage = useCallback((i: number) => { setPage((prev) => { if (prev !== i) onPage?.(i, pages[i]!); return i; }); }, [onPage, pages]);

  useEffect(() => { const id = requestAnimationFrame(() => viewer.current?.goTo(startPage)); return () => cancelAnimationFrame(id); }, [startPage]);

  const goTo = useCallback((i: number) => { const n = Math.min(Math.max(0, i), pages.length - 1); viewer.current?.goTo(n, true); if (layout === 'single') changePage(n); }, [pages.length, layout, changePage]);
  const step = layout === 'spread' ? 2 : 1;
  const next = useCallback(() => goTo(page + step), [goTo, page, step]);
  const prev = useCallback(() => goTo(page - step), [goTo, page, step]);
  const zoomBy = useCallback((f: number) => viewer.current?.zoomTo(zoom * f), [zoom]);

  useImperativeHandle(props.handleRef, () => ({ goTo: (n) => goTo(n - 1), next, prev, zoomTo: (z) => viewer.current?.zoomTo(z), book }), [goTo, next, prev, book]);

  useEffect(() => {
    const f = () => setFullscreen(document.fullscreenElement === root.current);
    document.addEventListener('fullscreenchange', f); return () => document.removeEventListener('fullscreenchange', f);
  }, []);
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen(); else void root.current?.requestFullscreen?.();
  }, []);

  const onKey = (e: React.KeyboardEvent) => {
    if (!config.features.keyboard || e.defaultPrevented) return;
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement).isContentEditable) return;
    const k = e.key, mod = e.ctrlKey || e.metaKey;
    if (mod && k.toLowerCase() === 'f' && config.features.search) { e.preventDefault(); setPanel('search'); return; }
    if (config.features.annotations && mod && (k.toLowerCase() === 'z' || k.toLowerCase() === 'y')) {
      e.preventDefault(); if (k.toLowerCase() === 'y' || e.shiftKey) ann.redo(); else ann.undo(); return;
    }
    if (k === 'PageDown' || (k === 'ArrowRight' && !mod) || (k === ' ' && layout === 'single')) { e.preventDefault(); next(); }
    else if (k === 'PageUp' || (k === 'ArrowLeft' && !mod)) { e.preventDefault(); prev(); }
    else if (k === 'Home') { e.preventDefault(); goTo(0); }
    else if (k === 'End') { e.preventDefault(); goTo(pages.length - 1); }
    else if (k === '+' || k === '=') { e.preventDefault(); zoomBy(config.zoom.step); }
    else if (k === '-') { e.preventDefault(); zoomBy(1 / config.zoom.step); }
    else if (k === '0') { e.preventDefault(); viewer.current?.zoomTo(1); }
  };

  const onLabProgress = props.onLabProgress;
  const renderHtmlObject: HtmlObjectRenderer = useCallback((o, pg) => {
    const f = config.features, pi = pages.indexOf(pg);
    if (o.type === 'snip') return f.snips ? <IconMarker x={o.x} y={o.y} kind="snip" glyph={snipGlyph} label={t.openSnip} onActivate={() => setModal({ kind: 'snip', pageId: o.snipPageId })} /> : null;
    if (o.type === 'image') return <IconMarker x={o.x} y={o.y} kind="media" glyph={imageGlyph} label="" onActivate={() => setModal({ kind: 'media', o })} />;
    const lab = isLabObject(o) ? o : null;
    const canRun = lab ? f.labs : o.embed === 'model3d' ? f.model3d : o.embed === 'video' || o.embed === 'audio' ? f.media : false;
    const label = lab?.lab.title ?? (o.embed === 'model3d' ? t.model3d : o.embed === 'video' ? t.video : o.embed === 'audio' ? t.audio : t.unsupported);
    if (o.displayMode === 'icon') return <IconMarker x={o.x} y={o.y} kind="media" glyph={embedIcon(o, 26)} label={label} onActivate={canRun ? () => setModal({ kind: 'media', o }) : undefined} />;
    if (!canRun) return <EmbedCard book={book} o={o} caption={o.embed === 'plugin' && !lab ? t.unsupported : lab?.lab.title} label={label} />;
    if (o.embed === 'video') return <VideoEmbed book={book} o={o} label={label} />;
    if (o.embed === 'audio') return <AudioEmbed book={book} o={o} locale={locale} />;
    // in its box on the page, unless that box is too small on this screen to use: then a larger view
    // a lab needs room for its controls; a model only needs to be big enough to turn
    const start = (el: HTMLElement) => {
      const r = el.getBoundingClientRect(), [w, h] = lab ? [440, 260] : [240, 180];
      if (r.width < w || r.height < h) setModal({ kind: 'media', o }); else setActive({ id: o.id, page: pi });
    };
    return <EmbedCard book={book} o={o} caption={lab ? `${lab.lab.title} · ${t.startLab}` : undefined} label={lab ? `${t.startLab}: ${lab.lab.title}` : label} onActivate={start} />;
  }, [book, config.features, t, locale, pages]);

  // previews (thumbnails, snips inside a dialog): the same cards and markers, but inert
  const renderPreview: HtmlObjectRenderer = useCallback((o) => {
    if (o.type === 'snip') return <IconMarker x={o.x} y={o.y} kind="snip" glyph={snipGlyph} label={t.openSnip} />;
    if (o.type === 'image') return <IconMarker x={o.x} y={o.y} kind="media" glyph={imageGlyph} label="" />;
    if (o.displayMode === 'icon') return <IconMarker x={o.x} y={o.y} kind="media" glyph={embedIcon(o, 26)} label="" />;
    return <EmbedCard book={book} o={o} caption={isLabObject(o) ? o.lab.title : undefined} />;
  }, [book, t]);

  // the live embed on a page, drawn in screen pixels above it
  const pageActive = useCallback((pg: LessonPage, i: number, scale: number) => {
    if (!active || active.page !== i) return undefined;
    const o = pg.objects.find((x) => x.id === active.id);
    if (!o || o.type !== 'embed') return undefined;
    const style = { left: o.x * scale, top: o.y * scale, width: o.width * scale, height: o.height * scale };
    if (isLabObject(o)) return <LabFrame book={book} o={o} style={style} locale={locale} theme={dark} storage={storage}
      onProgress={(p) => onLabProgress?.(p, { objectId: o.id, labId: o.lab.id, page: i })} onStop={() => setActive(null)} />;
    return <ModelViewer book={book} o={o} style={style} />;
  }, [active, book, locale, dark, storage, onLabProgress]);

  // a live embed stops once its page is well out of view (it would be off screen, using the phone's power)
  useEffect(() => { if (active && Math.abs(active.page - page) > 1) setActive(null); }, [page, active]);
  // labs.autoStart: the first lab on the page you arrive at starts by itself
  useEffect(() => {
    if (!config.labs.autoStart || !config.features.labs) return;
    const lab = pages[page]?.objects.find((x) => isLabObject(x) && x.displayMode !== 'icon');
    if (lab && active?.id !== lab.id) setActive({ id: lab.id, page });
  }, [page, config.labs.autoStart, config.features.labs]);   // eslint-disable-line react-hooks/exhaustive-deps

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
  const narrow = () => (root.current?.clientWidth ?? 1000) < 720;

  const editableOn = useCallback((pageId: string) => (o: LessonObject) => A.editBase || ann.isOwn(pageId, o), [A.editBase, ann.isOwn]);   // eslint-disable-line react-hooks/exhaustive-deps
  const pageOverlay = useCallback((pg: LessonPage, _i: number, scale: number) =>
    drawing ? <Surface page={pg} scale={scale} pen={pen} editable={editableOn(pg.id)} apply={ann.apply} textPrompt={t.textPrompt} /> : undefined,
  [drawing, pen, editableOn, ann.apply, t.textPrompt]);

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
  const togglePanel = (which: 'thumbnails' | 'search') => setPanel((p) => (p === which ? null : which));

  return (
    <div ref={root} className={`chalk-reader ${props.className ?? ''}`} data-theme={dark} data-dock={dockPos ?? 'none'} data-panel={panel ?? undefined} lang={locale} style={props.style} onKeyDown={onKey}>
      <Viewer
        ref={viewer} book={book} pages={pages} layout={layout} fit={fit} zoom={zoom} zoomRange={config.zoom}
        onZoom={setZoom} onPage={changePage} page={page} renderHtmlObject={renderHtmlObject}
        textLayer={config.features.textSelection && !drawing} gestures={!drawing} pageLabel={pageLabel} highlights={highlights} pageActive={pageActive} pageOverlay={pageOverlay} pdfWorkerSrc={config.pdfWorkerSrc}
      />
      {modal && (
        <Modal title={modal.kind === 'snip' ? (book.lesson.snipPages.find((p) => p.id === modal.pageId)?.title ?? t.openSnip) : modalTitle(modal.o, t)}
          closeLabel={t.close} onClose={() => setModal(null)} container={root.current} wide={modal.kind === 'snip' || (modal.o.type === 'embed' && modal.o.embed !== 'audio')}>
          {modal.kind === 'snip'
            ? <SnipView book={book} pageId={modal.pageId} renderHtmlObject={renderHtmlObject} />
            : <MediaInModal book={book} o={modal.o} locale={locale} theme={dark} storage={storage} onClose={() => setModal(null)} />}
        </Modal>
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
      {toast && <div className="chalk-toast" role="status">{toast}</div>}
      {dockCfg && (
        <Dock
          config={config} dock={dockCfg} locale={locale} page={page} pageCount={pages.length} zoom={zoom} fit={fit} layout={layout} dark={dark === 'dark'} fullscreen={fullscreen}
          open={{ thumbnails: panel === 'thumbnails', search: panel === 'search' }}
          canUndo={ann.canUndo} canRedo={ann.canRedo}
          tools={A.tools.length > 1 ? <ToolsMenu config={A} locale={locale} tool={tool} color={color} highlight={highlight} size={size}
            onTool={setTool} onColor={setColor} onHighlight={setHighlight} onSize={setSize} up={dockCfg.position !== 'top'} /> : undefined}
          actions={{
            undo: ann.undo, redo: ann.redo, exportNotes: () => void exportNotes(), importNotes: () => notesFile.current?.click(),
            prev, next, goTo, thumbnails: () => togglePanel('thumbnails'), search: () => togglePanel('search'), zoomIn: () => zoomBy(config.zoom.step), zoomOut: () => zoomBy(1 / config.zoom.step),
            fit: () => { setFit((f) => (f === 'page' ? (config.fit === 'page' ? 'auto' : config.fit) : 'page')); viewer.current?.zoomTo(1); }, setLayout,
            theme: () => setTheme(dark === 'dark' ? 'light' : 'dark'), language: () => setLocale((l) => (l === 'bn' ? 'en' : 'bn')), fullscreen: toggleFullscreen,
          }}
        />
      )}
    </div>
  );
}

const modalTitle = (o: LessonObject, t: ReturnType<typeof strings>) =>
  o.type === 'embed' ? (isLabObject(o) ? o.lab.title : o.embed === 'model3d' ? t.model3d : o.embed === 'video' ? t.video : o.embed === 'audio' ? t.audio : o.embed) : '';

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
function MediaInModal({ book, o, locale, theme, storage, onClose }: { book: Book; o: LessonObject; locale: Locale; theme: 'light' | 'dark'; storage: LabStorage | null; onClose: () => void }) {
  const url = useAssetUrl(book, o.type === 'image' ? o.assetId : o.type === 'embed' ? o.assetId : undefined);
  if (o.type === 'image') return url ? <img className="chalk-modal-media" src={url} alt="" /> : null;
  if (o.type !== 'embed') return null;
  const big = { position: 'relative' as const, width: '100%', aspectRatio: o.embed === 'model3d' ? '4 / 3' : '16 / 9' };
  if (isLabObject(o)) return <LabFrame book={book} o={o as LabObject} style={{ position: 'relative', width: '100%', height: '100%', minHeight: 'min(70vh, 560px)' }} locale={locale} theme={theme} storage={storage} onStop={onClose} />;
  if (o.embed === 'model3d') return <ModelViewer book={book} o={o} style={big} />;
  if (o.embed === 'video') return url ? <video className="chalk-modal-media" src={url} controls autoPlay playsInline /> : null;
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
