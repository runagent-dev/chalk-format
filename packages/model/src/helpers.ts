import type { Lesson, LessonObject, LessonPage, PageBackground } from './lesson.js';

let counter = 0;

export function generateId(prefix = 'id'): string {
  return `${prefix}_${Date.now().toString(36)}_${(counter++).toString(36)}`;
}

export function createLesson(title = 'Untitled Lesson'): Lesson {
  const now = new Date().toISOString();
  const firstPage: LessonPage = {
    id: generateId('page'),
    title: 'Page 1',
    background: { type: 'blank' },
    objects: [],
  };
  return {
    id: generateId('lesson'),
    title,
    locale: 'en',
    pages: [firstPage],
    createdAt: now,
    updatedAt: now,
  };
}

export type NewPageInput = {
  id?: string;
  title?: string;
  background?: PageBackground;
  objects?: LessonObject[];
};

export function addPage(lesson: Lesson, input: NewPageInput = {}): Lesson {
  const newPage: LessonPage = {
    id: input.id ?? generateId('page'),
    title: input.title ?? `Page ${lesson.pages.length + 1}`,
    background: input.background ?? { type: 'blank' },
    objects: input.objects ?? [],
  };
  return {
    ...lesson,
    pages: [...lesson.pages, newPage],
    updatedAt: new Date().toISOString(),
  };
}

export function addObject(lesson: Lesson, pageId: string, object: LessonObject): Lesson {
  return {
    ...lesson,
    pages: lesson.pages.map((p) =>
      p.id === pageId ? { ...p, objects: [...p.objects, object] } : p,
    ),
    updatedAt: new Date().toISOString(),
  };
}

export function updateObject(
  lesson: Lesson,
  pageId: string,
  objectId: string,
  object: LessonObject,
): Lesson {
  return {
    ...lesson,
    pages: lesson.pages.map((p) =>
      p.id === pageId
        ? { ...p, objects: p.objects.map((o) => (o.id === objectId ? object : o)) }
        : p,
    ),
    updatedAt: new Date().toISOString(),
  };
}

export function removeObject(lesson: Lesson, pageId: string, objectId: string): Lesson {
  return {
    ...lesson,
    pages: lesson.pages.map((p) =>
      p.id === pageId ? { ...p, objects: p.objects.filter((o) => o.id !== objectId) } : p,
    ),
    updatedAt: new Date().toISOString(),
  };
}
