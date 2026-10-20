import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { LessonPage } from '@chalk-format/model';
import { openBook, type AssetResolver, type Book, type BookSource } from './book.js';
import { resolveConfig, type Fit, type Layout, type Locale, type ReaderConfig, type ReaderConfigInput } from './config.js';
import { num, strings } from './i18n.js';
import { Dock } from './Dock.js';
import { Viewer, type ViewerHandle } from './Viewer.js';
import { EmbedCard, IconMarker, embedIcon, imageGlyph, snipGlyph } from './render/Markers.js';
import type { HtmlObjectRenderer } from './render/PageView.js';

export type ChalkReaderProps = {
  /** The book: bytes, a File/Blob or a URL. Or pass an already opened `book`. */
  source?: BookSource;
  book?: Book;
  /** Fetches assets a thin book does not carry. */
  resolveAsset?: AssetResolver;
  config?: ReaderConfigInput;
  /** 0-based page index, whenever it changes. */
  onPageChange?: (index: number, page: LessonPage) => void;
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
  const pages = book.lesson.pages;
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
    if (k === 'PageDown' || (k === 'ArrowRight' && !mod) || (k === ' ' && layout === 'single')) { e.preventDefault(); next(); }
    else if (k === 'PageUp' || (k === 'ArrowLeft' && !mod)) { e.preventDefault(); prev(); }
    else if (k === 'Home') { e.preventDefault(); goTo(0); }
    else if (k === 'End') { e.preventDefault(); goTo(pages.length - 1); }
    else if (k === '+' || k === '=') { e.preventDefault(); zoomBy(config.zoom.step); }
    else if (k === '-') { e.preventDefault(); zoomBy(1 / config.zoom.step); }
    else if (k === '0') { e.preventDefault(); viewer.current?.zoomTo(1); }
  };

  const renderHtmlObject: HtmlObjectRenderer = useCallback((o) => {
    if (o.type === 'snip') return config.features.snips ? <IconMarker x={o.x} y={o.y} kind="snip" glyph={snipGlyph} label={t.openSnip} /> : null;
    if (o.type === 'image') return <IconMarker x={o.x} y={o.y} kind="media" glyph={imageGlyph} label="" />;
    if (o.displayMode === 'icon') return <IconMarker x={o.x} y={o.y} kind="media" glyph={embedIcon(o, 26)} label={o.lab?.title ?? o.embed} />;
    return <EmbedCard book={book} o={o} caption={o.lab?.title} label={o.lab?.title ?? o.embed} />;
  }, [book, config.features.snips, t]);

  const pageLabel = useCallback((i: number) => `${t.page} ${num(locale, i + 1)}`, [t, locale]);

  return (
    <div ref={root} className={`chalk-reader ${props.className ?? ''}`} data-theme={dark} data-dock={config.dock ? config.dock.position : 'none'} lang={locale} style={props.style} onKeyDown={onKey}>
      <Viewer
        ref={viewer} book={book} pages={pages} layout={layout} fit={fit} zoom={zoom} zoomRange={config.zoom}
        onZoom={setZoom} onPage={changePage} page={page} renderHtmlObject={renderHtmlObject}
        textLayer={config.features.textSelection} gestures pageLabel={pageLabel}
      />
      {config.dock && (
        <Dock
          config={config} dock={config.dock} locale={locale} page={page} pageCount={pages.length} zoom={zoom} fit={fit} layout={layout} dark={dark === 'dark'} fullscreen={fullscreen}
          actions={{
            prev, next, goTo, zoomIn: () => zoomBy(config.zoom.step), zoomOut: () => zoomBy(1 / config.zoom.step),
            fit: () => { setFit((f) => (f === 'width' ? 'page' : 'width')); viewer.current?.zoomTo(1); }, setLayout,
            theme: () => setTheme(dark === 'dark' ? 'light' : 'dark'), language: () => setLocale((l) => (l === 'bn' ? 'en' : 'bn')), fullscreen: toggleFullscreen,
          }}
        />
      )}
    </div>
  );
}
