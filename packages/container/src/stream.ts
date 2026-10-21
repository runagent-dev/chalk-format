import {
  CHALK_FORMAT_VERSION, STREAM_VERSION, migrateToLatest, parseLesson, referencedAssetIds, streamIndexSchema, streamTextSchema,
  type AssetInfo, type Lesson, type LessonPage, type StoreDescriptor, type StreamAsset, type StreamIndex, type StreamPage, type StreamText, type TextRun,
} from '@chalk-format/model';
import type { AssetBundle } from './pack.js';
import { assetStorageKey } from './pack.js';

/**
 * Streamed books (spec 1.4): a book as separate files, so a reader shows it from a small index and fetches only
 * the pages near the one being read. `publishStreamed` turns a book into those files; `assembleStreamed` reads
 * them back into a lesson and its assets (lossless both ways).
 */

const enc = new TextEncoder();
const hex8 = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer))].slice(0, 4).map((b) => b.toString(16).padStart(2, '0')).join('');
const json = (v: unknown) => enc.encode(JSON.stringify(v));

/** The asset ids one page uses. */
export function pageAssetIds(lesson: Lesson, page: LessonPage): string[] {
  return referencedAssetIds({ ...lesson, pages: [page], snipPages: [], coverAssetId: undefined } as Lesson);
}

/** What has to be fetched to draw a page (its background picture and the pictures on it), not media a tap starts. */
function drawnAssetIds(page: LessonPage): string[] {
  const bg = page.background as Record<string, unknown>;
  const ids = [bg.type === 'pdf_page' ? (bg.renderedImageAssetId ?? bg.assetId) : bg.assetId];
  for (const o of page.objects) {
    if (o.type === 'image') ids.push(o.assetId);
    if (o.type === 'embed' && o.poster) ids.push(o.poster);
  }
  return ids.filter((x): x is string => typeof x === 'string');
}

/** A page's searchable text as runs (spec 1.4 §4): its text layer and its text objects. */
export function pageText(page: LessonPage): TextRun[] {
  const runs: TextRun[] = [...(page.textLayer ?? [])];
  for (const o of page.objects) {
    if (o.type !== 'text') continue;
    o.text.split('\n').forEach((t, i) => { if (t.trim()) runs.push({ text: t, x: o.x, y: o.y + i * o.fontSize * 1.2, width: t.length * o.fontSize * 0.55, fontSize: o.fontSize }); });
  }
  return runs;
}

export type PublishOptions = {
  /** Facts about assets the book does not carry (type, size, meta), e.g. `unpackLesson(...).assetInfo`. */
  assetInfo?: ReadonlyMap<string, AssetInfo & { type?: string }>;
  /** Suggested stores for external assets (spec 1.2 §4.4). */
  assetSources?: StoreDescriptor[];
  /** Printed page numbers or names, by page id. */
  labels?: ReadonlyMap<string, string>;
};

