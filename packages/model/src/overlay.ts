import { z } from 'zod';
import {
  lessonObjectSchema,
  lessonPageSchema,
  pageBackgroundSchema,
  type Lesson,
  type LessonObject,
  type LessonPage,
} from './schema.js';

/**
 * The additive overlay format (see the Phase 2 design doc).
 *
 * An overlay is the *delta* from a read-only **base** lesson to a user's
 * **edited** copy. `composeOverlay(base, overlay)` reconstructs the edited
 * lesson; `diffLesson(base, edited)` produces the overlay. The two are
 * inverse — `compose(base, diff(base, edited))` deep-equals `edited` — so a
 * tiny overlay (mostly the annotations a user adds) can stand in for a full
 * duplicate of a large book.
 *
 * Design notes:
 * - Objects and pages are keyed by their stable `id`, so an added annotation
 *   is a new-id `upsert` (never touches base objects) — that's what keeps
 *   overlays small and merges mostly conflict-free.
 * - `objectOrder`/`pageOrder` are recorded only when order actually changes,
 *   so pure-additive edits stay minimal while reorders still round-trip.
 * - `textLayer` is treated as base-owned (users don't edit it); it is carried
 *   through from the base unchanged.
 */

/** Points at the immutable base a copy was forked from. */
export const overlayBaseRefSchema = z.object({
  id: z.string(),
  version: z.number(),
  /** Content hash of the base, for integrity / rebase detection. */
  hash: z.string().optional(),
});

/** Per-base-page delta. Absent fields mean "unchanged from base". */
export const pageEditSchema = z.object({
  /** Wipe all base objects before applying upserts. */
  cleared: z.boolean().optional(),
  /** Base object ids to drop (tombstones). Ignored when `cleared`. */
  removedObjectIds: z.array(z.string()).optional(),
  /** Objects to add (new id) or replace (existing base id). */
  upsertedObjects: z.array(lessonObjectSchema).optional(),
  /** Final object-id order — only set when it differs from the default. */
  objectOrder: z.array(z.string()).optional(),
  background: pageBackgroundSchema.optional(),
  title: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
});

export const overlaySchema = z.object({
  base: overlayBaseRefSchema,
  /** Edits to base pages, keyed by base page id. */
  pages: z.record(z.string(), pageEditSchema),
  /** Whole pages the user added (with their own ids). */
  newPages: z.array(lessonPageSchema),
  /** Final ordered page ids. Absent ⇒ base order followed by newPages. */
  pageOrder: z.array(z.string()).optional(),
  titleOverride: z.string().optional(),
  updatedAt: z.string(),
});

export type OverlayBaseRef = z.infer<typeof overlayBaseRefSchema>;
export type PageEdit = z.infer<typeof pageEditSchema>;
export type Overlay = z.infer<typeof overlaySchema>;

export function parseOverlay(data: unknown): Overlay {
  return overlaySchema.parse(data);
}

// ---------------------------------------------------------------------------
// Compose: base ⊕ overlay → edited lesson
// ---------------------------------------------------------------------------

/** Reconstruct the edited lesson by applying `overlay` on top of `base`. */
export function composeOverlay(base: Lesson, overlay: Overlay): Lesson {
  const basePageById = new Map(base.pages.map((p) => [p.id, p]));
  const newPageById = new Map(overlay.newPages.map((p) => [p.id, p]));
  const order = overlay.pageOrder ?? [
    ...base.pages.map((p) => p.id),
    ...overlay.newPages.map((p) => p.id),
  ];

  const pages: LessonPage[] = [];
  for (const pid of order) {
    const added = newPageById.get(pid);
    if (added) {
      pages.push(added);
      continue;
    }
    const bp = basePageById.get(pid);
    if (!bp) continue; // id refers to a removed/unknown page → dropped
    pages.push(applyPageEdit(bp, overlay.pages[pid]));
  }

  return {
    id: base.id,
    title: overlay.titleOverride ?? base.title,
    locale: base.locale,
    pages,
    // Region-snip satellite pages aren't part of the overlay model yet
    // (see packages/core/src/schema.ts's snipPages doc comment) — carry
    // the base's through unchanged rather than silently dropping them.
    snipPages: base.snipPages,
    createdAt: base.createdAt,
    updatedAt: overlay.updatedAt,
  };
}

