import type { HiddenArea, LessonPage, TextRun } from './schema.js';

/** True when the run's centre lies inside one of the areas (spec 1.9 §2). */
export function runIsHidden(run: TextRun, areas: readonly HiddenArea[]): boolean {
  const cx = run.x + run.width / 2, cy = run.y + run.fontSize / 2;
  return areas.some((a) => cx >= a.x && cx <= a.x + a.width && cy >= a.y && cy <= a.y + a.height);
}

/** The page's text layer without the runs its hidden areas cover: what selection and search see. */
export function visibleTextLayer(page: Pick<LessonPage, 'textLayer' | 'hidden'>): TextRun[] {
  const runs = page.textLayer ?? [];
  const areas = page.hidden ?? [];
  return areas.length ? runs.filter((r) => !runIsHidden(r, areas)) : [...runs];
}

const DIGITS: Record<string, string> = { bn: '০১২৩৪৫৬৭৮৯', as: '০১২৩৪৫৬৭৮৯', hi: '०१२३४५६७८९', ar: '٠١٢٣٤٥٦٧٨٩', fa: '۰۱۲۳۴۵۶۷۸۹' };

/** `n` in the digits of the book's language (Bengali digits for a `bn` book), Western digits otherwise. */
export function localDigits(locale: string, n: number): string {
  const d = DIGITS[locale.toLowerCase().split(/[-_]/)[0] ?? ''];
  const s = String(n);
  return d ? s.replace(/[0-9]/g, (c) => d[Number(c)]!) : s;
}

/**
 * The number a page shows (spec 1.9 §3): its label when the book gives one, else its position counted
 * from 1 in the book's digits. Computed from the position, so adding or removing a page renumbers the
 * pages after it.
 */
export function pageNumberText(index: number, locale: string, label?: string): string {
  return label ?? localDigits(locale, index + 1);
}
