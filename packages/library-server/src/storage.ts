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
  head(path: string): Promise<{ size: number } | null>;
  /** The object's bytes as a stream (for hashing without holding it in memory), or null. */
  read(path: string): Promise<ReadableStream<Uint8Array> | null>;
  /** Every object below a prefix (for scanning a bucket that already has media). */
  list(prefix?: string): AsyncIterable<{ path: string; size: number }>;
  copy(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

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
 */
export type DiskStorage = Storage & {
  /** Check an upload ticket; the path it allows, or null. */
  ticket(t: string): { path: string; type: string; size: number } | null;
  write(path: string, body: ReadableStream<Uint8Array>, maxBytes: number): Promise<number>;
  file(path: string): string | null;
};

export function diskStorage(dir: string, o: { uploadBase: string; secret?: string }): DiskStorage {
  const secret = o.secret ?? randomBytes(32).toString('hex');
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
