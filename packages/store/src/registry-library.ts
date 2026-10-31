import { indexShardSchema, type IndexShard, type StoreDescriptor } from '@chalk-format/model';
import type { Library, LibraryItem } from './library.js';
import { RegistryError, createRegistryClient, type AssetRecord } from './registry.js';
import { fetchWithToken, type TokenSource } from './auth/token.js';
import { apiUrl, derivedUrl, hashPart, shardOf, shardUrl } from './urls.js';

/**
 * A library server (registry API, spec/1.2/registry-api.md) as a library: search, upload and facts through the
 * API; bytes from its public delivery store (a CDN over R2 or any S3-compatible bucket), which it names itself
 * (`GET v1/stores`), so readers anywhere can fetch them too.
 */
export function registryLibrary(o: {
  url: string;
  /**
   * The signed-in user's token, or a function giving the current one (`libraryAuth(...).token`; asked again once after a 401). Read-only
   * use of a public library needs none.
   */
  token?: TokenSource | undefined;
  name?: string;
  id?: string;
  fetch?: typeof fetch;
}): Library {
  const c = createRegistryClient(o.url, { ...(o.token ? { token: o.token } : {}), ...(o.fetch ? { fetch: o.fetch } : {}) });
  const doFetch = o.fetch ?? globalThis.fetch.bind(globalThis);
  let stores: Promise<StoreDescriptor[]> | null = null;
  const allStores = () => (stores ??= c.stores().then((r) => r.items).catch(() => { stores = null; return []; }));
  const addressable = (d: StoreDescriptor) => d.kind === 'derived' || d.kind === 'api';
  // the public delivery store (anyone can fetch from it by URL); a library that needs a token for reading (PUBLIC_READ=false) has only a
  // store with `auth: 'bearer'`, whose bytes are fetched with the token instead
  const deliveryStore = async () => (await allStores()).find((d) => (d.auth ?? 'none') === 'none' && addressable(d)) ?? null;
  const tokenStore = async () => (await allStores()).find((d) => d.auth === 'bearer' && addressable(d)) ?? null;
  const at = (s: StoreDescriptor, key: string) => (s.kind === 'derived' ? derivedUrl(s, key) : apiUrl(s, key));
  // files the library adopted in place (registry-api §3.1) are not at the derived path: its public indexed store
  // (spec 1.2 §5.3) says where they are. A shard is kept a minute, as the library's own Cache-Control says.
  const shards = new Map<string, { at: number; shard: Promise<IndexShard | null> }>();
  const indexed = async (key: string) => {
    for (const s of (await allStores()).filter((d) => d.kind === 'indexed' && (d.auth ?? 'none') === 'none' && d.base)) {
      const id = `${s.id}|${shardOf(key)}`, hit = shards.get(id);
      const shard = hit && Date.now() - hit.at < 60_000 ? hit.shard : doFetch(shardUrl(s, key)).then(async (r) => (r.ok ? indexShardSchema.parse(await r.json()) : null)).catch(() => null);
      if (shard !== hit?.shard) shards.set(id, { at: Date.now(), shard });
      const e = (await shard)?.entries[hashPart(key)];
      if (e) return /^[a-z][a-z0-9+.-]*:/i.test(e.p) ? e.p : s.base + e.p;
    }
    return null;
  };
  const toItem = (r: AssetRecord): LibraryItem => ({
    key: r.key, type: r.type, size: r.size,
    ...(r.title ? { title: r.title } : {}), ...(r.filename ? { filename: r.filename } : {}), ...(r.tags?.length ? { tags: r.tags } : {}),
    ...(r.subject ? { subject: r.subject } : {}), ...(r.meta ? { meta: r.meta } : {}), ...(r.poster ? { poster: r.poster } : {}),
    createdAt: r.createdAt,
  });
  const lib: Library = {
    id: o.id ?? `registry:${o.url}`, name: o.name ?? new URL(o.url).host, kind: 'registry', writable: Boolean(o.token),
    // a token given as a function comes from the host's sign-in and is not kept; a typed-in one is
    connection: { kind: 'registry', url: o.url, ...(o.name ? { name: o.name } : {}), ...(typeof o.token === 'string' ? { token: o.token } : {}) },
    async search(q) {
      const page = await c.search({ ...(q.q ? { q: q.q } : {}), ...(q.types?.length ? { type: q.types } : {}), ...(q.limit ? { limit: q.limit } : {}), ...(q.cursor ? { cursor: q.cursor } : {}) });
      return { items: page.items.map(toItem), ...(page.next ? { next: page.next } : {}) };
    },
    async item(key) {
      try { return toItem(await c.get(key)); } catch (e) { if (e instanceof RegistryError && e.status === 404) return null; throw e; }
    },
    async url(key) {
      const s = await deliveryStore();
      return s ? (await indexed(key)) ?? at(s, key) : null;
    },
    async get(key) {
      const pub = await deliveryStore();
      const s = pub ?? (o.token ? await tokenStore() : null);
      if (!s) return null;
      // an adopted key: where the index says, before the derived path (which may hold an unverified upload's bytes)
      const u = pub ? (await indexed(key)) ?? at(s, key) : null;
      const r = u ? await doFetch(u) : await fetchWithToken(doFetch, o.token, at(s, key));
      if (!r.ok) return null;
      return { bytes: new Uint8Array(await r.arrayBuffer()), type: r.headers.get('content-type') ?? 'application/octet-stream' };
    },
    async has(keys) { return keys.length ? new Set((await c.check([...keys])).present) : new Set(); },
    async put(n) {
      const r = await c.add(n.bytes, { type: n.type, ...(n.filename ? { filename: n.filename } : {}), ...(n.title ? { title: n.title } : {}),
        ...(n.tags?.length ? { tags: n.tags } : {}), ...(n.subject ? { subject: n.subject } : {}), ...(n.meta ? { meta: n.meta } : {}), ...(n.poster ? { poster: n.poster } : {}) });
      return toItem(r);
    },
    delivery: deliveryStore,
    async status() {
      try { await c.stores(); return 'ok'; } catch (e) { return e instanceof RegistryError && (e.status === 401 || e.status === 403) ? 'sign-in' : 'offline'; }
    },
  };
  return lib;
}
