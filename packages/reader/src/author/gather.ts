import type { SaveProgress } from './save-run.js';

/** How many assets are fetched at a time when a book is saved (the browser holds the rest back anyway; this keeps a few in flight). */
export const GATHER_AT_ONCE = 8;

export type Gathered = { type: string; bytes: Uint8Array };

/**
 * The assets of a book, in the order of `ids` (so the file packed from them is the same bytes whatever the fetches' timing): the ones at
 * hand (`held`) as they are, the rest fetched a few at a time (`fetchOne`; one that fails or is not there is left out, as before).
 * `progress` hears every asset that arrives.
 */
export async function gatherAssets(o: {
  ids: readonly string[];
  held: (id: string) => Gathered | undefined;
  fetchOne: (id: string) => Promise<Gathered | null>;
  progress?: ((p: SaveProgress) => void) | undefined;
  atOnce?: number;
}): Promise<Map<string, Gathered>> {
  const { ids } = o;
  const got: (Gathered | null)[] = new Array(ids.length).fill(null);
  let next = 0;
  let done = 0;
  o.progress?.({ phase: 'collecting', done, total: ids.length });
  const worker = async () => {
    while (next < ids.length) {
      const i = next++;
      const id = ids[i] as string;
      const have = o.held(id);
      got[i] = have ?? (await o.fetchOne(id).catch(() => null));
      o.progress?.({ phase: 'collecting', done: ++done, total: ids.length });
    }
  };
  await Promise.all(Array.from({ length: Math.min(o.atOnce ?? GATHER_AT_ONCE, ids.length) }, worker));
  const out = new Map<string, Gathered>();
  ids.forEach((id, i) => { const g = got[i]; if (g) out.set(id, g); });
  return out;
}
