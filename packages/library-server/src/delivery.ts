import { createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import type { Context, Hono } from 'hono';
import { isC1Key, type StoreDescriptor } from '@chalk-format/model';
import { standardPath } from '@chalk-format/store';
import type { LibraryOptions } from './app.js';
import { requireRole, type AuthVariables } from './auth/guard.js';
import { contentDisposition, servedType, type DiskStorage } from './storage.js';

/**
 * File bytes for signed-in readers (spec/1.2/registry-api.md §7.1). With PUBLIC_READ=false the bucket is private
 * and readers get bytes only through this server:
 *
 *   GET /v1/files/{key}        (bearer, role reader) S3: 302 to a pre-signed GET URL valid 5 minutes; disk: the bytes, with ranges
 *   GET /v1/assets/{key}/link  (bearer, role reader) { url, expiresAt }: a URL that needs no header (an <img>, <video>, a lab iframe), 15 minutes
 *   GET /v1/stores             names `<base>/v1/files/{h}` with auth "bearer"
 *   GET /files/*               (disk) only signed links: 403 without a valid one, 410 for a withdrawn key
 *
 * With PUBLIC_READ=true (the default) `/v1/stores` and `/files/*` are left to app.ts as they were; the two new
 * routes work too, open to anyone like the rest of a public library's reading.
 *
 * Code is never served as a page: HTML and JavaScript go out as `application/octet-stream` (S3: fixed in the
 * signature with `response-content-type`), and the server's own answers add `Content-Security-Policy: sandbox`
 * and `nosniff`, so a signed link cannot make a lab's HTML run on the library's origin.
 */
export type DeliveryOptions = {
  /** This server's public address, for the store `GET /v1/stores` names (SERVER_URL). Default: the request's own. */
  serverUrl?: string;
};

/** A pre-signed URL behind `GET /v1/files/{key}`, and how long the redirect to it may be kept (less, so it is never stale). */
export const FILE_SECONDS = 5 * 60;
export const FILE_REDIRECT_CACHE = 'private, max-age=240';
/** A link for places that cannot send a header (the contract allows 5 to 15 minutes; a video plays from it). */
export const LINK_SECONDS = 15 * 60;

/**
 * A token's answer is kept for that token only: without Vary a browser would answer a later request with no
 * token (after signing out) from its cache. Origin too, as the API's CORS headers depend on it.
 */
const BY_TOKEN = 'Authorization, Origin';
/** CORS for signed links: the URL is the credential, so any page may read the answer. */
const ANY_ORIGIN = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Length, Content-Range' };
const PATH = /^c1\/[a-z2-7]{2}\/[a-z2-7]{2}\/[a-z2-7]{25}[aeimquy4]$/;
/** `c1:…` or the hash part alone (the `{h}` of the template). */
const keyOf = (s: string) => { const k = s.startsWith('c1:') ? s : `c1:${s}`; return isC1Key(k) ? k : null; };

export function registerDelivery(app: Hono<{ Variables: AuthVariables }>, o: LibraryOptions & DeliveryOptions) {
  const publicRead = o.publicRead !== false;
  const disk = 'ticket' in o.storage ? (o.storage as DiskStorage) : null;
  const fail = (c: Context, status: number, code: string, message: string) => c.json({ error: { code, message } }, status as never);
  const assetOf = async (key: string) => (await o.db.query<{ type: string; status: string }>('SELECT type, status FROM assets WHERE key = $1', [key]))[0] ?? null;
  /** The record behind a key the caller may read, or the answer to send instead. */
  const available = async (c: Context, raw: string) => {
    const key = keyOf(raw), row = key ? await assetOf(key) : null;
    if (row?.status === 'withdrawn') return { res: fail(c, 410, 'gone', 'this asset was withdrawn') };
    if (!key || row?.status !== 'available') return { res: fail(c, 404, 'not_found', 'no such asset') };
    return { key, path: standardPath(key), type: row.type };
  };
  // only X-Forwarded-Proto is taken from the request (a proxy's TLS); the host is the one the request reached
  const base = (c: Context) => {
    if (o.serverUrl) return o.serverUrl.replace(/\/+$/, '');
    const u = new URL(c.req.url), proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim();
    return `${proto === 'https' || proto === 'http' ? proto : u.protocol.slice(0, -1)}://${u.host}`;
  };

  // ---- the store readers use: a private library's names this server, with a token ----
  app.get('/v1/stores', async (c, next) => {
    if (publicRead) return next();
    const store: StoreDescriptor = { id: 'library', kind: 'derived', template: `${base(c)}/v1/files/{h}`, auth: 'bearer' };
    // shared caches only when the address is configured (a derived one depends on the request)
    c.header('Cache-Control', o.serverUrl ? 'public, max-age=300' : 'private, max-age=300');
    return c.json({ items: [store] });
  });

  app.get('/v1/files/:key', async (c) => {
    const denied = requireRole(c, 'reader'); if (denied) return denied; // a public library lets anyone through
    const a = await available(c, c.req.param('key')); if ('res' in a) return a.res;
    if (disk) {
      const file = disk.file(a.path);
      return file ? serveFile(c, file, a.type, { 'Cache-Control': 'private, max-age=31536000, immutable', Vary: BY_TOKEN }) : fail(c, 404, 'not_found', 'no such asset');
    }
    // the bearer header is not sent on to the bucket: fetch drops Authorization on a redirect to another origin
    const { url } = await o.storage.presignGet(a.path, FILE_SECONDS, { contentType: a.type });
    return c.body(null, 302, { Location: url, 'Cache-Control': FILE_REDIRECT_CACHE, Vary: BY_TOKEN, 'Referrer-Policy': 'no-referrer' });
  });

  app.get('/v1/assets/:key/link', async (c) => {
    const denied = requireRole(c, 'reader'); if (denied) return denied; // a public library lets anyone through
    const a = await available(c, c.req.param('key')); if ('res' in a) return a.res;
    const link = await o.storage.presignGet(a.path, LINK_SECONDS, { contentType: a.type });
    // a disk link is this server's /files/: at the address the request reached unless SERVER_URL says (the signature does not cover the host)
    if (disk && !o.serverUrl) { const u = new URL(link.url), b = new URL(base(c)); u.protocol = b.protocol; u.host = b.host; link.url = u.href; }
    return c.json(link, 200, { 'Cache-Control': 'no-store' });
  });

  // ---- a private disk library: /files/ serves signed links only ----
  // a signed link's URL is its credential, so it is cached by URL; it is used from any page (an <img>, a fetch)
  // a range a browser does not safelist (bytes=-N) is preflighted: allowed from any page, as the link itself is
  app.options('/files/*', (c, next) => (publicRead || !disk ? next() : c.body(null, 204, {
    'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD', 'Access-Control-Allow-Headers': 'Range', 'Access-Control-Max-Age': '86400',
  })));
  app.get('/files/*', async (c, next) => {
    if (publicRead || !disk) return next();
    // every answer, errors included, is readable from any page: a reader tells an expired link (403) from a withdrawn file (410)
    const refuse = (status: 403 | 404 | 410, text: string) => c.text(text, status, { ...ANY_ORIGIN, 'Cache-Control': 'no-store' });
    let path: string;
    try { path = decodeURIComponent(c.req.path.slice('/files/'.length)); } catch { return refuse(404, 'not found'); }
    if (!PATH.test(path)) return refuse(404, 'not found');
    const signed = disk.link(path, { exp: c.req.query('exp'), sig: c.req.query('sig'), fn: c.req.query('fn') });
    if (!signed) return refuse(403, 'this link is not valid or has expired');
    const row = await assetOf(`c1:${path.split('/').pop()}`);
    const file = row?.status === 'available' ? disk.file(path) : null;
    if (!file) return row?.status === 'withdrawn' ? refuse(410, 'gone') : refuse(404, 'not found');
    return serveFile(c, file, row!.type, {
      // kept no longer than the link is valid
      'Cache-Control': `private, max-age=${Math.max(0, Number(c.req.query('exp')) - Math.floor(Date.now() / 1000))}`, ...ANY_ORIGIN,
      ...(signed.filename ? { 'Content-Disposition': contentDisposition(signed.filename) } : {}),
    });
  });
}

/** One file from the disk, whole or a range (video), never as a web page. */
function serveFile(c: Context, file: string, type: string, extra: Record<string, string>) {
  const size = statSync(file).size, range = /bytes=(\d*)-(\d*)/.exec(c.req.header('range') ?? '');
  const headers: Record<string, string> = {
    'Content-Type': servedType(type), 'Accept-Ranges': 'bytes',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': 'sandbox',
    'Referrer-Policy': 'no-referrer', ...extra,
  };
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2])), end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
    // the size is readable cross-origin too (the CORS headers of `extra`)
    if (start >= size || start > end) return c.body(null, 416, { ...Object.fromEntries(Object.entries(headers).filter(([k]) => k.startsWith('Access-Control-'))), 'Content-Range': `bytes */${size}` });
    return c.body(Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream, 206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) });
  }
  return c.body(Readable.toWeb(createReadStream(file)) as ReadableStream, 200, { ...headers, 'Content-Length': String(size) });
}