/** The files of a streamed book: path → bytes, `book.json` among them. */
export async function publishStreamed(lesson: Lesson, assets: AssetBundle = new Map(), o: PublishOptions = {}): Promise<{ index: StreamIndex; files: Map<string, Uint8Array> }> {
  const files = new Map<string, Uint8Array>();
  const used = new Set(referencedAssetIds(lesson));
  const entries: StreamAsset[] = [];
  const sizeOf = new Map<string, number>();
  for (const id of used) {
    const a = assets.get(id), info = o.assetInfo?.get(id);
    if (a) {
      const path = assetStorageKey(id);   // already under assets/
      files.set(path, a.bytes);
      sizeOf.set(id, a.bytes.byteLength);
      entries.push({ id, type: a.type, size: a.bytes.byteLength, path, ...(info?.meta ? { meta: info.meta } : {}), ...(info?.renditions?.length ? { renditions: info.renditions } : {}) });
    } else {
      if (info?.size !== undefined) sizeOf.set(id, info.size);
      entries.push({ id, type: info?.type ?? 'application/octet-stream', ...(info?.size !== undefined ? { size: info.size } : {}), ...(info?.meta ? { meta: info.meta } : {}), ...(info?.renditions?.length ? { renditions: info.renditions } : {}) });
    }
  }

  const pageEntry = async (page: LessonPage, n: number, dir: string): Promise<StreamPage> => {
    const bytes = json(page);
    const file = `${dir}/${n}-${await hex8(bytes)}.json`;
    files.set(file, bytes);
    const bg = page.background as Record<string, unknown>;
    const thumb = bg.type === 'pdf_page' && typeof bg.thumbnailAssetId === 'string' ? bg.thumbnailAssetId : undefined;
    const label = o.labels?.get(page.id);
    return {
      id: page.id, file, title: page.title, bytes: bytes.byteLength,
      ...(label ? { label } : {}),
      ...(page.width ? { width: page.width } : {}), ...(page.height ? { height: page.height } : {}),
      ...(thumb && assets.has(thumb) ? { thumb } : {}),
      assets: pageAssetIds(lesson, page),
      assetBytes: [...new Set(drawnAssetIds(page))].reduce((s, id) => s + (sizeOf.get(id) ?? 0), 0),
    };
  };
  const pages = await Promise.all(lesson.pages.map((p, i) => pageEntry(p, i + 1, 'pages')));
  const snipPages = await Promise.all(lesson.snipPages.map((p, i) => pageEntry(p, i + 1, 'snips')));

  const text: StreamText = { v: 1, pages: Object.fromEntries(lesson.pages.map((p) => [p.id, pageText(p)]).filter(([, r]) => (r as TextRun[]).length)) };
  let textEntry: StreamIndex['text'];
  if (Object.keys(text.pages).length) {
    const bytes = json(text);
    const file = `text-${await hex8(bytes)}.json`;
    files.set(file, bytes);
    textEntry = { file, bytes: bytes.byteLength };
  }

  const index: StreamIndex = {
    format: 'chalk.streamed', streamVersion: STREAM_VERSION, formatVersion: CHALK_FORMAT_VERSION,
    id: lesson.id, title: lesson.title, locale: lesson.locale, createdAt: lesson.createdAt, updatedAt: lesson.updatedAt,
    ...(lesson.coverAssetId ? { coverAssetId: lesson.coverAssetId } : {}),
    pages, ...(snipPages.length ? { snipPages } : {}), assets: entries,
    ...(textEntry ? { text: textEntry } : {}),
    ...(o.assetSources?.length ? { assetSources: o.assetSources } : {}),
  };
  files.set('book.json', json(index));
  return { index: streamIndexSchema.parse(index), files };
}

/** Read and check an index (spec 1.4 §3, §8). */
export function parseStreamIndex(raw: unknown): StreamIndex {
  const index = streamIndexSchema.parse(raw);
  const ids = new Set<string>();
  for (const p of [...index.pages, ...(index.snipPages ?? [])]) {
    if (ids.has(p.id)) throw new Error(`page id ${p.id} appears twice in the index`);
    ids.add(p.id);
  }
  return index;
}
export const parseStreamText = (raw: unknown): StreamText => streamTextSchema.parse(raw);

/** Parse one page file of a streamed book, migrated to this version (spec 1.4 §5.6). */
export function parseStreamPage(index: StreamIndex, raw: unknown, snip = false): LessonPage {
  const lesson = parseLesson(migrateToLatest({
    id: index.id, title: index.title, locale: index.locale, createdAt: index.createdAt, updatedAt: index.updatedAt,
    pages: snip ? [] : [raw], snipPages: snip ? [raw] : [],
  }, index.formatVersion));
  return (snip ? lesson.snipPages[0] : lesson.pages[0])!;
}

/** A whole streamed book back as a lesson and the assets it carries (to pack it as a .chalk, or to check it). */
export async function assembleStreamed(read: (path: string) => Promise<Uint8Array>): Promise<{ lesson: Lesson; assets: AssetBundle; assetInfo: Map<string, AssetInfo & { type: string }>; index: StreamIndex }> {
  const dec = new TextDecoder();
  const index = parseStreamIndex(JSON.parse(dec.decode(await read('book.json'))));
  const page = async (p: StreamPage) => JSON.parse(dec.decode(await read(p.file))) as unknown;
  const lesson = parseLesson(migrateToLatest({
    id: index.id, title: index.title, locale: index.locale, createdAt: index.createdAt, updatedAt: index.updatedAt,
    ...(index.coverAssetId ? { coverAssetId: index.coverAssetId } : {}),
    pages: await Promise.all(index.pages.map(page)),
    snipPages: await Promise.all((index.snipPages ?? []).map(page)),
  }, index.formatVersion));
  const assets: AssetBundle = new Map();
  const assetInfo = new Map<string, AssetInfo & { type: string }>();
  for (const a of index.assets) {
    if (a.path) assets.set(a.id, { type: a.type, bytes: await read(a.path) });
    else assetInfo.set(a.id, { type: a.type, ...(a.size !== undefined ? { size: a.size } : {}), ...(a.meta ? { meta: a.meta } : {}), ...(a.renditions ? { renditions: a.renditions } : {}) });
  }
  return { lesson, assets, assetInfo, index };
}
