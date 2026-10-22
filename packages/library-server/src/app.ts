import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { c1FromSha256, isC1Key, type StoreDescriptor } from '@chalk-format/model';
import { checkRequestSchema, registerRequestSchema, uploadRequestSchema, standardPath, matchesType } from '@chalk-format/store';
import type { Db } from './db.js';
import type { DiskStorage, Storage } from './storage.js';

/**
 * The registry API (spec/1.2/registry-api.md): what authoring tools talk to. Readers never do; they fetch bytes from
 * the delivery store this library names (`GET v1/stores`), a CDN in front of the bucket.
 */

export type Caller = { user: string; admin: boolean };

export type LibraryOptions = {
  db: Db;
  storage: Storage | DiskStorage;
  /** Where readers fetch the bytes: the bucket's public address or a CDN in front of it (R2: a custom domain). */
  publicUrl: string;
  name?: string;
  /** Who may do what: a bearer token → the caller. */
  callers: (token: string) => Caller | null | Promise<Caller | null>;
  /** Searching and reading records without a token (default true: a public library). Writing always needs one. */
  publicRead?: boolean;
  /** Largest object accepted. Default 512 MiB. */
  maxBytes?: number;
  /** Accepted media type patterns. Default: images, video, audio, glTF models, PDF, lab files and manifests. */
  types?: string[];
  /** Browser origins allowed to call the API (authoring tools). Default any. */
  origins?: string[];
};

export const DEFAULT_TYPES = ['image/*', 'video/*', 'audio/*', 'model/gltf-binary', 'application/pdf', 'text/html', 'text/javascript', 'application/vnd.chalk.lab+json'];
const UPLOAD_SECONDS = 15 * 60;

/** Code is stored as plain bytes: a public bucket must never serve a lab's HTML or a library's script as a web page. */
const storedType = (type: string) => (/^(text\/html|text\/javascript|application\/javascript)/i.test(type) ? 'application/octet-stream' : type);

type Row = {
  key: string; sha256: string; type: string; size: string | number; width: number | null; height: number | null; duration: number | null; pages: number | null;
  title: string | null; filename: string | null; tags: string[] | null; subject: string | null; license: string | null; poster: string | null;
  status: 'pending' | 'available' | 'withdrawn'; uploaded_by: string | null; created_at: string | Date;
};

