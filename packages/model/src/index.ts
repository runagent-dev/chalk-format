export * from './lesson.js';
export * from './helpers.js';
export * from './hash.js';
export * from './keys.js';
export * from './stores.js';
export {
  sniffMediaType,
  mediaKindOf,
  isImageType,
  IMAGE_TYPES,
  VIDEO_TYPES,
  AUDIO_TYPES,
  MODEL_TYPES,
  LAB_ENTRY_TYPE,
  isLabEntryBytes,
  type MediaType,
  type MediaKind,
  type ImageType,
  type VideoType,
  type AudioType,
  type ModelType,
} from './media-type.js';
export * from './object-transform.js';
// Schema functions/constants only. The model *types* come via lesson.js
// (which re-exports them from schema.js), so we deliberately do not
// `export *` from schema.js to avoid duplicate type exports.
export {
  CHALK_FORMAT_VERSION,
  LAB_PLUGIN_ID,
  LAB_PARAMS_MAX_BYTES,
  PLUGIN_ID_PATTERN,
  labSchema,
  isLabObject,
  lessonSchema,
  lessonPageSchema,
  lessonObjectSchema,
  pageBackgroundSchema,
  textRunSchema,
  parseLesson,
  safeParseLesson,
  validateLessonModel,
  type LessonValidation,
} from './schema.js';
export { migrateToLatest, MIGRATIONS, type Migration } from './migrate.js';
export {
  referencedAssetIds,
  overlayReferencedAssetIds,
  pageRenderAssetIds,
  pageThumbnailAssetIds,
} from './assets.js';
export {
  composeOverlay,
  diffLesson,
  parseOverlay,
  overlaySchema,
  pageEditSchema,
  overlayBaseRefSchema,
  type Overlay,
  type PageEdit,
  type OverlayBaseRef,
} from './overlay.js';
export * from './presentation.js';
export * from './stream.js';
