import type { ReactNode } from 'react';
import { DEFAULT_PRESENTATION, type MediaRenderers, type PresentationConfig } from './present.js';

/**
 * Everything about the reader that a host app can set. One `config` prop, partial: what is not given keeps
 * the default below. Arrays (dock items, tools, colours) replace the default rather than merge with it.
 */

/** Annotation tools (spec 1.0 objects the student adds as an overlay). */
export type ToolId = 'pan' | 'select' | 'pen' | 'highlighter' | 'eraser' | 'text' | 'rect' | 'ellipse' | 'line' | 'arrow';

/** Built-in dock items. `'|'` draws a divider. */
export type DockItemId =
  | 'prev' | 'page' | 'next'
  | 'zoomOut' | 'fit' | 'zoomIn' | 'layout'
  | 'thumbnails' | 'search'
  | 'tools' | 'undo' | 'redo'
  | 'export' | 'import' | 'theme' | 'language' | 'fullscreen'
  /** Authoring (when `authoring.enabled`): switch between reading and authoring, add media, save the book. */
  | 'mode' | 'add' | 'save'
  | '|';

/** A dock button of the host's own. */
export type CustomDockItem = { id: string; label: string; icon: ReactNode; onClick: () => void; active?: boolean };

export type Layout = 'continuous' | 'single' | 'spread';
export type Fit = 'auto' | 'width' | 'page';
export type ThemeChoice = 'light' | 'dark' | 'system';
export type Locale = 'bn' | 'en';

export type ReaderConfig = {
  /** Pages one under another (default), one at a time, or two side by side on wide screens. */
  layout: Layout;
  /** What zoom 100 % means: the page's width fills the view ('width'), the whole page fits ('page'), or the
   *  width fills the view but no page is drawn wider than a comfortable reading width ('auto', default). */
  fit: Fit;
  zoom: { min: number; max: number; step: number };
  theme: ThemeChoice;
  locale: Locale;
  /** Page to open at: 1-based number or a page id. */
  initialPage: number | string;
  readOnly: boolean;
  features: {
    thumbnails: boolean;
    search: boolean;
    annotations: boolean;
    media: boolean;
    model3d: boolean;
    labs: boolean;
    snips: boolean;
    fullscreen: boolean;
    export: boolean;
    keyboard: boolean;
    textSelection: boolean;
    themeToggle: boolean;
    languageToggle: boolean;
  };
  dock: false | {
    position: 'bottom' | 'top' | 'left' | 'right';
    items: (DockItemId | CustomDockItem)[];
  };
  annotations: {
    tools: ToolId[];
    defaultTool: ToolId;
    /** Pen, text and shape colours (CSS colours). */
    colors: string[];
    /** Highlighter colours (drawn translucent). */
    highlighterColors: string[];
    /** Stroke sizes in page units. */
    sizes: number[];
    /** Let the student move or delete the book's own objects, not only their own (recorded in the overlay). */
    editBase: boolean;
  };
  labs: {
    /** Start a lab when its page comes into view instead of on a tap. */
    autoStart: boolean;
  };
  /** Where annotations are kept when the host does not handle them: this browser, or nowhere. */
  persistence: 'local' | 'none';
  /** pdf.js's worker script (a URL), to draw PDF pages that carry no rendered image. Unset: a placeholder.
   *  With Vite: `import src from 'pdfjs-dist/build/pdf.worker.min.mjs?url'`. */
  pdfWorkerSrc: string | null;
  /** How media is presented: your icons, colours and defaults, and whether authors' colours and live media are
   *  used (spec 1.3 §5). The author's choices are kept wherever you do not override them. */
  presentation: PresentationConfig;
  /** Author mode: place media on the pages and choose how each piece is presented (spec 1.3), then save the
   *  book. Off by default; a reader for students leaves it off. While on, read mode is the student's reader over
   *  the edited book (notes stay on top of it); author mode edits the book and hides the notes. */
  authoring: {
    enabled: boolean;
    /** The mode the reader opens in. */
    startIn: 'read' | 'author';
    /** The dock in author mode. The read-mode dock gets a 'mode' button at its start if it has none. */
    dock: (DockItemId | CustomDockItem)[];
  };
  /** Your own player or viewer for a kind, in place of the reader's (the browser's video and audio, <model-viewer>). */
  renderers: MediaRenderers;
};

export const DEFAULT_CONFIG: ReaderConfig = {
  layout: 'continuous',
  fit: 'auto',
  zoom: { min: 0.25, max: 5, step: 1.25 },
  theme: 'system',
  locale: 'bn',
  initialPage: 1,
  readOnly: false,
  features: {
    thumbnails: true, search: true, annotations: true, media: true, model3d: true, labs: true, snips: true,
    fullscreen: true, export: true, keyboard: true, textSelection: true, themeToggle: true, languageToggle: true,
  },
  dock: {
    position: 'bottom',
    items: ['thumbnails', 'search', '|', 'prev', 'page', 'next', '|', 'zoomOut', 'fit', 'zoomIn', '|', 'tools', 'undo', 'redo', '|', 'export', 'import', 'theme', 'language', 'fullscreen'],
  },
  annotations: {
    tools: ['pan', 'pen', 'highlighter', 'eraser', 'text', 'rect', 'ellipse', 'arrow', 'select'],
    defaultTool: 'pan',
    colors: ['#1f2a44', '#c0392b', '#1565c0', '#2e7d32', '#ef6c00'],
    highlighterColors: ['#ffe066', '#a5f3a1', '#9fd3ff', '#ffb3c7'],
    sizes: [3, 6, 12],
    editBase: false,
  },
  labs: { autoStart: false },
  persistence: 'local',
  pdfWorkerSrc: null,
  authoring: {
    enabled: false, startIn: 'read',
    dock: ['mode', '|', 'thumbnails', '|', 'prev', 'page', 'next', '|', 'zoomOut', 'fit', 'zoomIn', '|', 'undo', 'redo', '|', 'save', 'theme', 'language'],
  },
  presentation: DEFAULT_PRESENTATION,
  renderers: {},
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends readonly unknown[] | ((...a: never[]) => unknown) ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K] };
export type ReaderConfigInput = DeepPartial<ReaderConfig>;

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/** Defaults overlaid with the host's partial config. Arrays and non-plain values replace; plain objects merge. */
export function resolveConfig(input: ReaderConfigInput = {}): ReaderConfig {
  const merge = (base: unknown, over: unknown): unknown => {
    if (over === undefined) return base;
    if (isPlain(base) && isPlain(over)) {
      const out: Record<string, unknown> = { ...base };
      for (const [k, v] of Object.entries(over)) out[k] = merge(base[k], v);
      return out;
    }
    return over;
  };
  const c = merge(DEFAULT_CONFIG, input) as ReaderConfig;
  // no annotations in read-only mode, whatever else says; and no authoring
  if (c.readOnly) { c.features = { ...c.features, annotations: false }; c.authoring = { ...c.authoring, enabled: false }; }
  if (!c.annotations.tools.includes(c.annotations.defaultTool)) c.annotations = { ...c.annotations, defaultTool: c.annotations.tools[0] ?? 'pan' };
  return c;
}