export function createLibraryApp(o: LibraryOptions) {
  const { db, storage } = o;
  const maxBytes = o.maxBytes ?? 512 * 1024 * 1024;
  const types = o.types ?? DEFAULT_TYPES;
  const disk = 'ticket' in storage ? (storage as DiskStorage) : null;
  const delivery: StoreDescriptor = { id: 'library', kind: 'derived', template: `${o.publicUrl.replace(/\/?$/, '/')}c1/{h0}/{h1}/{h}` };
  const app = new Hono<{ Variables: { caller: Caller | null } }>();

  const fail = (c: Context, status: number, code: string, message: string) => c.json({ error: { code, message } }, status as never);
  app.use('/v1/*', cors({ origin: o.origins ?? '*', allowHeaders: ['Authorization', 'Content-Type'], allowMethods: ['GET', 'POST', 'PUT', 'OPTIONS'], maxAge: 86400 }));
  app.use('/v1/*', async (c, next) => {
    const h = c.req.header('authorization');
    c.set('caller', h?.startsWith('Bearer ') ? await o.callers(h.slice(7)) : null);
    await next();
  });
  const reader = (c: Context) => (o.publicRead === false && !c.get('caller') ? fail(c, 401, 'unauthorized', 'a token is needed') : null);
  const writer = (c: Context) => (c.get('caller') ? null : fail(c, 401, 'unauthorized', 'a token is needed'));
  const body = async <T>(c: Context, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: { message: string; path: PropertyKey[] }[] } } }) => {
    const r = schema.safeParse(await c.req.json().catch(() => null));
    return r.success ? { ok: true as const, data: r.data } : { ok: false as const, res: fail(c, 400, 'invalid', r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')) };
  };

  const record = async (r: Row, withLocations: boolean) => {
    const renditions = (await db.query<{ rendition: string }>('SELECT rendition FROM renditions WHERE primary_key = $1', [r.key])).map((x) => x.rendition);
    const meta = Object.fromEntries(Object.entries({ width: r.width, height: r.height, duration: r.duration, pages: r.pages }).filter(([, v]) => v != null));
    return {
      key: r.key, sha256: r.sha256.trim(), type: r.type, size: Number(r.size),
      ...(Object.keys(meta).length ? { meta } : {}),
      title: r.title, filename: r.filename, tags: r.tags ?? [], subject: r.subject, license: r.license, poster: r.poster,
      ...(renditions.length ? { renditions } : {}),
      status: r.status, uploadedBy: r.uploaded_by, createdAt: new Date(r.created_at).toISOString(),
      ...(withLocations ? { locations: (await db.query<{ store: string; path: string }>('SELECT store, path FROM locations WHERE key = $1', [r.key])) } : {}),
    };
  };
  const rowOf = async (key: string) => (await db.query<Row>('SELECT * FROM assets WHERE key = $1', [key]))[0] ?? null;
  // the store row the locations point at; created on first use
  let storeRow: Promise<unknown> | null = null;
  const ensureStore = () => (storeRow ??= db.query("INSERT INTO stores (id, kind, template, bucket, public) VALUES ('library', 'derived', $1, $2, true) ON CONFLICT (id) DO UPDATE SET template = EXCLUDED.template", [delivery.template, storage.id]));

  // what this address is, for someone who opens it in a browser
  app.get('/', (c) => c.json({
    name: o.name ?? 'Chalk library', api: 'Chalk registry API v1 (spec/1.2/registry-api.md)',
    endpoints: ['GET /v1/stores', 'GET /v1/search?q=', 'GET /v1/assets/{key}', 'POST /v1/assets/check', 'POST /v1/uploads', 'POST /v1/assets', 'GET /healthz'],
  }));

  // ---- §7 stores for readers: public, cacheable ----
  app.get('/v1/stores', (c) => { c.header('Cache-Control', 'public, max-age=300'); return c.json({ items: [delivery] }); });

  // ---- §3 adding ----
  app.post('/v1/assets/check', async (c) => {
    const denied = reader(c); if (denied) return denied;
    const b = await body(c, checkRequestSchema); if (!b.ok) return b.res;
    const have = new Set((await db.query<{ key: string }>("SELECT key FROM assets WHERE key = ANY($1) AND status = 'available'", [b.data.keys])).map((r) => r.key));
    return c.json({ present: b.data.keys.filter((k) => have.has(k)), missing: b.data.keys.filter((k) => !have.has(k)) });
  });

  app.post('/v1/uploads', async (c) => {
    const denied = writer(c); if (denied) return denied;
    const b = await body(c, uploadRequestSchema); if (!b.ok) return b.res;
    const { key, sha256, type, size } = b.data;
    if (c1FromSha256(`sha256:${sha256}`) !== key) return fail(c, 400, 'invalid', 'key is not the c1 key of sha256');
    if (!matchesType(types, type)) return fail(c, 415, 'unsupported_type', `${type} is not accepted here`);
    if (size > maxBytes) return fail(c, 413, 'too_large', `at most ${maxBytes} bytes`);
    const existing = await rowOf(key);
    if (existing?.status === 'withdrawn') return fail(c, 410, 'gone', 'this asset was withdrawn');
    if (existing?.status === 'available') return c.json({ exists: true, asset: await record(existing, true) });
    await ensureStore();
    if (!existing) await db.query("INSERT INTO assets (key, sha256, type, size, filename, status, uploaded_by) VALUES ($1, $2, $3, $4, $5, 'pending', $6) ON CONFLICT (key) DO NOTHING", [key, sha256, type, size, b.data.filename ?? null, c.get('caller')!.user]);
    const up = await storage.presignPut(standardPath(key), storedType(type), size, UPLOAD_SECONDS);
    return c.json({ upload: { url: up.url, method: 'PUT', headers: up.headers, expiresAt: new Date(Date.now() + UPLOAD_SECONDS * 1000).toISOString() }, store: 'library' });
  });

  // a disk library takes uploads itself (an S3 bucket takes them at its pre-signed URL)
  app.put('/v1/upload/:ticket', async (c) => {
    if (!disk) return fail(c, 404, 'not_found', 'uploads go to the bucket');
    const t = disk.ticket(c.req.param('ticket'));
    if (!t) return fail(c, 403, 'forbidden', 'this upload link is not valid or has expired');
    if (!c.req.raw.body) return fail(c, 400, 'invalid', 'no bytes');
    try { await disk.write(t.path, c.req.raw.body, Math.min(maxBytes, t.size)); } catch { return fail(c, 413, 'too_large', 'more bytes than announced'); }
    return c.body(null, 200);
  });

  app.post('/v1/assets', async (c) => {
    const denied = writer(c); if (denied) return denied;
    const b = await body(c, registerRequestSchema); if (!b.ok) return b.res;
    const d = b.data, path = standardPath(d.key);
    if (c1FromSha256(`sha256:${d.sha256}`) !== d.key) return fail(c, 400, 'invalid', 'key is not the c1 key of sha256');
    let row = await rowOf(d.key);
    if (row?.status === 'withdrawn') return fail(c, 410, 'gone', 'this asset was withdrawn');
    if (!row || row.status === 'pending') {
      // the bytes must be there, the size announced, and the content the key says (spec registry-api §3.4)
      const head = await storage.head(path);
      if (!head) return fail(c, 409, 'conflict', 'nothing was uploaded for this key');
      const sum = await sha256Of(storage, path);
      if (head.size !== d.size || sum !== d.sha256) {
        await storage.remove(path);
        await db.query("DELETE FROM assets WHERE key = $1 AND status = 'pending'", [d.key]);
        return fail(c, 422, 'verification_failed', 'the uploaded bytes are not the ones this key names');
      }
      await ensureStore();
      await db.query(`INSERT INTO assets (key, sha256, type, size, status, uploaded_by) VALUES ($1, $2, $3, $4, 'available', $5)
        ON CONFLICT (key) DO UPDATE SET status = 'available', type = EXCLUDED.type, size = EXCLUDED.size`, [d.key, d.sha256, d.type, d.size, c.get('caller')!.user]);
      await db.query('INSERT INTO locations (key, store, path, verified_at) VALUES ($1, $2, $3, now()) ON CONFLICT (key, store) DO UPDATE SET verified_at = now()', [d.key, 'library', path]);
    }
    // the descriptive fields: set on registering, updated on registering again
    await db.query(`UPDATE assets SET title = COALESCE($2, title), filename = COALESCE($3, filename), tags = COALESCE($4, tags), subject = COALESCE($5, subject),
      license = COALESCE($6, license), width = COALESCE($7, width), height = COALESCE($8, height), duration = COALESCE($9, duration), pages = COALESCE($10, pages),
      poster = COALESCE($11, poster), updated_at = now() WHERE key = $1`,
    [d.key, d.title ?? null, d.filename ?? null, d.tags ?? null, d.subject ?? null, d.license ?? null, d.meta?.width ?? null, d.meta?.height ?? null, d.meta?.duration ?? null, d.meta?.pages ?? null,
      d.poster && (await rowOf(d.poster)) ? d.poster : null]);
    for (const r of d.renditions ?? []) if (await rowOf(r)) await db.query('INSERT INTO renditions (primary_key, rendition) VALUES ($1, $2) ON CONFLICT DO NOTHING', [d.key, r]);
    row = await rowOf(d.key);
    return c.json(await record(row!, true));
  });

  // ---- §4 reading ----
  app.get('/v1/assets/:key', async (c) => {
    const denied = reader(c); if (denied) return denied;
    const row = await rowOf(c.req.param('key'));
    return row && row.status !== 'pending' ? c.json(await record(row, Boolean(c.get('caller')))) : fail(c, 404, 'not_found', 'no such asset');
  });
  app.post('/v1/assets/batch', async (c) => {
    const denied = reader(c); if (denied) return denied;
    const b = await body(c, checkRequestSchema); if (!b.ok) return b.res;
    const rows = await db.query<Row>("SELECT * FROM assets WHERE key = ANY($1) AND status <> 'pending'", [b.data.keys]);
    return c.json({ items: await Promise.all(rows.map((r) => record(r, Boolean(c.get('caller'))))) });
  });

  // ---- §5 search: trigram similarity, any script; newest first without words ----
  app.get('/v1/search', async (c) => {
    const denied = reader(c); if (denied) return denied;
    const q = c.req.query('q')?.trim(), limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 30) || 30)), offset = Number(c.req.query('cursor') ?? 0) || 0;
    const where = ["status = 'available'"], params: unknown[] = [];
    const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
    if (q) where.push(`(${p(q)} <% search_text OR search_text ILIKE ${p(`%${q.replace(/[%_\\]/g, '\\$&')}%`)})`);
    const typePats = c.req.queries('type') ?? [];
    if (typePats.length) where.push(`(${typePats.map((t) => (t.endsWith('/*') ? `type LIKE ${p(t.slice(0, -1) + '%')}` : `type = ${p(t)}`)).join(' OR ')})`);
    if (c.req.query('subject')) where.push(`subject = ${p(c.req.query('subject'))}`);
    for (const tag of c.req.queries('tag') ?? []) where.push(`${p(tag)} = ANY(tags)`);
    if (c.req.query('mine') === '1' && c.get('caller')) where.push(`uploaded_by = ${p(c.get('caller')!.user)}`);
    if (c.req.query('book')) where.push(`key IN (SELECT key FROM book_assets WHERE book_id = ${p(c.req.query('book'))})`);
    if (c.req.query('minDuration')) where.push(`duration >= ${p(Number(c.req.query('minDuration')))}`);
    if (c.req.query('maxDuration')) where.push(`duration <= ${p(Number(c.req.query('maxDuration')))}`);
    if (c.req.query('minWidth')) where.push(`width >= ${p(Number(c.req.query('minWidth')))}`);
    const order = q ? `word_similarity($1, search_text) DESC, created_at DESC` : 'created_at DESC';
    const rows = await db.query<Row>(`SELECT * FROM assets WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ${limit + 1} OFFSET ${offset}`, params);
    const items = await Promise.all(rows.slice(0, limit).map((r) => record(r, false)));
    return c.json(rows.length > limit ? { items, next: String(offset + limit) } : { items });
  });

  // ---- §6 books ----
  app.put('/v1/books/:book/assets', async (c) => {
    const denied = writer(c); if (denied) return denied;
    const b = await body(c, checkRequestSchema.partial({ keys: true })); if (!b.ok) return b.res;
    const book = c.req.param('book'), keys = (b.data.keys ?? []).filter(isC1Key);
    await db.query('DELETE FROM book_assets WHERE book_id = $1', [book]);
    const known = (await db.query<{ key: string }>('SELECT key FROM assets WHERE key = ANY($1)', [keys])).map((r) => r.key);
    for (const k of known) await db.query('INSERT INTO book_assets (book_id, key) VALUES ($1, $2) ON CONFLICT DO NOTHING', [book, k]);
    return c.json({ book, keys: known.length });
  });
  app.get('/v1/assets/:key/books', async (c) => {
    const denied = reader(c); if (denied) return denied;
    const rows = await db.query<{ book_id: string; updated_at: string | Date }>('SELECT book_id, updated_at FROM book_assets WHERE key = $1 ORDER BY updated_at DESC', [c.req.param('key')]);
    return c.json({ items: rows.map((r) => ({ bookId: r.book_id, updatedAt: new Date(r.updated_at).toISOString() })) });
  });

  // ---- §8 withdrawing ----
  app.post('/v1/assets/:key/withdraw', async (c) => {
    if (!c.get('caller')?.admin) return fail(c, 403, 'forbidden', 'only an administrator can withdraw');
    const key = c.req.param('key'), row = await rowOf(key);
    if (!row) return fail(c, 404, 'not_found', 'no such asset');
    const used = await db.query('SELECT 1 FROM book_assets WHERE key = $1 LIMIT 1', [key]);
    const reason = ((await c.req.json().catch(() => ({}))) as { reason?: string }).reason ?? null;
    await db.query("UPDATE assets SET status = 'withdrawn', withdrawn_reason = $2, updated_at = now() WHERE key = $1", [key, reason]);
    await storage.remove(standardPath(key));
    return c.json({ key, status: 'withdrawn', usedByBooks: used.length > 0 });
  });

  // ---- a disk library delivers its own files (readers' store): immutable, ranges for video ----
  app.get('/files/*', async (c) => {
    if (!disk) return c.notFound();
    const path = decodeURIComponent(c.req.path.slice('/files/'.length));
    if (!/^c1\/[a-z2-7]{2}\/[a-z2-7]{2}\/[a-z2-7]{25}[aeimquy4]$/.test(path)) return c.notFound();
    const row = await rowOf(`c1:${path.split('/').pop()}`);
    const file = row?.status === 'available' ? disk.file(path) : null;
    if (!file) return c.body(row?.status === 'withdrawn' ? 'gone' : 'not found', row?.status === 'withdrawn' ? 410 : 404);
    const size = statSync(file).size, range = /bytes=(\d*)-(\d*)/.exec(c.req.header('range') ?? '');
    const headers: Record<string, string> = {
      'Content-Type': storedType(row!.type), 'Cache-Control': 'public, max-age=31536000, immutable', 'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': 'sandbox',
    };
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2])), end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
      if (start >= size || start > end) return c.body(null, 416, { 'Content-Range': `bytes */${size}` });
      return c.body(Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream, 206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) });
    }
    return c.body(Readable.toWeb(createReadStream(file)) as ReadableStream, 200, { ...headers, 'Content-Length': String(size) });
  });

  // an error the API did not expect: logged for the operator, a plain answer for the caller
  app.onError((e, c) => { console.error(`${c.req.method} ${c.req.path}:`, e); return fail(c, 500, 'internal', 'the library could not do that'); });

  app.get('/healthz', async (c) => { await db.query('SELECT 1'); return c.json({ ok: true, name: o.name ?? 'Chalk library' }); });
  return app;
}

/** The SHA-256 of an object, read as a stream (a video is never held in memory). */
export async function sha256Of(storage: Storage, path: string): Promise<string | null> {
  const s = await storage.read(path); if (!s) return null;
  const h = createHash('sha256');
  for await (const chunk of s as unknown as AsyncIterable<Uint8Array>) h.update(chunk);
  return h.digest('hex');
}
