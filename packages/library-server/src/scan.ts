import { c1FromSha256 } from '@chalk-format/model';
import { standardPath } from '@chalk-format/store';
import type { Db } from './db.js';
import { sha256Of } from './app.js';
import type { Storage } from './storage.js';

/** Media types by file extension, for objects a bucket already had (they carry no type the library trusts). */
const BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav', glb: 'model/gltf-binary', pdf: 'application/pdf',
};

/**
 * Adopt media a bucket already has (spec registry-api §3, done by the library itself): hash each object once,
 * copy it to its standard path inside the bucket (a server-side copy; nothing leaves the bucket) so readers find it
 * by key, and record it with a title from its file name. Objects already at a standard path, or already known, are
 * skipped, so running it again only adds what is new.
 */
export async function scanStorage(db: Db, storage: Storage, o: { prefix?: string; user?: string; onProgress?: (done: number, total: number, path: string) => void } = {}) {
  const todo: { path: string; size: number; type: string }[] = [];
  for await (const f of storage.list(o.prefix ?? '')) {
    if (f.path.startsWith('c1/')) continue;
    const type = BY_EXT[f.path.toLowerCase().split('.').pop() ?? ''];
    if (type) todo.push({ ...f, type });
  }
  await db.query("INSERT INTO stores (id, kind, template, public) VALUES ('library', 'derived', 'c1/{h0}/{h1}/{h}', true) ON CONFLICT (id) DO NOTHING");
  let added = 0;
  for (const [i, f] of todo.entries()) {
    const sum = await sha256Of(storage, f.path);
    if (sum) {
      const key = c1FromSha256(`sha256:${sum}`);
      const known = await db.query('SELECT 1 FROM assets WHERE key = $1', [key]);
      if (!known.length) {
        const to = standardPath(key);
        if (!(await storage.head(to))) await storage.copy(f.path, to);
        const name = f.path.split('/').pop()!;
        await db.query("INSERT INTO assets (key, sha256, type, size, filename, title, status, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6, 'available', $7)",
          [key, sum, f.type, f.size, name, name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' '), o.user ?? 'scan']);
        await db.query("INSERT INTO locations (key, store, path, verified_at) VALUES ($1, 'library', $2, now()) ON CONFLICT DO NOTHING", [key, to]);
        added++;
      }
    }
    o.onProgress?.(i + 1, todo.length, f.path);
  }
  return { found: todo.length, added };
}
