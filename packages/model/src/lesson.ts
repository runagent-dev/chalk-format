// The lesson/document model types are inferred from the single Zod
// schema in schema.ts (the source of truth) and re-exported here so the
// public import surface (`@chalk-format/model`) is unchanged. This file adds
// the page-size helpers that aren't part of the serialized shape.
export type {
  RectObject,
  InkObject,
  TextObject,
  ImageObject,
  EllipseObject,
  LineObject,
  ArrowObject,
  VectorObject,
  EmbedObject,
  EmbedKind,
  SnipObject,
  MediaDisplayMode,
  LessonObject,
  PageBackground,
  TextRun,
  LessonPage,
  Lesson,
} from './schema.js';
import type { LessonPage } from './schema.js';

/** The fields every lesson object shares. */
export type LessonObjectBase = {
  id: string;
  x: number;
  y: number;
};

/** Default logical board size (16:9) for pages without explicit dims. */
export const DEFAULT_PAGE_WIDTH = 1600;
export const DEFAULT_PAGE_HEIGHT = 900;

/**
 * Logical page size. Every object coordinate lives in this space; the
 * renderer maps it onto the physical stage with one transform, so
 * annotations stay glued to the background across window sizes. `width`
 * and `height` are optional on the model for pages saved before the
 * field existed — read them through this helper, not directly.
 */
export function getPageSize(page: LessonPage): { width: number; height: number } {
  return {
    width: page.width ?? DEFAULT_PAGE_WIDTH,
    height: page.height ?? DEFAULT_PAGE_HEIGHT,
  };
}
