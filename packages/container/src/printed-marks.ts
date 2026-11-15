import type { HiddenArea, LessonPage, PageNumberSlot, TextRun } from '@chalk-format/model';

/**
 * Finding a scanned book's printed marks (spec 1.9): its page numbers and the lines a printer adds (a forme
 * line, an edition year), so the book can hide them and write its own numbers. The text layer says where
 * a mark is roughly; the page picture gives the exact box and the paper's colour around it.
 */

/** An RGBA picture of the page background, any resolution (scaled to page units by width). */
export type PagePixels = { width: number; height: number; data: Uint8ClampedArray | Uint8Array };

export type PrintedMarkOptions = {
  /** Hide printed page numbers and keep their place as the page's number slot (default true). */
  numbers?: boolean;
  /** Other runs to hide when they are in the margins: a forme line (`^ফর্মা`), an edition year. */
  patterns?: readonly RegExp[];
  /** Hide digits printed sideways in the margins (an edition year down the edge, however it was extracted). */
  sideways?: boolean;
  /** How far in from the top and bottom edge a mark may be, as a fraction of the page height (default 0.11). */
  band?: number;
};

export type PrintedMarks = { hidden: HiddenArea[]; numberSlot?: PageNumberSlot; found: { text: string; kind: 'number' | 'sideways' | 'pattern' }[] };

// a page number; extraction sometimes splits one with a hyphen ("৮-৩" for ৮৩)
const NUMBER = /^[0-9০-৯]{1,4}$|^[0-9০-৯]{1,2}[-‐][0-9০-৯]{1,2}$/u;

/** Where the marks of one page are, or nothing to change. */
export function findPrintedMarks(page: LessonPage, pixels: PagePixels, o: PrintedMarkOptions = {}): PrintedMarks {
  const W = page.width ?? pixels.width, H = page.height ?? pixels.height, band = (o.band ?? 0.11) * H;
  const inMargin = (r: TextRun) => r.y < band || r.y + r.fontSize > H - band;
  const s = pixels.width / W;
  const out: PrintedMarks = { hidden: [], found: [] };
  for (const r of page.textLayer ?? []) {
    if (!inMargin(r)) continue;
    const text = r.text.trim();
    const turned = sideways(r, text);
    const isNumber = (o.numbers ?? true) && NUMBER.test(text) && !turned;
    const isSideways = !isNumber && !!o.sideways && turned && /^[0-9০-৯]+$/u.test(text);
    const isPattern = !isNumber && !isSideways && (o.patterns ?? []).some((p) => p.test(text));
    if (!isNumber && !isSideways && !isPattern) continue;
    const box = inkBox(pixels, s, r, turned);
    if (!box) continue;
    out.hidden.push(box.area);
    out.found.push({ text, kind: isNumber ? 'number' : isSideways ? 'sideways' : 'pattern' });
    if (isNumber && !out.numberSlot) {
      const mid = r.x + r.width / 2;
      const align = Math.abs(mid - W / 2) < W * 0.08 ? 'center' : mid < W / 2 ? 'start' : 'end';
      const x = align === 'start' ? box.ink.x : align === 'end' ? box.ink.x + box.ink.width : box.ink.x + box.ink.width / 2;
      // digits stand on the baseline and rise about 0.62 em above it (Noto Sans Bengali, the reader's font)
      out.numberSlot = { x: round(x), y: round(box.ink.y + box.ink.height), fontSize: round(box.ink.height / 0.62), align, color: box.ink.color };
    }
  }
  return out;
}

// Text turned on its side (an edition year down the margin) is recorded narrower than its characters
// could be side by side: a level run is about one font size wide per two characters or more.
function sideways(r: TextRun, text: string): boolean { return r.width < r.fontSize * 0.5 * [...text].length; }

const round = (n: number) => Math.round(n * 10) / 10;

type Ink = { x: number; y: number; width: number; height: number; color: string };

/**
 * The mark's exact box: inside a window around the run, the paper colour is the commonest colour and the
 * ink is every pixel far from it. The area covers the ink with a small margin and takes the paper colour.
 */
function inkBox(px: PagePixels, s: number, r: TextRun, vertical: boolean): { area: HiddenArea; ink: Ink } | null {
  const padX = vertical ? r.fontSize * 0.25 : r.fontSize * 0.8, padTop = r.fontSize * 0.8, padBottom = r.fontSize * 1.2;
  const x0 = clamp(Math.floor((r.x - padX) * s), 0, px.width - 1), x1 = clamp(Math.ceil((r.x + r.width + padX) * s), 0, px.width - 1);
  const y0 = clamp(Math.floor((r.y - padTop) * s), 0, px.height - 1), y1 = clamp(Math.ceil((r.y + r.fontSize + padBottom) * s), 0, px.height - 1);
  if (x1 <= x0 || y1 <= y0) return null;
  const at = (x: number, y: number) => { const i = (y * px.width + x) * 4; return [px.data[i]!, px.data[i + 1]!, px.data[i + 2]!] as const; };
  // the paper: the commonest colour in the window, in steps of 8 so scanning noise falls together
  const counts = new Map<number, number>();
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const [R, G, B] = at(x, y); const k = ((R >> 3) << 10) | ((G >> 3) << 5) | (B >> 3); counts.set(k, (counts.get(k) ?? 0) + 1); }
  let key = 0, most = -1; for (const [k, n] of counts) if (n > most) { most = n; key = k; }
  let pr = 0, pg = 0, pb = 0, pn = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const [R, G, B] = at(x, y); if ((((R >> 3) << 10) | ((G >> 3) << 5) | (B >> 3)) === key) { pr += R; pg += G; pb += B; pn++; } }
  const paper = [pr / pn, pg / pn, pb / pn];
  // the ink: far from the paper; its darkest quarter gives the colour the number is printed in
  let ix0 = Infinity, iy0 = Infinity, ix1 = -1, iy1 = -1; const inks: [number, number, number, number][] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const [R, G, B] = at(x, y); const d = Math.abs(R - paper[0]!) + Math.abs(G - paper[1]!) + Math.abs(B - paper[2]!);
    if (d < 90) continue;
    ix0 = Math.min(ix0, x); iy0 = Math.min(iy0, y); ix1 = Math.max(ix1, x); iy1 = Math.max(iy1, y); inks.push([d, R, G, B]);
  }
  if (ix1 < 0) return null;
  inks.sort((a, b) => b[0] - a[0]);
  const dark = inks.slice(0, Math.max(1, Math.floor(inks.length / 4)));
  const avg = (k: 1 | 2 | 3) => Math.round(dark.reduce((t, v) => t + v[k], 0) / dark.length);
  const pad = 3 * s;
  const ink: Ink = { x: ix0 / s, y: iy0 / s, width: (ix1 - ix0 + 1) / s, height: (iy1 - iy0 + 1) / s, color: hex(avg(1), avg(2), avg(3)) };
  const area: HiddenArea = {
    x: round(Math.max(0, ix0 - pad) / s), y: round(Math.max(0, iy0 - pad) / s),
    width: round((ix1 - ix0 + 1 + 2 * pad) / s), height: round((iy1 - iy0 + 1 + 2 * pad) / s),
    fill: hex(Math.round(paper[0]!), Math.round(paper[1]!), Math.round(paper[2]!)),
  };
  return { area, ink };
}

const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n));
const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
