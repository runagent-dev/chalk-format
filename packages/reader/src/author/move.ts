import { MEDIA_ICON_SIZE, SNIP_ICON_SIZE, generateId, type LessonObject, type LessonPage } from '@chalk-format/model';
import { bounds, moved, type Point } from '../annotate/ops.js';

type Size = { width: number; height: number };

/** The box an object takes on the page as drawn: icon-mode media and snips are fixed-size markers. */
export function boxOf(o: LessonObject) {
  if (o.type === 'snip') return { x: o.x, y: o.y, width: SNIP_ICON_SIZE, height: SNIP_ICON_SIZE };
  if ((o.type === 'image' || o.type === 'embed') && o.displayMode === 'icon') return { x: o.x, y: o.y, width: MEDIA_ICON_SIZE, height: MEDIA_ICON_SIZE };
  return bounds(o);
}

/** How much of an object a drag must leave on the page, so that it can still be reached and picked up again. */
export const KEEP_ON_PAGE = 24;

/**
 * The object with its box's top left corner at `at` on a page of `page` size, held so that at least `keep` page units of it stay on the
 * page each way (what a drag does: it may hang over an edge, but never leave). Only the place changes; the object keeps its id and
 * everything else, whatever its kind (lines move both ends, drawings all their points).
 */
export function placeAt<T extends LessonObject>(o: T, at: Point, page: Size, keep = KEEP_ON_PAGE): T {
  const b = boxOf(o);
  const x = Math.min(Math.max(at.x, keep - b.width), page.width - keep);
  const y = Math.min(Math.max(at.y, keep - b.height), page.height - keep);
  return moved(o, Math.round(x) - b.x, Math.round(y) - b.y);
}

/**
 * The object as it goes to another page by "Move to page": at the same place relative to the page (a page of another size scales the
 * place, not the object), then pulled fully inside the page where it fits (an object bigger than the page starts at its top left).
 */
export function relocate<T extends LessonObject>(o: T, from: Size, to: Size): T {
  const b = boxOf(o);
  const fx = from.width > 0 ? to.width / from.width : 1, fy = from.height > 0 ? to.height / from.height : 1;
  const x = Math.max(0, Math.min(b.x * fx, to.width - b.width));
  const y = Math.max(0, Math.min(b.y * fy, to.height - b.height));
  return moved(o, Math.round(x) - b.x, Math.round(y) - b.y);
}

/**
 * The object as it can land on `page`: as it is when its id is free there (the usual case: ids are random), else with a new id, because an
 * id is unique only within its page (spec 1.0) and two objects on one page must not share one.
 */
export function freeIdOn<T extends LessonObject>(page: Pick<LessonPage, 'objects'> | undefined, o: T): T {
  return page?.objects.some((x) => x.id === o.id) ? { ...o, id: generateId(o.type) } : o;
}
