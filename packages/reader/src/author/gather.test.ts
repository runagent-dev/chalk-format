import { packLesson, type AssetBundle } from '@chalk-format/container';
import { assetKey, parseLesson, referencedAssetIds, type Lesson } from '@chalk-format/model';
import { describe, expect, it } from 'vitest';
import { gatherAssets, type Gathered } from './gather.js';
import type { SaveProgress } from './save-run.js';

const png = (n: number) => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, n, n + 1, n + 2, 7, 7]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The way the book's assets were gathered before: one after the other, a failure or a missing asset left out. */
async function sequential(ids: readonly string[], held: (id: string) => Gathered | undefined, fetchOne: (id: string) => Promise<Gathered | null>) {
  const out = new Map<string, Gathered>();
  for (const id of ids) {
    const a = held(id);
    if (a) { out.set(id, a); continue; }
    const b = await fetchOne(id).catch(() => null);
    if (b) out.set(id, b);
  }
  return out;
}

async function book() {
  const keys: string[] = [];
  const store = new Map<string, Gathered>();
  for (let i = 0; i < 24; i++) {
    const bytes = png(i * 3);
    const id = await assetKey(bytes);
    keys.push(id);
    store.set(id, { type: 'image/png', bytes });
  }
  const lesson: Lesson = parseLesson({
    id: 'l', title: 'Golden', locale: 'en', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', snipPages: [],
    pages: keys.map((assetId, i) => ({ id: `p${i}`, title: '', width: 400, height: 300, background: { type: 'blank' }, objects: [{ id: `o${i}`, type: 'image', x: 0, y: 0, width: 100, height: 80, assetId }] })),
  });
  return { lesson, store, keys };
}

describe('gathering a book\'s assets for a save', () => {
  it('packs the very same bytes as the one-by-one way, whatever order the fetches finish in, with failures and held assets', async () => {
    const { lesson, store } = await book();
    const ids = referencedAssetIds(lesson);
    expect(ids.length).toBe(24);
    const held = (id: string) => (ids.indexOf(id) % 7 === 0 ? store.get(id) : undefined); // added in this session
    const gone = new Set([ids[3], ids[11]]); // not fetchable
    const fetchOne = async (id: string) => { await sleep((ids.indexOf(id) * 7) % 13); if (gone.has(id)) throw new Error('404'); return store.get(id) ?? null; };
    const before: AssetBundle = await sequential(ids, held, fetchOne);
    const after: AssetBundle = await gatherAssets({ ids, held, fetchOne });
    expect([...after.keys()]).toEqual([...before.keys()]); // the same assets in the same order
    const fixed = { ...lesson, updatedAt: '2026-02-02T00:00:00Z' };
    const a = await packLesson(fixed, before);
    const b = await packLesson(fixed, after);
    expect(Buffer.from(b).equals(Buffer.from(a))).toBe(true); // the golden check: the same file, byte for byte
  });

  it('fetches a few at a time, never more than asked, and tells how far it got', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `a${i}`);
    let running = 0, peak = 0;
    const seen: SaveProgress[] = [];
    await gatherAssets({
      ids, held: () => undefined, atOnce: 4, progress: (p) => seen.push(p),
      fetchOne: async (id) => { running++; peak = Math.max(peak, running); await sleep(3); running--; return { type: 'x', bytes: new Uint8Array([id.length]) }; },
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
    expect(seen[0]).toEqual({ phase: 'collecting', done: 0, total: 20 });
    expect(seen.at(-1)).toEqual({ phase: 'collecting', done: 20, total: 20 });
    expect(seen.map((p) => p.done)).toEqual([...Array(21).keys()]); // every asset counted once, in order
  });

  it('a book with nothing to gather is fine', async () => {
    const seen: SaveProgress[] = [];
    const out = await gatherAssets({ ids: [], held: () => undefined, fetchOne: async () => null, progress: (p) => seen.push(p) });
    expect(out.size).toBe(0);
    expect(seen).toEqual([{ phase: 'collecting', done: 0, total: 0 }]);
  });
});
