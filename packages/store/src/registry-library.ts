import type { StoreDescriptor } from '@chalk-format/model';
import type { Library, LibraryItem } from './library.js';
import { RegistryError, createRegistryClient, type AssetRecord } from './registry.js';
import { apiUrl, derivedUrl } from './urls.js';

/**
 * A library server (registry API, spec/1.2/registry-api.md) as a library: search, upload and facts through the
 * API; bytes from its public delivery store (a CDN over R2 or any S3-compatible bucket), which it names itself
 * (`GET v1/stores`), so readers anywhere can fetch them too.
 */
export function registryLibrary(o: {
  url: string;
  /** The signed-in user's token, or a function giving the current one. Read-only use may need none. */
  token?: string | (() => string | undefined | Promise<string | undefined>);
  name?: string;
  id?: string;
  fetch?: typeof fetch;
}): Library {
  const c = createRegistryClient(o.url, { ...(o.token ? { token: o.token } : {}), ...(o.fetch ? { fetch: o.fetch } : {}) });
  const doFetch = o.fetch ?? globalThis.fetch.bind(globalThis);
  let store: Promise<StoreDescriptor | null> | null = null;
  const deliveryStore = () => (store ??= c.stores().then((r) => r.items.find((d) => (d.auth ?? 'none') === 'none' && (d.kind === 'derived' || d.kind === 'api')) ?? null).catch(() => { store = null; return null; }));
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
      const s = await deliveryStore(); if (!s) return null;
      return s.kind === 'derived' ? derivedUrl(s, key) : apiUrl(s, key);
    },
    async get(key) {
      const u = await lib.url(key); if (!u) return null;
      const r = await doFetch(u); if (!r.ok) return null;
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
