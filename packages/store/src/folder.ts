import { assetKey } from '@chalk-format/model';
import type { Library, LibraryItem, NewItem } from './library.js';
import { itemFor, searchItems } from './library.js';
import { hashPart, shardOf, standardPath } from './urls.js';

/**
 * A folder as a library: on this computer, a USB drive, or a school server's disk. Items added go to the standard
 * layout (`c1/{h0}/{h1}/{h}`, spec 1.2 §5.2); files already in the folder are found by `scan()`. Search uses
 * `chalk-library.json` (titles, tags, types); `index/{h0}.json` shards (spec 1.2 §5.3) map every key to its file,
 * so the same folder served over HTTP is a store any reader can use (give its address as `publicUrl`).
 */

/** What a folder library needs from a folder. */
export interface Dir {
  readonly name: string;
  /** The browser's handle, when it is a folder picked in the browser (to keep and connect again). */
  readonly handle?: FileSystemDirectoryHandle;
  read(path: string): Promise<Uint8Array | null>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  /** Every file below, recursively, as paths relative to the folder. */
  list(): AsyncIterable<{ path: string; size: number }>;
  /** A URL to the file (a blob: URL for a local folder), if the folder can give one. */
  url?(path: string): Promise<string | null>;
}

const CATALOG = 'chalk-library.json';
type Catalog = { v: 1; items: LibraryItem[]; paths: Record<string, string> };

/** Media this library picks up when scanning, by file extension. */
const BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', oga: 'audio/ogg', wav: 'audio/wav',
  glb: 'model/gltf-binary', pdf: 'application/pdf',
};
export const typeFromName = (name: string): string | null => BY_EXT[name.toLowerCase().split('.').pop() ?? ''] ?? null;

export type FolderLibrary = Library & {
  /** Find media already in the folder and add it (keys computed once, here). Returns how many were new. */
  scan(onProgress?: (done: number, total: number) => void): Promise<number>;
};

export function folderLibrary(dir: Dir, o: { id?: string; publicUrl?: string } = {}): FolderLibrary {
  // an address is a folder: without the final slash, URL joining would drop its last part
  const base = o.publicUrl ? (o.publicUrl.endsWith('/') ? o.publicUrl : `${o.publicUrl}/`) : undefined;
  let catalog: Catalog | null = null;
  const dec = new TextDecoder(), enc = new TextEncoder();
  const load = async (): Promise<Catalog> => {
    if (catalog) return catalog;
    const raw = await dir.read(CATALOG);
    try { catalog = raw ? (JSON.parse(dec.decode(raw)) as Catalog) : null; } catch { catalog = null; }
    return (catalog ??= { v: 1, items: [], paths: {} });
  };
  const pathOf = async (key: string) => (await load()).paths[key] ?? null;
  /** Save the catalog and the shards it touches. */
  const persist = async (touched: readonly string[]) => {
    const c = await load();
    await dir.write(CATALOG, enc.encode(JSON.stringify(c)));
    for (const shard of new Set(touched.map(shardOf))) {
      const entries: Record<string, { p: string; s?: number; t?: string }> = {};
      for (const it of c.items) if (shardOf(it.key) === shard) entries[hashPart(it.key)] = { p: c.paths[it.key]!, s: it.size, t: it.type };
      await dir.write(`index/${shard}.json`, enc.encode(JSON.stringify({ v: 1, entries })));
    }
  };

  const lib: FolderLibrary = {
    id: o.id ?? `folder:${dir.name}`, name: dir.name, kind: 'folder', writable: true,
    ...(dir.handle ? {
      connection: { kind: 'folder' as const, handle: dir.handle },
      // after a reload the browser asks again before a page may use a folder
      async connect() { await (dir.handle as unknown as { requestPermission(o: object): Promise<string> }).requestPermission({ mode: 'readwrite' }); catalog = null; },
    } : {}),
    async search(q) { return searchItems((await load()).items, q); },
    async item(key) { return (await load()).items.find((i) => i.key === key) ?? null; },
    async get(key) {
      const p = await pathOf(key); if (!p) return null;
      const bytes = await dir.read(p); if (!bytes) return null;
      return { bytes, type: (await lib.item(key))?.type ?? 'application/octet-stream' };
    },
    async url(key) {
      const p = await pathOf(key); if (!p) return null;
      if (base) return new URL(p, base).href;
      return dir.url ? dir.url(p) : null;
    },
    async has(keys) { const c = await load(); return new Set(keys.filter((k) => c.paths[k])); },
    async put(n: NewItem) {
      const c = await load();
      const it = await itemFor(n);
      if (c.paths[it.key]) return c.items.find((i) => i.key === it.key)!;
      const p = standardPath(it.key);
      await dir.write(p, n.bytes);
      c.items.push(it); c.paths[it.key] = p;
      await persist([it.key]);
      return it;
    },
    async delivery() { return base ? { id: lib.id, kind: 'indexed', base } : null; },
    async status() {
      if (dir.handle) {
        const q = await (dir.handle as unknown as { queryPermission(o: object): Promise<string> }).queryPermission({ mode: 'readwrite' }).catch(() => 'granted');
        if (q !== 'granted') return 'no-permission';
      }
      try { await load(); return 'ok'; } catch { return 'no-permission'; }
    },
    async scan(onProgress?: (done: number, total: number) => void) {
      const c = await load();
      const known = new Set(Object.values(c.paths));
      const found: { path: string; type: string }[] = [];
      for await (const f of dir.list()) {
        if (f.path === CATALOG || f.path.startsWith('c1/') || f.path.startsWith('index/') || known.has(f.path)) continue;
        const type = typeFromName(f.path);
        if (type) found.push({ path: f.path, type });
      }
      const added: string[] = [];
      for (const [i, f] of found.entries()) {
        const bytes = await dir.read(f.path);
        if (bytes) {
          const key = await assetKey(bytes);
          if (!c.paths[key]) {
            const name = f.path.split('/').pop()!;
            c.items.push({ key, type: f.type, size: bytes.byteLength, filename: name, title: name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' '), createdAt: new Date().toISOString() });
            c.paths[key] = f.path; added.push(key);
          }
        }
        onProgress?.(i + 1, found.length);
      }
      if (added.length) await persist(added);
      return added.length;
    },
  };
  return lib;
}

