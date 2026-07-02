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
};

export type Lesson = {
  id: string;
  title: string;
  locale: string;
  pages: LessonPage[];
  createdAt: string;
  updatedAt: string;
};
