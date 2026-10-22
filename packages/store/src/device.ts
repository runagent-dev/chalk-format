import type { Library, LibraryItem, NewItem } from './library.js';
import { itemFor, searchItems } from './library.js';

/**
 * "This device": a library in the browser's own database (IndexedDB). Always there, works offline; what an author
 * adds before uploading anywhere lives here. Readable only on this device (no `delivery`).
 */

const DB = 'chalk-library', VERSION = 1;

function open(name: string, idb: IDBFactory): Promise<IDBDatabase> {
  return new Promise((ok, fail) => {
    const r = idb.open(name, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('items')) db.createObjectStore('items', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('bytes')) db.createObjectStore('bytes');
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
}
const done = <T>(r: IDBRequest<T>) => new Promise<T>((ok, fail) => { r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error); });
const committed = (t: IDBTransaction) => new Promise<void>((ok, fail) => { t.oncomplete = () => ok(); t.onerror = () => fail(t.error); t.onabort = () => fail(t.error); });

export function deviceLibrary(o: { name?: string; database?: string; indexedDB?: IDBFactory } = {}): Library {
  const idb = o.indexedDB ?? globalThis.indexedDB;
  let db: Promise<IDBDatabase> | null = null;
  const conn = () => (db ??= open(o.database ?? DB, idb));
  const urls = new Map<string, string>();
  let cache: LibraryItem[] | null = null;
  const all = async () => (cache ??= await done((await conn()).transaction('items').objectStore('items').getAll() as IDBRequest<LibraryItem[]>));

  const lib: Library = {
    id: 'device', name: o.name ?? 'This device', kind: 'device', writable: true, connection: { kind: 'device' },
    async search(q) { return searchItems(await all(), q); },
    async item(key) { return (await all()).find((i) => i.key === key) ?? null; },
    async get(key) {
      const it = await lib.item(key); if (!it) return null;
      const blob = await done((await conn()).transaction('bytes').objectStore('bytes').get(key) as IDBRequest<Blob | ArrayBuffer | undefined>);
      if (!blob) return null;
      const bytes = new Uint8Array(blob instanceof ArrayBuffer ? blob : await blob.arrayBuffer());
      return { bytes, type: it.type };
    },
    async url(key) {
      const have = urls.get(key); if (have) return have;
      if (typeof URL.createObjectURL !== 'function') return null;
      const b = await lib.get(key); if (!b) return null;
      const u = URL.createObjectURL(new Blob([b.bytes as BlobPart], { type: b.type }));
      urls.set(key, u);
      return u;
    },
    async has(keys) { const mine = new Set((await all()).map((i) => i.key)); return new Set(keys.filter((k) => mine.has(k))); },
    async put(n: NewItem) {
      const it = await itemFor(n);
      const existing = await lib.item(it.key);
      if (existing) return existing;
      const t = (await conn()).transaction(['items', 'bytes'], 'readwrite');
      t.objectStore('items').put(it);
      // stored as an ArrayBuffer copy: some browsers' IndexedDB will not keep a view of a larger buffer
      t.objectStore('bytes').put(n.bytes.slice().buffer, it.key);
      await committed(t);
      cache = null;
      return it;
    },
    async status() { try { await conn(); return 'ok'; } catch { return 'no-permission'; } },
    dispose() { for (const u of urls.values()) URL.revokeObjectURL(u); urls.clear(); void db?.then((d) => d.close()); db = null; },
  };
  return lib;
}
