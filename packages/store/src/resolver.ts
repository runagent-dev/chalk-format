import { indexShardSchema, resolutionKey, verifyAssetBytes, type IndexShard, type StoreDescriptor } from '@chalk-format/model';
import { apiUrl, derivedUrl, hashPart, matchesType, shardOf, shardUrl } from './urls.js';

/**
 * The reader's resolver (spec 1.2 §6): an asset id and its type in, bytes (or a URL to stream) out.
 * Cheap on a phone by construction:
 *   - the device cache first, by resolution key;
 *   - stores planned once per media type, tried one after another (never two at once for one asset);
 *   - a store that fails (network, 5xx) is skipped for a while;
 *   - index shards fetched once and remembered;
 *   - no key computing; hashing only to verify, once per asset per device.
 */

/** Where verified assets are kept on the device (Cache Storage, IndexedDB, a Map in tests). */
export type AssetCache = {
  get(key: string): Promise<{ bytes: ArrayBuffer; type: string } | null | undefined>;
  put(key: string, value: { bytes: ArrayBuffer; type: string }): Promise<void>;
};

export type ResolverOptions = {
  /** Stores the app or school configured, tried before the book's. */
  hostStores?: readonly StoreDescriptor[];
  /** Stores the book suggests (manifest.assetSources), tried last; their `auth` is ignored (always none). */
  bookStores?: readonly StoreDescriptor[];
  cache?: AssetCache;
  /** Bearer token for a host store with auth 'bearer'. */
  token?: (storeId: string) => string | undefined;
  fetch?: typeof fetch;
  /** How long a failing store is skipped (ms). Default 60 s (spec 1.2 §6.2). */
  skipFor?: number;
  /** Downloads at once. Default 4. */
  concurrency?: number;
  now?: () => number;
};

export type Resolved = { bytes: ArrayBuffer; type: string; from: string };
export type Located = { url: string; from: string; headers?: Record<string, string> };

const DEFAULT_PRIORITY = 100;

