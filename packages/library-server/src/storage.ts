import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, statSync, unlinkSync, copyFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AwsClient } from 'aws4fetch';

/**
 * Where a library keeps bytes. Only standard S3 calls (pre-signed PUT, HEAD, GET, ListObjectsV2, CopyObject,
 * DELETE), so the same code serves Cloudflare R2, MinIO, AWS S3 and any S3-compatible service; or a folder on
 * the server's disk for small setups and tests.
 */
export interface Storage {
  readonly id: string;
  /** Where the author's tool uploads one object: a URL to PUT the bytes to directly, with these headers. */
  presignPut(path: string, type: string, size: number, expiresSeconds: number): Promise<{ url: string; headers: Record<string, string> }>;
  /**
   * A short-lived URL that GETs one object with no other credential (a private library's readers, spec
   * registry-api §7.1): S3 pre-signs it, a folder signs it with the server's link secret. The URL carries no
   * bearer token. `contentType` is what the response says (code is always made `application/octet-stream`).
   */
  presignGet(path: string, expiresSeconds: number, o: GetOptions): Promise<{ url: string; expiresAt: string }>;
  head(path: string): Promise<{ size: number } | null>;
  /** The object's bytes as a stream (for hashing without holding it in memory), or null. */
  read(path: string): Promise<ReadableStream<Uint8Array> | null>;
  /** Every object below a prefix (for scanning a bucket that already has media). */
  list(prefix?: string): AsyncIterable<{ path: string; size: number }>;
  copy(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export type GetOptions = { contentType: string; filename?: string };

/**
 * The type a file is served as. Code is served as plain bytes: a lab's HTML or a library's script must never run
 * as a page or script on a domain of ours (or the bucket's). The type comes from a record anyone with a token
 * registered, so it is normalised first (" TEXT/HTML; x" is HTML), and anything that is not one plain media type
 * is plain bytes too.
 */
export function servedType(type: string): string {
  const t = type.split(';')[0]!.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(t)) return 'application/octet-stream';
  return /^(text\/(html|javascript|ecmascript|xml|xsl)|application\/(javascript|ecmascript|x-javascript|xhtml\+xml|xml|xslt\+xml))$/.test(t) ? 'application/octet-stream' : t;
}
/** `inline` with the file name, RFC 6266 / 5987 (any script). */
export const contentDisposition = (filename: string) => `inline; filename*=UTF-8''${encodeURIComponent(filename.replace(/[\r\n"\\/]/g, '_'))}`;
/** S3 accepts 1 s to 7 days for a pre-signed URL. */
const clampSeconds = (s: number) => Math.min(604_800, Math.max(1, Math.floor(s)));

// ---------- S3-compatible ----------

export type S3Options = {
  /** e.g. https://<account>.r2.cloudflarestorage.com, http://minio:9000, https://s3.eu-central-1.amazonaws.com */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** R2: "auto". */
  region?: string;
  /** Bucket in the host name (AWS virtual-hosted style) instead of the path (R2, MinIO). Default false. */
  virtualHosted?: boolean;
  fetch?: typeof fetch;
};

export function s3Storage(o: S3Options): Storage {
  const aws = new AwsClient({ accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey, service: 's3', region: o.region ?? 'auto' });
  const doFetch = o.fetch ?? globalThis.fetch.bind(globalThis);
  const base = o.endpoint.replace(/\/+$/, '');
  const objectUrl = (path: string) => {
    const key = path.split('/').map(encodeURIComponent).join('/');
    if (!o.virtualHosted) return `${base}/${o.bucket}/${key}`;
    const u = new URL(base); u.hostname = `${o.bucket}.${u.hostname}`; return `${u.origin}/${key}`;
  };
  const bucketUrl = () => (o.virtualHosted ? (() => { const u = new URL(base); u.hostname = `${o.bucket}.${u.hostname}`; return u.origin + '/'; })() : `${base}/${o.bucket}/`);
  const send = async (url: string, init: RequestInit = {}) => doFetch(await aws.sign(url, init) as Request);
  return {
    id: `s3:${o.bucket}`,
    async presignPut(path, type, _size, expiresSeconds) {
      const u = new URL(objectUrl(path));
      u.searchParams.set('X-Amz-Expires', String(expiresSeconds));
      const signed = await aws.sign(new Request(u, { method: 'PUT', headers: { 'Content-Type': type } }), { aws: { signQuery: true } });
      return { url: signed.url, headers: { 'Content-Type': type } };
    },
    async presignGet(path, expiresSeconds, g) {
      // the response's type and name are fixed by the signature (response-* parameters), not by whoever holds the URL
      const seconds = clampSeconds(expiresSeconds), u = new URL(objectUrl(path));
      u.searchParams.set('X-Amz-Expires', String(seconds));
      u.searchParams.set('response-content-type', servedType(g.contentType));
      // a browser keeps the bytes no longer than the URL is valid (the bucket's own Cache-Control may say a year)
      u.searchParams.set('response-cache-control', `private, max-age=${seconds}`);
      if (g.filename) u.searchParams.set('response-content-disposition', contentDisposition(g.filename));
      const signed = await aws.sign(new Request(u, { method: 'GET' }), { aws: { signQuery: true } });
      return { url: signed.url, expiresAt: new Date(Date.now() + seconds * 1000).toISOString() };
    },
    async head(path) {
      const r = await send(objectUrl(path), { method: 'HEAD' });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`storage HEAD ${r.status}`);
      return { size: Number(r.headers.get('content-length') ?? 0) };
    },
    async read(path) {
      const r = await send(objectUrl(path));
      if (r.status === 404) return null;
      if (!r.ok || !r.body) throw new Error(`storage GET ${r.status}`);
      return r.body;
    },
    async *list(prefix = '') {
      let token: string | undefined;
      do {
        const u = new URL(bucketUrl());
        u.searchParams.set('list-type', '2');
        if (prefix) u.searchParams.set('prefix', prefix);
        if (token) u.searchParams.set('continuation-token', token);
        const r = await send(u.href);
        if (!r.ok) throw new Error(`storage LIST ${r.status}`);
        const xml = await r.text();
        for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const key = /<Key>([\s\S]*?)<\/Key>/.exec(m[1]!)?.[1], size = /<Size>(\d+)<\/Size>/.exec(m[1]!)?.[1];
          if (key) yield { path: unxml(key), size: Number(size ?? 0) };
        }
        token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? unxml(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] ?? '') || undefined : undefined;
      } while (token);
    },
    async copy(from, to) {
      // server-side copy: the bytes never leave the bucket
      const source = `/${o.bucket}/${from.split('/').map(encodeURIComponent).join('/')}`;
      const r = await send(objectUrl(to), { method: 'PUT', headers: { 'x-amz-copy-source': source } });
      if (!r.ok) throw new Error(`storage COPY ${r.status}`);
    },
    async remove(path) {
      const r = await send(objectUrl(path), { method: 'DELETE' });
      if (!r.ok && r.status !== 404) throw new Error(`storage DELETE ${r.status}`);
    },
  };
}
const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// ---------- a folder on the server ----------

