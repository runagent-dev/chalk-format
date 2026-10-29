import { C1_KEY_PATTERN, verifyAssetBytes, type Lesson, type LessonPage, type StreamAsset, type StreamIndex, type StreamPage, type StreamText, type TextRun } from '@chalk-format/model';
import type { MergeResult } from './merge.js';
import { setOwn, type PatchResult } from './patch.js';
import { assetStorageKey } from './pack.js';
import { drawnAssetIds, hex8, pageAssetIds, pageText, parseStreamIndex } from './stream.js';

const enc = new TextEncoder();
const json = (v: unknown) => enc.encode(JSON.stringify(v));
const sha256hex = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer))].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * A file whose NAME says what is in it (`assets/c1_<digest>`, `assets/sha256_<hex>`) must hold exactly that: such a file is kept for good and
 * cached, so it has to be right when it is first written, whatever id led to the name. Throws on the first that is not.
 */
export async function assertContentNamedFiles(files: ReadonlyMap<string, Uint8Array>): Promise<void> {
  for (const [rel, bytes] of files) {
    const sha = /^assets\/sha256_([0-9a-f]{64})$/.exec(rel);
    if (sha && (await sha256hex(bytes)) !== sha[1]) throw new Error(`${rel} does not hold the bytes its name says`);
    const c1 = /^assets\/c1_([a-z2-7]{25}[aeimquy4])$/.exec(rel);
    if (c1 && !(await verifyAssetBytes(`c1:${c1[1]}`, bytes))) throw new Error(`${rel} does not hold the bytes its name says`);
  }
}

export type AppliedPatch = {
  /** Page files, the search text and the media, by path: to be written FIRST (new names, nothing here replaces a file a reader can be using). */
  files: Map<string, Uint8Array>;
  /** The new `book.json`: to be written LAST (it is what makes the new version exist). */
  indexBytes: Uint8Array;
  index: StreamIndex;
  result: PatchResult;
};

const counterOf = (file: string) => Number(/^(?:pages|snips)\/(\d+)-/.exec(file)?.[1] ?? 0);

/**
 * Turns a merge into files. Pure: it reads nothing and writes nothing. `current` is the book as the host has it (its index, and its search text
 * when it has one); `media` the bytes of the assets added by the patch. New and rewritten pages are named `pages/<k>-<hex8>.json` with `k` one more
 * than the largest in the index, so pages that only moved keep their names (and are not rewritten); the search text is rewritten only when a page's
 * text really changed; assets no page uses any more leave the index (the host's prune removes their files later). The host writes `files`, then
 * `indexBytes`, under its own lock.
 */