export function createResolver(o: ResolverOptions = {}) {
  const doFetch = o.fetch ?? globalThis.fetch.bind(globalThis);
  const now = o.now ?? Date.now;
  const skipFor = o.skipFor ?? 60_000;
  const host = (o.hostStores ?? []).filter(known);
  const book = (o.bookStores ?? []).filter(known).map((d) => ({ ...d, auth: 'none' as const }));
  const plans = new Map<string, StoreDescriptor[]>();
  const shards = new Map<string, Promise<IndexShard | null>>();
  const downAt = new Map<string, number>();
  const inflight = new Map<string, Promise<Resolved | null>>();

  // a small gate: at most `concurrency` downloads at once
  let running = 0;
  const waiting: (() => void)[] = [];
  const gate = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (running >= (o.concurrency ?? 4)) await new Promise<void>((r) => waiting.push(r));
    running++;
    try { return await fn(); } finally { running--; waiting.shift()?.(); }
  };

  /** Eligible stores for a type, in order: host before book, then priority, then list order. Once per type. */
  function plan(type: string): StoreDescriptor[] {
    const t = type.toLowerCase();
    let p = plans.get(t);
    if (!p) {
      const order = (list: StoreDescriptor[]) => list
        .map((d, i) => ({ d, i })).filter(({ d }) => matchesType(d.media, t))
        .sort((a, b) => (a.d.priority ?? DEFAULT_PRIORITY) - (b.d.priority ?? DEFAULT_PRIORITY) || a.i - b.i).map(({ d }) => d);
      p = [...order(host), ...order(book)];
      plans.set(t, p);
    }
    return p;
  }
  const isDown = (s: StoreDescriptor) => (downAt.get(s.id) ?? -Infinity) > now();
  const markDown = (s: StoreDescriptor) => downAt.set(s.id, now() + skipFor);
  const headersFor = (s: StoreDescriptor): Record<string, string> => {
    const t = s.auth === 'bearer' ? o.token?.(s.id) : undefined;
    return t ? { Authorization: `Bearer ${t}` } : {};
  };

  /** Where a store says the asset is, without downloading it; null if this store does not have it. */
  async function urlIn(s: StoreDescriptor, key: string): Promise<string | null> {
    if (s.kind === 'derived') return derivedUrl(s, key);
    if (s.kind === 'api') return apiUrl(s, key);
    // indexed: one shard per two leading characters, fetched once
    const sk = `${s.id}|${shardOf(key)}`;
    let shard = shards.get(sk);
    if (!shard) {
      shard = doFetch(shardUrl(s, key), { headers: headersFor(s) }).then(async (r) => {
        if (r.status === 404) return { v: 1 as const, entries: {} };
        if (!r.ok) throw new Error(`shard ${r.status}`);
        return indexShardSchema.parse(await r.json());
      });
      shards.set(sk, shard);
      shard.catch(() => shards.delete(sk));   // a failed shard can be fetched again later
    }
    const e = (await shard)?.entries[hashPart(key)];
    if (!e) return null;
    return /^[a-z][a-z0-9+.-]*:/i.test(e.p) ? e.p : s.base + e.p;
  }

  /** Must these bytes be checked before use? (spec 1.2 §6.4) Labs always; else by the store's policy. */
  const mustVerify = (s: StoreDescriptor, type: string) => type.toLowerCase().startsWith('text/html') || (s.verify ?? 'first') !== 'none';

  async function fromStores(id: string, key: string, type: string): Promise<Resolved | null> {
    for (const s of plan(type)) {
      if (isDown(s)) continue;
      try {
        const url = await urlIn(s, key);
        if (!url) continue;
        const r = await gate(() => doFetch(url, { headers: headersFor(s) }));
        if (r.status === 404 || r.status === 410) continue;
        if (!r.ok) { if (r.status >= 500) markDown(s); continue; }
        const bytes = await r.arrayBuffer();
        if (mustVerify(s, type) && !(await verifyAssetBytes(id, new Uint8Array(bytes)))) continue;   // not what the id names: next store
        // cached once obtained: verified, or from a store the host trusts (verify 'none')
        await o.cache?.put(key, { bytes, type });
        return { bytes, type, from: s.id };
      } catch {
        markDown(s);
      }
    }
    return null;
  }

  return {
    /** The asset's bytes: from the cache, else the first store that has them (verified as the spec says). */
    resolve(id: string, type: string): Promise<Resolved | null> {
      const key = resolutionKey(id);
      if (!key) return Promise.resolve(null);   // not content-addressed: lives only inside a book
      const running = inflight.get(key);
      if (running) return running;
      const p = (async () => {
        const hit = await o.cache?.get(key);
        if (hit) return { ...hit, from: 'cache' };
        return fromStores(id, key, type);
      })().finally(() => inflight.delete(key));
      inflight.set(key, p);
      return p;
    },

    /**
     * A URL to stream from (audio, video): the first store that answers for the key, checked with a HEAD
     * request, without downloading. Not verified (spec 1.2 §6.4 allows streaming); not for lab entries.
     */
    async locate(id: string, type: string): Promise<Located | null> {
      const key = resolutionKey(id);
      if (!key || type.toLowerCase().startsWith('text/html')) return null;
      for (const s of plan(type)) {
        if (isDown(s)) continue;
        try {
          const url = await urlIn(s, key);
          if (!url) continue;
          const r = await gate(() => doFetch(url, { method: 'HEAD', headers: headersFor(s) }));
          if (r.ok) { const headers = headersFor(s); return Object.keys(headers).length ? { url, from: s.id, headers } : { url, from: s.id }; }
          if (r.status >= 500) markDown(s);
        } catch { markDown(s); }
      }
      return null;
    },

    /** The ordered stores for a type (for diagnostics and tests). */
    plan: (type: string) => plan(type).map((s) => s.id),
  };
}

export type Resolver = ReturnType<typeof createResolver>;

/** Kinds this resolver knows; others are skipped (spec 1.2 §5.1). */
function known(d: StoreDescriptor): boolean {
  return d.kind === 'derived' || d.kind === 'indexed' || d.kind === 'api';
}
