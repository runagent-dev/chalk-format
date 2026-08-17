import { nanoid } from 'nanoid';
import type { Lesson, LessonObject, LessonPage, PageBackground } from './lesson.js';

/**
 * Ids are the overlay merge key, so they must be unique across clients, not
 * just within one session. nanoid seeds from `crypto.getRandomValues`, which
 * (unlike `crypto.randomUUID`) also works on the plain-HTTP LAN a self-hosted
 * classroom board runs on.
 */
export function generateId(prefix = 'id'): string {
  return `${prefix}_${nanoid()}`;
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