function applyPageEdit(page: LessonPage, edit: PageEdit | undefined): LessonPage {
  if (!edit) return page;

  let objects: LessonObject[] = edit.cleared ? [] : page.objects;
  if (!edit.cleared && edit.removedObjectIds?.length) {
    const removed = new Set(edit.removedObjectIds);
    objects = objects.filter((o) => !removed.has(o.id));
  }
  if (edit.upsertedObjects?.length) {
    objects = [...objects];
    for (const obj of edit.upsertedObjects) {
      const i = objects.findIndex((o) => o.id === obj.id);
      if (i >= 0) objects[i] = obj;
      else objects.push(obj);
    }
  }
  if (edit.objectOrder) {
    const byId = new Map(objects.map((o) => [o.id, o]));
    objects = edit.objectOrder.map((id) => byId.get(id)).filter((o): o is LessonObject => !!o);
  }

  return {
    ...page,
    objects,
    ...(edit.background !== undefined ? { background: edit.background } : {}),
    ...(edit.title !== undefined ? { title: edit.title } : {}),
    ...(edit.width !== undefined ? { width: edit.width } : {}),
    ...(edit.height !== undefined ? { height: edit.height } : {}),
  };
}

// ---------------------------------------------------------------------------
// Diff: base + edited → overlay
// ---------------------------------------------------------------------------

/** Produce the overlay that turns `base` into `edited`. `baseRef` names the base. */
export function diffLesson(base: Lesson, edited: Lesson, baseRef: OverlayBaseRef): Overlay {
  const basePageById = new Map(base.pages.map((p) => [p.id, p]));

  const pages: Record<string, PageEdit> = {};
  const newPages: LessonPage[] = [];
  for (const ep of edited.pages) {
    const bp = basePageById.get(ep.id);
    if (!bp) {
      newPages.push(ep);
      continue;
    }
    const edit = diffPage(bp, ep);
    if (edit) pages[ep.id] = edit;
  }

  const overlay: Overlay = {
    base: baseRef,
    pages,
    newPages,
    updatedAt: edited.updatedAt,
  };

  // Record page order only when it differs from base-order + appended newPages.
  const defaultOrder = [...base.pages.map((p) => p.id), ...newPages.map((p) => p.id)];
  const editedOrder = edited.pages.map((p) => p.id);
  if (!arraysEqual(defaultOrder, editedOrder)) overlay.pageOrder = editedOrder;

  if (edited.title !== base.title) overlay.titleOverride = edited.title;
  return overlay;
}

function diffPage(bp: LessonPage, ep: LessonPage): PageEdit | undefined {
  const edit: PageEdit = {};

  if (ep.objects.length === 0 && bp.objects.length > 0) {
    edit.cleared = true;
  } else {
    const baseById = new Map(bp.objects.map((o) => [o.id, o]));
    const editedIds = new Set(ep.objects.map((o) => o.id));

    const removed = bp.objects.filter((o) => !editedIds.has(o.id)).map((o) => o.id);
    if (removed.length) edit.removedObjectIds = removed;

    const upserted = ep.objects.filter((o) => {
      const b = baseById.get(o.id);
      return !b || !deepEqual(o, b);
    });
    if (upserted.length) edit.upsertedObjects = upserted;

    // Object order: only if it differs from what compose would produce by
    // default (base minus removed, upserts replaced-in-place, new appended).
    const removedSet = new Set(removed);
    const defaultIds = bp.objects.map((o) => o.id).filter((id) => !removedSet.has(id));
    for (const o of upserted) if (!defaultIds.includes(o.id)) defaultIds.push(o.id);
    const editedIdOrder = ep.objects.map((o) => o.id);
    if (!arraysEqual(defaultIds, editedIdOrder)) edit.objectOrder = editedIdOrder;
  }

  if (!deepEqual(ep.background, bp.background)) edit.background = ep.background;
  if (ep.title !== bp.title) edit.title = ep.title;
  if (ep.width !== bp.width) edit.width = ep.width;
  if (ep.height !== bp.height) edit.height = ep.height;

  return Object.keys(edit).length > 0 ? edit : undefined;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Structural equality for JSON-like values (ignores object key order). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every((k) =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}
