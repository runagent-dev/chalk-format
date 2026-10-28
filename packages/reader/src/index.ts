export { ChalkReader, type ChalkReaderProps, type ReaderHandle } from './ChalkReader.js';
export type { SaveProgress } from './author/save-run.js';
export { openBook, bookFrom, type Book, type BookSource, type AssetResolver } from './book.js';
export {
  DEFAULT_CONFIG, resolveConfig,
  type ReaderConfig, type ReaderConfigInput, type ToolId, type DockItemId, type CustomDockItem, type Layout, type Fit, type Locale, type ThemeChoice,
} from './config.js';
export {
  DEFAULT_PRESENTATION, kindOf,
  type PresentationConfig, type MediaRenderers, type MediaRendererProps, type IconArt, type KindId,
} from './present.js';
export type { IconName, Presentation, ResolvedPresentation } from '@chalk-format/model';
export { ICON_NAMES } from '@chalk-format/model';
export { openStreamedBook, isStreamed, windowAround, type StreamedBook } from './stream.js';
export { useSavedLibraries } from './saved-libraries.js';
export type { Library, LibraryItem, LibraryConnection } from '@chalk-format/store';
