export type LessonObjectBase = {
  id: string;
  x: number;
  y: number;
};

export type RectObject = LessonObjectBase & {
  type: 'rect';
  width: number;
  height: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
};

export type InkObject = LessonObjectBase & {
  type: 'ink';
  points: number[];
  color: string;
  size: number;
};

export type TextObject = LessonObjectBase & {
  type: 'text';
  text: string;
  fontSize: number;
  fill: string;
};

export type LessonObject = RectObject | InkObject | TextObject;

export type PageBackground =
  | { type: 'blank' }
  | { type: 'color'; color: string }
  | { type: 'pdf_page'; assetId: string; pageNumber: number; renderedImageAssetId?: string };

export type LessonPage = {
  id: string;
  title: string;
  background: PageBackground;
  objects: LessonObject[];
  /**
   * Logical page size. Every object coordinate lives in this space;
   * the renderer maps it onto the physical stage with one transform,
   * so annotations stay glued to the background across window sizes.
   * Optional for lessons saved before the field existed — use
   * `getPageSize` instead of reading these directly.
   */
  width?: number;
  height?: number;
};

/** Default logical board size (16:9) for pages without explicit dims. */
export const DEFAULT_PAGE_WIDTH = 1600;
export const DEFAULT_PAGE_HEIGHT = 900;

export function getPageSize(page: LessonPage): { width: number; height: number } {
  return {
    width: page.width ?? DEFAULT_PAGE_WIDTH,
    height: page.height ?? DEFAULT_PAGE_HEIGHT,
  };
}

export type Lesson = {
  id: string;
  title: string;
  locale: string;
  pages: LessonPage[];
  createdAt: string;
  updatedAt: string;
};
