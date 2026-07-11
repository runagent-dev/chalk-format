export * from './lesson.js';
export * from './helpers.js';
export * from './hit-test.js';
export * from './hash.js';
// Schema functions/constants only. The model *types* come via lesson.js
// (which re-exports them from schema.js), so we deliberately do not
// `export *` from schema.js to avoid duplicate type exports.
export {
  CHALK_FORMAT_VERSION,
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
export { referencedAssetIds, overlayReferencedAssetIds } from './assets.js';
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