/**
 * Files in a folder on the server. Uploads come to the server itself (`PUT /v1/upload/{ticket}`, a signed,
 * short-lived ticket), and the files are served from `/files/`. For one machine, a school server, and tests.
 * A private library's file links are `/files/{path}?exp=&sig=` (and `fn=`), signed with `linkSecret`.
 */
export type DiskStorage = Storage & {
  /** Check an upload ticket; the path it allows, or null. */
  ticket(t: string): { path: string; type: string; size: number } | null;
  /** Check a file link's query (`exp`, `sig`, `fn`) for this path: the file name it was signed with, or null if it is not valid or has expired. */
  link(path: string, q: { exp?: string | undefined; sig?: string | undefined; fn?: string | undefined }): { filename?: string } | null;
  write(path: string, body: ReadableStream<Uint8Array>, maxBytes: number): Promise<number>;
  file(path: string): string | null;
};

/**
 * `secret` signs upload tickets (default: random at start). `linkSecret` signs file links (default: derived from
 * `secret`, so FILE_LINK_SECRET or else UPLOAD_SECRET keeps links valid across restarts and instances).
 * `filesBase`: where `/files/` is (default `<uploadBase>/files/`).
 */
export function diskStorage(dir: string, o: { uploadBase: string; secret?: string; linkSecret?: string; filesBase?: string }): DiskStorage {
  const secret = o.secret ?? randomBytes(32).toString('hex');
  const linkSecret = o.linkSecret ?? createHmac('sha256', secret).update('chalk file links').digest('hex');
  const filesBase = (o.filesBase ?? `${o.uploadBase.replace(/\/+$/, '')}/files/`).replace(/\/?$/, '/');
  const linkMac = (path: string, exp: string, fn: string) => createHmac('sha256', linkSecret).update(`GET\n${path}\n${exp}\n${fn}`).digest('base64url');
  const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
  const at = (path: string) => {
    const p = join(dir, ...path.split('/'));
    if (relative(dir, p).startsWith('..') || path.split('/').includes('..')) throw new Error('path outside the library');
    return p;
  };
  const sign = (s: string) => createHmac('sha256', secret).update(s).digest('base64url');
  return {
    id: `disk:${dir}`,
    async presignPut(path, type, size, expiresSeconds) {
      const body = Buffer.from(JSON.stringify({ path, type, size, exp: Date.now() + expiresSeconds * 1000 })).toString('base64url');
      return { url: `${o.uploadBase.replace(/\/$/, '')}/v1/upload/${body}.${sign(body)}`, headers: { 'Content-Type': type } };
    },
    async presignGet(path, expiresSeconds, g) {
      // the type comes from the record when the file is served; the name is signed with the link
      at(path);
      const seconds = clampSeconds(expiresSeconds), exp = String(Math.floor(Date.now() / 1000) + seconds);
      const q = new URLSearchParams({ exp });
      if (g.filename) q.set('fn', g.filename);
      q.set('sig', linkMac(path, exp, g.filename ?? ''));
      return { url: `${filesBase}${path.split('/').map(encodeURIComponent).join('/')}?${q}`, expiresAt: new Date(Number(exp) * 1000).toISOString() };
    },
    link(path, q) {
      if (!q.exp || !q.sig || !/^\d{1,12}$/.test(q.exp)) return null;
      if (!same(linkMac(path, q.exp, q.fn ?? ''), q.sig)) return null;
      if (Number(q.exp) * 1000 <= Date.now()) return null;
      return q.fn ? { filename: q.fn } : {};
    },
    ticket(t) {
      const [body, mac] = t.split('.');
      if (!body || !mac) return null;
      const want = Buffer.from(sign(body)), got = Buffer.from(mac);
      if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
      const v = JSON.parse(Buffer.from(body, 'base64url').toString()) as { path: string; type: string; size: number; exp: number };
      return v.exp > Date.now() ? { path: v.path, type: v.type, size: v.size } : null;
    },
    async write(path, body, maxBytes) {
      const p = at(path); mkdirSync(dirname(p), { recursive: true });
      let n = 0;
      const limited = Readable.fromWeb(body as never).on('data', (c: Buffer) => { n += c.length; if (n > maxBytes) limited.destroy(new Error('too large')); });
      await pipeline(limited, createWriteStream(p));
      return n;
    },
    async head(path) { try { return { size: statSync(at(path)).size }; } catch { return null; } },
    async read(path) { try { statSync(at(path)); return Readable.toWeb(createReadStream(at(path))) as ReadableStream<Uint8Array>; } catch { return null; } },
    async *list(prefix = '') {
      const walk = function* (d: string): Generator<string> {
        for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) yield* walk(p); else yield p; }
      };
      try { for (const p of walk(dir)) { const rel = relative(dir, p).split(sep).join('/'); if (rel.startsWith(prefix)) yield { path: rel, size: statSync(p).size }; } } catch { /* empty */ }
    },
    async copy(from, to) { const t = at(to); mkdirSync(dirname(t), { recursive: true }); copyFileSync(at(from), t); },
    async remove(path) { try { unlinkSync(at(path)); } catch { /* gone already */ } },
    file(path) { try { const p = at(path); statSync(p); return p; } catch { return null; } },
  };
}