/** A folder picked in the browser (File System Access API: Chrome and Edge on computers). */
export function browserDir(handle: FileSystemDirectoryHandle): Dir {
  const urls = new Map<string, string>();
  const walk = async (path: string, create: boolean) => {
    const parts = path.split('/').filter(Boolean), file = parts.pop()!;
    let d = handle;
    for (const p of parts) d = await d.getDirectoryHandle(p, { create });
    return { d, file };
  };
  return {
    name: handle.name, handle,
    async read(path) {
      try { const { d, file } = await walk(path, false); return new Uint8Array(await (await (await d.getFileHandle(file)).getFile()).arrayBuffer()); } catch { return null; }
    },
    async write(path, bytes) {
      const { d, file } = await walk(path, true);
      const w = await (await d.getFileHandle(file, { create: true })).createWritable();
      await w.write(bytes as unknown as FileSystemWriteChunkType); await w.close();
    },
    async *list() {
      async function* go(d: FileSystemDirectoryHandle, at: string): AsyncGenerator<{ path: string; size: number }> {
        for await (const [name, h] of (d as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
          if (h.kind === 'directory') yield* go(h as FileSystemDirectoryHandle, `${at}${name}/`);
          else yield { path: `${at}${name}`, size: (await (h as FileSystemFileHandle).getFile()).size };
        }
      }
      yield* go(handle, '');
    },
    async url(path) {
      const have = urls.get(path); if (have) return have;
      try { const { d, file } = await walk(path, false); const u = URL.createObjectURL(await (await d.getFileHandle(file)).getFile()); urls.set(path, u); return u; } catch { return null; }
    },
  };
}

/** A folder in memory (tests, and a scratch library). */
export function memoryDir(name = 'memory', files: Record<string, Uint8Array> = {}): Dir & { files: Map<string, Uint8Array> } {
  const m = new Map(Object.entries(files));
  return {
    name, files: m,
    async read(p) { return m.get(p) ?? null; },
    async write(p, b) { m.set(p, b); },
    async *list() { for (const [path, b] of m) yield { path, size: b.byteLength }; },
  };
}