export async function applyStreamPatch(
  current: { index: StreamIndex; text?: StreamText | null },
  merge: MergeResult,
  media: ReadonlyMap<string, { type: string; bytes: Uint8Array }> = new Map(),
  o: { now?: string; external?: ReadonlyMap<string, { type: string; size?: number }> } = {},
): Promise<AppliedPatch> {
  const idx = current.index;
  const carriedAlready = new Set(idx.assets.filter((a) => a.path).map((a) => a.id));
  // media the index already carries (a replayed patch): verified like any, but not written or listed again
  const newMedia = new Map([...media].filter(([id]) => !carriedAlready.has(id)));
  if (merge.noop && !newMedia.size) {
    const bytes = json(idx);
    return { files: new Map(), indexBytes: bytes, index: idx, result: { version: `sha256:${await sha256hex(bytes)}`, pages: {}, report: merge.report, unchanged: true } };
  }

  const files = new Map<string, Uint8Array>();
  // media: the bytes must be what their id says (an id that names no content is taken as given)
  for (const [id, m] of media) {
    if (C1_KEY_PATTERN.test(id) || /^sha256:[0-9a-f]{64}$/.test(id)) if (!(await verifyAssetBytes(id, m.bytes))) throw new Error(`the media ${id} does not match its key`);
    if (newMedia.has(id)) files.set(assetStorageKey(id), m.bytes);
  }

  const old = new Map([...idx.pages, ...(idx.snipPages ?? [])].map((e) => [e.id, e]));
  const snipIds = new Set(merge.snipOrder);
  let k = Math.max(0, ...[...old.values()].map((e) => counterOf(e.file)));
  const sizes = new Map<string, number>();
  for (const a of idx.assets) if (a.size !== undefined) sizes.set(a.id, a.size);
  for (const [id, m] of media) sizes.set(id, m.bytes.byteLength);
  const carried = new Set([...carriedAlready, ...media.keys()]);

  const shell = { id: idx.id, title: merge.title, locale: idx.locale, createdAt: idx.createdAt, updatedAt: idx.updatedAt, pages: [], snipPages: [] } as unknown as Lesson;
  const written = new Map<string, StreamPage>();
  const resultPages: PatchResult['pages'] = {};
  for (const [id, page] of merge.write) {
    const bytes = json(page);
    const hash = await hex8(bytes);
    const was = old.get(id);
    let file: string;
    if (was && was.file.endsWith(`-${hash}.json`)) file = was.file; // the same bytes the host already has under that name
    else { file = `${snipIds.has(id) ? 'snips' : 'pages'}/${++k}-${hash}.json`; files.set(file, bytes); }
    const bg = page.background as Record<string, unknown>;
    const thumb = bg.type === 'pdf_page' && typeof bg.thumbnailAssetId === 'string' && carried.has(bg.thumbnailAssetId) ? bg.thumbnailAssetId : undefined;
    const label = was?.label;
    written.set(id, {
      ...(was ?? {}), id, file, title: page.title, bytes: bytes.byteLength,
      ...(label ? { label } : {}),
      ...(page.width ? { width: page.width } : {}), ...(page.height ? { height: page.height } : {}),
      ...(thumb ? { thumb } : {}),
      assets: pageAssetIds(shell, page),
      assetBytes: [...new Set(drawnAssetIds(page))].reduce((s, a) => s + (sizes.get(a) ?? 0), 0),
    });
    if (!thumb && was && 'thumb' in was) delete (written.get(id) as { thumb?: unknown }).thumb;
    setOwn(resultPages, id, { file, hash, ...(merge.merged.includes(id) ? { page } : {}) });
  }
  const entryOf = (id: string): StreamPage => {
    const e = written.get(id) ?? old.get(id);
    if (!e) throw new Error(`the merged order names page ${id}, which is neither in the book nor in the patch`);
    return e;
  };
  const pages = merge.order.map(entryOf);
  const snipPages = merge.snipOrder.map(entryOf);

  // the assets: what the book had, plus the media, plus references to assets no one carries yet (external); minus what no page uses any more
  let assets: StreamAsset[] = [...idx.assets];
  const have = new Set(assets.map((a) => a.id));
  for (const [id, m] of newMedia) {
    const at = assets.findIndex((a) => a.id === id);
    const entry = { ...(at >= 0 ? assets[at]! : {}), id, type: at >= 0 && assets[at]!.type !== 'application/octet-stream' ? assets[at]!.type : m.type, size: m.bytes.byteLength, path: assetStorageKey(id) } as StreamAsset;
    if (at >= 0) assets[at] = entry; else { assets.push(entry); have.add(id); } // an entry that was external (no bytes) takes the bytes now supplied
  }
  const allEntries = [...pages, ...snipPages];
  const known = allEntries.every((e) => Array.isArray(e.assets));
  const used = new Set<string>(merge.coverAssetId ? [merge.coverAssetId] : []);
  for (const e of allEntries) for (const id of e.assets ?? []) used.add(id);
  for (const id of used) {
    if (have.has(id)) continue;
    const ext = o.external?.get(id);
    assets.push({ id, type: ext?.type ?? 'application/octet-stream', ...(ext?.size !== undefined ? { size: ext.size } : {}) });
    have.add(id);
  }
  if (known) {
    const keep = new Set(used);
    for (const a of assets) if (keep.has(a.id)) for (const r of a.renditions ?? []) keep.add(r.id); // other versions of a used picture stay with it
    assets = assets.filter((a) => keep.has(a.id));
  }

  // the search text: one file, rewritten only when some page's text changed
  let text: StreamIndex['text'] = idx.text;
  if (merge.textChanged.length) {
    const next: Record<string, TextRun[]> = { ...(current.text?.pages ?? {}) };
    for (const id of merge.textChanged) {
      const page: LessonPage | undefined = merge.write.get(id);
      const runs = page ? pageText(page) : [];
      if (runs.length) setOwn(next, id, runs); else delete next[id];
    }
    const before = JSON.stringify(current.text?.pages ?? {});
    if (JSON.stringify(next) !== before) {
      if (Object.keys(next).length) {
        const bytes = json({ v: 1, pages: next } satisfies StreamText);
        const file = `text-${await hex8(bytes)}.json`;
        files.set(file, bytes);
        text = { file, bytes: bytes.byteLength };
      } else text = undefined;
    }
  }

  const rest: Record<string, unknown> = { ...idx };
  for (const k of ['text', 'coverAssetId', 'snipPages']) delete rest[k]; // set again below, or left out when empty
  const index = parseStreamIndex({
    ...rest, title: merge.title, updatedAt: o.now ?? new Date().toISOString(),
    ...(merge.coverAssetId ? { coverAssetId: merge.coverAssetId } : {}),
    pages, ...(snipPages.length ? { snipPages } : {}), assets, ...(text ? { text } : {}),
  });
  await assertContentNamedFiles(files);
  const indexBytes = json(index);
  const kept = new Set(index.assets.map((a) => a.id));
  const dropped = idx.assets.map((a) => a.id).filter((id) => !kept.has(id));
  const mergedUse = new Set(merge.merged.flatMap((id) => written.get(id)?.assets ?? []));
  const lookup = index.assets.filter((a) => a.path && mergedUse.has(a.id)).map((a) => ({ id: a.id, type: a.type, ...(a.size !== undefined ? { size: a.size } : {}), path: a.path! }));
  return {
    files, indexBytes, index,
    result: { version: `sha256:${await sha256hex(indexBytes)}`, pages: resultPages, report: merge.report, ...(dropped.length ? { dropped } : {}), ...(lookup.length ? { assets: lookup } : {}) },
  };
}
