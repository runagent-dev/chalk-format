import { createHash } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { c1FromSha256, isC1Key, type StoreDescriptor } from '@chalk-format/model';
import { adoptPathSchema, adoptRequestSchema, standardPath, matchesType, type AdoptRequest } from '@chalk-format/store';
import { requireRole, type AuthVariables } from './auth/guard.js';
import type { Db } from './db.js';
import { servedType, type Storage } from './storage.js';

/**
 * Files adopted in place (spec/1.2/registry-api.md §3.1): an object the library's own bucket already has at a path
 * of its owner's choosing (a book written by another tool, `chalk-books/<slug>/assets/…`), under a prefix the
 * operator allows (ADOPT_PREFIXES). The library reads it once inside the bucket to verify it, records the asset and
 * its location, and serves it from there. Nothing is copied, and withdrawing never deletes it (its owner does).
 *
 *   POST /v1/assets/adopt   (author) { key, sha256, type, size, path, title?, … } → the record
 *   GET  /index/{h0}.json   a public library's indexed store (spec 1.2 §5.3): where each adopted key is
 *
 * Every read path finds an asset's bytes through `locate` (its location), not the standard path alone.
 */

/** ADOPT_PREFIXES: each ends with `/`, is a path inside the bucket, and is never the standard layout's `c1/`. */
export function adoptPrefixes(spec: string | readonly string[] | undefined): string[] {
  const list = (typeof spec === 'string' ? spec.split(',') : spec ?? []).map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/\/*$/, '/'));
  for (const p of list) {
    if (!adoptPathSchema.safeParse(p.slice(0, -1)).success) throw new Error(`ADOPT_PREFIXES: ${p} is not a path inside the bucket`);
    if (p === 'c1/' || p.startsWith('c1/')) throw new Error('ADOPT_PREFIXES: c1/ is the library\'s own layout, not a place to adopt from');
  }
  return list;
}

/**
 * How long a location is trusted after it was last seen (verified on adopting, or checked by a HEAD). A bucket
 * (S3/R2) answers a HEAD over the network, so a location is checked at most once in this time, not on every request;
 * a folder answers from the file system, so it is checked every time (and no row is written unless it changed).
 */
export const LOCATION_CHECK_SECONDS = 300;
const checkSeconds = (storage: Storage) => ('ticket' in storage ? 0 : LOCATION_CHECK_SECONDS);

type LocationRow = { path: string; verified_at: string | Date | null; checked_at: string | Date | null; missing: boolean };
/** A key's locations in the library's store, best first: the library's own copy, then present ones, newest verified first. */
const locationsOf = (db: Db, key: string) => db.query<LocationRow>(`SELECT path, verified_at, checked_at, missing FROM locations WHERE key = $1 AND store = 'library'
  ORDER BY (path LIKE 'c1/%') DESC, missing, verified_at DESC NULLS LAST, path`, [key]);

/**
 * Where the library keeps a key's bytes (registry-api §3.1): a location whose object is there, else the standard
 * path. A key adopted from several books has a location per book, each its owner's copy, and an owner may delete
 * its copy (pruning a draft). The best location is used while it is fresh; once it is not, it is HEADed: present, it
 * is used (and fresh again); gone, it is marked missing and the next one is tried. So a bucket sees at most one HEAD
 * per location per LOCATION_CHECK_SECONDS, and readers move to another book's copy within that time.
 */
export async function locate(db: Db, storage: Storage, key: string): Promise<string> {
  const rows = await locationsOf(db, key);
  if (!rows.length) return standardPath(key);
  if (rows.length === 1) return rows[0]!.path;   // nowhere else to go: no need to look
  const ttl = checkSeconds(storage) * 1000, now = Date.now();
  for (const r of rows) {
    const seen = r.checked_at ?? r.verified_at;
    if (ttl > 0 && seen && now - new Date(seen).getTime() < ttl) { if (!r.missing) return r.path; continue; }
    const missing = (await storage.head(r.path)) === null;
    if (ttl > 0 || missing !== r.missing) {
      await db.query("UPDATE locations SET checked_at = $3, missing = $4 WHERE key = $1 AND store = 'library' AND path = $2", [key, r.path, new Date(now), missing]);
    }
    if (!missing) return r.path;
  }
  return rows[0]!.path;   // all gone: the reader gets the store's 404
}

/**
 * The asset whose bytes a path in the bucket holds (the `/files/` routes of a disk library): by its location, or
 * by the standard path's key. Null when none is recorded there.
 */
export async function assetAt(db: Db, path: string): Promise<{ key: string; type: string; status: string } | null> {
  const [row] = await db.query<{ key: string; type: string; status: string }>(`SELECT a.key, a.type, a.status FROM locations l JOIN assets a ON a.key = l.key
    WHERE l.store = 'library' AND l.path = $1 ORDER BY l.missing, l.verified_at DESC NULLS LAST LIMIT 1`, [path]);
  if (row) return row;
  const m = /^c1\/[a-z2-7]{2}\/[a-z2-7]{2}\/([a-z2-7]{25}[aeimquy4])$/.exec(path);
  if (!m) return null;
  const key = `c1:${m[1]}`;
  // a key adopted elsewhere is not at its standard path
  const [a] = await db.query<{ key: string; type: string; status: string }>(`SELECT key, type, status FROM assets WHERE key = $1
    AND NOT EXISTS (SELECT 1 FROM locations WHERE key = $1 AND store = 'library' AND path <> $2)`, [key, path]);
  return a ?? null;
}

type Deps = {
  db: Db; storage: Storage; prefixes: string[]; publicUrl: string; publicRead: boolean; maxBytes: number; types: string[];
  fail: (c: Context, status: number, code: string, message: string) => Response;
  /** The register path's own pieces, so adopting records exactly what registering does. */
  ensureStore: () => Promise<unknown>;
  describe: (d: AdoptRequest) => Promise<void>;
  recordOf: (key: string) => Promise<unknown>;
  sha256Of: (storage: Storage, path: string) => Promise<string | null>;
  /** This server's public address (SERVER_URL), else the one the request reached. */
  base: (c: Context) => string;
};

/** The indexed store readers of a public library use for adopted files; null when there is none to name. */
export async function adoptedStore(d: Pick<Deps, 'db' | 'prefixes' | 'publicRead' | 'base'>, c: Context): Promise<StoreDescriptor | null> {
  if (!d.publicRead) return null;
  // adopting is on, or was (files adopted before ADOPT_PREFIXES was emptied are still served); looked up at most once a minute
  const any = d.prefixes.length > 0 || (await adoptedBefore(d.db));
  return any ? { id: 'library-adopted', kind: 'indexed', base: `${d.base(c)}/` } : null;
}
const seen = new WeakMap<Db, { at: number; any: boolean }>();
async function adoptedBefore(db: Db) {
  const s = seen.get(db);
  if (s && (s.any || Date.now() - s.at < 60_000)) return s.any;
  const any = (await db.query("SELECT 1 FROM locations WHERE store = 'library' AND path NOT LIKE 'c1/%' LIMIT 1")).length > 0;
  seen.set(db, { at: Date.now(), any });
  return any;
}

export function registerAdopt(app: Hono<{ Variables: AuthVariables }>, d: Deps) {
  const { db, storage, fail } = d;

  app.post('/v1/assets/adopt', async (c) => {
    const denied = requireRole(c, 'author'); if (denied) return denied;
    if (!d.prefixes.length) return fail(c, 403, 'forbidden', 'this library does not adopt files (ADOPT_PREFIXES is not set)');
    const r = adoptRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!r.success) return fail(c, 400, 'invalid', r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const a = r.data;
    if (!d.prefixes.some((p) => a.path.startsWith(p))) return fail(c, 403, 'forbidden', `${a.path} is not under a prefix this library adopts from`);
    if (c1FromSha256(`sha256:${a.sha256}`) !== a.key) return fail(c, 400, 'invalid', 'key is not the c1 key of sha256');
    if (!matchesType(d.types, a.type)) return fail(c, 415, 'unsupported_type', `${a.type} is not accepted here`);
    if (a.size > d.maxBytes) return fail(c, 413, 'too_large', `at most ${d.maxBytes} bytes`);
    const [row] = await db.query<{ status: string }>('SELECT status FROM assets WHERE key = $1', [a.key]);
    if (row?.status === 'withdrawn') return fail(c, 410, 'gone', 'this asset was withdrawn');
    const locs = await locationsOf(db, a.key);
    // each path is adopted once: already verified at this path (and not found gone since), or the library has its own
    // copy at the standard path (uploaded; no one else deletes it), so nothing is read again. Another book's path is
    // ADDED as one more location, so the key outlives either book's copy.
    // A path adopted before is HEADed (not read): its owner may have deleted it since.
    const std = locs.find((l) => l.path === standardPath(a.key) && l.verified_at != null && !l.missing);   // a copy found gone is no reason to skip
    const same = locs.find((l) => l.path === a.path && l.verified_at != null);
    let keep = row?.status === 'available' && Boolean(std);
    if (row?.status === 'available' && !keep && same) {
      const head = await storage.head(a.path);
      keep = head !== null && head.size === a.size;
      await db.query("UPDATE locations SET checked_at = $3, missing = $4 WHERE key = $1 AND store = 'library' AND path = $2", [a.key, a.path, new Date(), head === null]);
    }
    if (!keep) {
      const head = await storage.head(a.path);
      if (!head) return fail(c, 409, 'conflict', `there is no object at ${a.path}`);
      // a public bucket serves the object as the type it was written with: code written as a page or a script would run
      // on the bucket's (CDN's) origin. Uploads are always written safe (presignPut); an adopted file must be too.
      const stored = head.type?.split(';')[0]!.trim().toLowerCase();
      if (d.publicRead && stored && stored !== 'application/octet-stream' && servedType(stored) === 'application/octet-stream') {
        return fail(c, 403, 'forbidden', `the object at ${a.path} is stored as ${stored}, which a public bucket would serve as a page; store it as application/octet-stream, or upload it`);
      }
      // read once, inside the bucket: the bytes are what the key names (nothing is recorded otherwise, nothing deleted)
      if (head.size !== a.size || (await d.sha256Of(storage, a.path)) !== a.sha256) return fail(c, 422, 'verification_failed', `the object at ${a.path} is not the one this key names`);
      await d.ensureStore();
      // one statement, so readers never see the key available without its location (they would look at the standard
      // path, where a pending upload's unverified bytes may be). A withdrawn key is never made available again.
      await db.query(`WITH asset AS (INSERT INTO assets (key, sha256, type, size, status, uploaded_by) VALUES ($1, $2, $3, $4, 'available', $5)
          ON CONFLICT (key) DO UPDATE SET status = 'available', type = EXCLUDED.type, size = EXCLUDED.size WHERE assets.status = 'pending')
        INSERT INTO locations (key, store, path, verified_at) SELECT $1, 'library', $6, now() WHERE NOT EXISTS (SELECT 1 FROM assets WHERE key = $1 AND status = 'withdrawn')
        ON CONFLICT (key, store, path) DO UPDATE SET verified_at = now(), checked_at = NULL, missing = false`, [a.key, a.sha256, a.type, a.size, c.get('caller')!.user, a.path]);
      // withdrawn while its bytes were being read: nothing more is done for it
      const [now] = await db.query<{ status: string }>('SELECT status FROM assets WHERE key = $1', [a.key]);
      if (now?.status === 'withdrawn') return fail(c, 410, 'gone', 'this asset was withdrawn');
      // an upload that was started (pending) may have left unverified bytes at the standard path, the library's own
      // copy: removed, so the derived store 404s and readers find the key where it was adopted
      // (unless a register of that upload just made the standard path one of its locations)
      if (row?.status === 'pending' && !(await locationsOf(db, a.key)).some((l) => l.path === standardPath(a.key))) {
        await storage.remove(standardPath(a.key));
        // a register that finished between that look and the removal recorded a copy that is now gone: say so, so no
        // read path serves it (one that records it after this is found gone by locate's next check)
        await db.query("UPDATE locations SET missing = true, checked_at = $3 WHERE key = $1 AND store = 'library' AND path = $2", [a.key, standardPath(a.key), new Date()]);
      }
    }
    await d.describe(a);
    return c.json(await d.recordOf(a.key));
  });

  // ---- a public library's indexed store: where each adopted key is (spec 1.2 §5.3) ----
  const filesBase = d.publicUrl.replace(/\/?$/, '/');
  app.get('/index/:shard', async (c) => {
    const h0 = /^([a-z2-7]{2})\.json$/.exec(c.req.param('shard'))?.[1];
    // a private library names no index (its readers' store redirects through the location); a shard is not served either
    if (!h0 || !d.publicRead) return c.text('not found', 404, { 'Access-Control-Allow-Origin': '*' });
    // keys with a copy at a path of their own (an adopted one), each with its location's paths; one also at the standard
    // path is left to the derived store unless that copy is gone
    const rows = await db.query<{ key: string; size: string | number; type: string; paths: string[] }>(`SELECT a.key, a.size, a.type,
        array_agg(l.path ORDER BY l.missing, l.verified_at DESC NULLS LAST, l.path) AS paths
      FROM locations l JOIN assets a ON a.key = l.key
      WHERE l.store = 'library' AND a.status = 'available' AND substr(a.key, 4, 2) = $1
      GROUP BY a.key, a.size, a.type HAVING bool_or(l.path NOT LIKE 'c1/%') ORDER BY a.key`, [h0]);
    const entries: Record<string, { p: string; s: number; t: string }> = {};
    for (const r of rows) {
      if (!isC1Key(r.key)) continue;
      // a key in several books: the copy that is still there (checked as locate does, at most once in a while)
      const path = r.paths.length > 1 ? await locate(db, storage, r.key) : r.paths[0]!;
      if (path === standardPath(r.key)) continue;
      entries[r.key.slice(3)] = { p: filesBase + path.split('/').map(encodeURIComponent).join('/'), s: Number(r.size), t: r.type };
    }
    const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=60' };
    if (!Object.keys(entries).length) return c.text('not found', 404, headers);
    const body = JSON.stringify({ v: 1, entries });
    const etag = `"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`;
    if (c.req.header('if-none-match') === etag) return c.body(null, 304, { ...headers, ETag: etag });
    return c.body(body, 200, { ...headers, ETag: etag, 'Content-Type': 'application/json' });
  });
}
