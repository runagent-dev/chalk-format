import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { AwsClient } from 'aws4fetch';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRegistryClient } from '@chalk-format/store';
import { createLibraryApp, openDb, s3Storage, servedType, tokenCallers, type Db } from './index.js';

// A private S3 bucket and a private library, both real HTTP servers on this machine, used with Node's own fetch
// (so redirects are followed as a reader's fetch follows them). The bucket checks every pre-signed URL's
// signature and expiry the way S3 does, and refuses anything unsigned: it is private.
const CREDS = { accessKeyId: 'AKIDTESTLIBRARY', secretAccessKey: 'test-secret-key-never-in-a-url' };
const LAB = '<!doctype html><script>alert(1)</script>';
const objects = new Map<string, { bytes: Uint8Array; type: string }>();
const seen: { url: string; authorization: string | null }[] = [];
const aws = new AwsClient({ ...CREDS, service: 's3', region: 'auto' });
let db: Db, s3: ServerType, lib: ServerType, S3: string, BASE: string;
let key: string, h: string;

const amzTime = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +d.slice(9, 11), +d.slice(11, 13), +d.slice(13, 15));
async function presignedOk(req: Request) {
  const u = new URL(req.url), q = u.searchParams;
  const sig = q.get('X-Amz-Signature'), date = q.get('X-Amz-Date'), expires = Number(q.get('X-Amz-Expires'));
  if (!sig || !date || !expires) return false;
  if (Date.now() > amzTime(date) + expires * 1000) return false;
  const plain = new URL(u);
  for (const k of ['X-Amz-Signature', 'X-Amz-Algorithm', 'X-Amz-Credential', 'X-Amz-Date', 'X-Amz-SignedHeaders']) plain.searchParams.delete(k);
  const again = await aws.sign(new Request(plain, { method: req.method }), { aws: { signQuery: true, datetime: date } });
  return new URL(again.url).searchParams.get('X-Amz-Signature') === sig;
}
async function bucket(req: Request): Promise<Response> {
  const u = new URL(req.url);
  seen.push({ url: req.url, authorization: req.headers.get('authorization') });
  const presigned = u.searchParams.has('X-Amz-Signature');
  // the server's own calls are header-signed; readers' are pre-signed; nothing else gets in
  if (presigned ? !(await presignedOk(req)) : !req.headers.get('authorization')?.startsWith('AWS4-HMAC-SHA256 ')) return new Response('AccessDenied', { status: 403 });
  const k = decodeURIComponent(u.pathname);
  if (req.method === 'PUT') { objects.set(k, { bytes: new Uint8Array(await req.arrayBuffer()), type: req.headers.get('content-type') ?? 'application/octet-stream' }); return new Response(null, { status: 200 }); }
  if (req.method === 'DELETE') { objects.delete(k); return new Response(null, { status: 204 }); }
  const o = objects.get(k);
  if (!o) return new Response('NoSuchKey', { status: 404 });
  const headers = {
    'Content-Type': u.searchParams.get('response-content-type') ?? o.type, 'Content-Length': String(o.bytes.length),
    ...(u.searchParams.get('response-content-disposition') ? { 'Content-Disposition': u.searchParams.get('response-content-disposition')! } : {}),
  };
  return new Response(req.method === 'HEAD' ? null : (o.bytes as unknown as BodyInit), { status: 200, headers });
}
const listen = (fetch: (r: Request) => Response | Promise<Response>) => new Promise<{ server: ServerType; url: string }>((done) => {
  const server = serve({ fetch, port: 0, hostname: '127.0.0.1' }, (i: AddressInfo) => done({ server, url: `http://127.0.0.1:${i.port}` }));
});

beforeAll(async () => {
  db = await openDb('pglite:');
  ({ server: s3, url: S3 } = await listen(bucket));
  const storage = s3Storage({ endpoint: S3, bucket: 'books', ...CREDS });
  let app: ReturnType<typeof createLibraryApp> | null = null;
  ({ server: lib, url: BASE } = await listen((r) => app!.fetch(r)));
  app = createLibraryApp({ db, storage, publicUrl: 'https://assets.example.org/', callers: tokenCallers('teacher:t-1,admin!:a-1'), publicRead: false });
  const rec = await createRegistryClient(BASE, { token: 't-1' }).add(new TextEncoder().encode(LAB), { type: 'text/html', title: 'lab', filename: 'lab.html' });
  key = rec.key; h = key.slice(3);
}, 60_000);
afterAll(async () => { s3?.close(); lib?.close(); await db?.close(); });
afterEach(() => { vi.useRealTimers(); });

const bearer = (t = 't-1') => ({ Authorization: `Bearer ${t}` });

describe('presignGet on S3 storage', () => {
  it('is a pre-signed GET with the expiry asked for, a safe type, and no secret or token in it', async () => {
    const s = s3Storage({ endpoint: 'https://acct.r2.cloudflarestorage.com/', bucket: 'books', ...CREDS });
    const { url, expiresAt } = await s.presignGet('c1/ab/cd/abcd', 300, { contentType: 'text/html', filename: 'lab.html' });
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe('https://acct.r2.cloudflarestorage.com/books/c1/ab/cd/abcd');
    expect(u.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(u.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(u.searchParams.get('response-content-type')).toBe('application/octet-stream');
    expect(u.searchParams.get('response-content-disposition')).toBe("inline; filename*=UTF-8''lab.html");
    expect(u.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(url).not.toContain(CREDS.secretAccessKey);
    expect(url).not.toMatch(/bearer|token/i);
    expect(Math.abs(Date.parse(expiresAt) - Date.now() - 300_000)).toBeLessThan(2000);
    expect(new URL((await s.presignGet('x', 10 ** 9, { contentType: 'image/png' })).url).searchParams.get('X-Amz-Expires')).toBe('604800');
    expect(new URL((await s.presignGet('x', 60, { contentType: 'image/png' })).url).searchParams.get('response-content-type')).toBe('image/png');
    // cached until the URL ends, not for its lifetime from whenever it was fetched
    expect(u.searchParams.get('response-cache-control')).toBe('private');
    expect(Date.parse(u.searchParams.get('response-expires')!)).toBe(Math.floor(Date.parse(expiresAt) / 1000) * 1000);
    // an SVG is never opened as a page on the bucket's origin
    const other = new URL((await s.presignGet('x', 60, { contentType: 'image/x-test+xml' })).url).searchParams;
    expect(other.get('response-content-type')).toBe('application/octet-stream');
    const svg = new URL((await s.presignGet('x', 60, { contentType: 'image/svg+xml' })).url).searchParams;
    expect([svg.get('response-content-type'), svg.get('response-content-disposition')]).toEqual(['image/svg+xml', 'attachment']);
    expect(new URL((await s.presignGet('x', 60, { contentType: 'image/svg+xml', filename: 'a.svg' })).url).searchParams.get('response-content-disposition')).toBe("attachment; filename*=UTF-8''a.svg");
    // a type registered with odd spelling is still code
    for (const t of [' text/html', 'TEXT/HTML; charset=utf-8', 'text/html ', 'application/xhtml+xml', 'text/xml', 'application/javascript', 'not a type', ''])
      expect(new URL((await s.presignGet('x', 60, { contentType: t })).url).searchParams.get('response-content-type'), t).toBe('application/octet-stream');
  });

  it('servedType keeps media types, normalised, and turns code into plain bytes', () => {
    expect(servedType('Video/MP4')).toBe('video/mp4');
    expect(servedType('application/vnd.chalk.book+json')).toBe('application/vnd.chalk.book+json');
    expect(servedType(' text/javascript')).toBe('application/octet-stream');
    // any XML document type can run script when opened; only SVG is kept (and made a download on S3)
    for (const t of ['image/x-test+xml', 'application/xhtml+xml', 'application/xslt+xml', 'application/rss+xml', 'Image/X-SVG+XML; x=1']) expect(servedType(t)).toBe('application/octet-stream');
    expect(servedType('IMAGE/SVG+XML; charset=utf-8')).toBe('image/svg+xml');
    expect(servedType('text/html\r\nX-Evil: 1')).toBe('application/octet-stream');
  });
});

describe('a private library on a private S3 bucket (PUBLIC_READ=false)', () => {
  it('the bucket itself refuses an unsigned GET', async () => {
    expect((await fetch(`${S3}/books/c1/${h.slice(0, 2)}/${h.slice(2, 4)}/${h}`)).status).toBe(403);
  });

  it('GET /v1/files/{h}: 401 without a token; with one, a 302 to a 5-minute pre-signed URL that carries no token', async () => {
    expect((await fetch(`${BASE}/v1/files/${h}`, { redirect: 'manual' })).status).toBe(401);
    const r = await fetch(`${BASE}/v1/files/${h}`, { headers: bearer(), redirect: 'manual' });
    expect(r.status).toBe(302);
    expect(r.headers.get('cache-control')).toBe('private, max-age=240');
    expect(r.headers.get('vary')).toContain('Authorization');
    const loc = new URL(r.headers.get('location')!);
    expect(loc.origin).toBe(S3);
    expect(loc.pathname).toBe(`/books/c1/${h.slice(0, 2)}/${h.slice(2, 4)}/${h}`);
    expect(loc.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(loc.searchParams.get('response-content-type')).toBe('application/octet-stream');
    expect(loc.href).not.toContain('t-1');
    expect(loc.href).not.toContain(CREDS.secretAccessKey);
  });

  it('a reader fetches with the token and follows the redirect; the bucket never sees the token', async () => {
    seen.length = 0;
    const r = await fetch(`${BASE}/v1/files/${h}`, { headers: bearer() });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/octet-stream');
    expect(await r.text()).toBe(LAB);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.authorization).toBeNull();
  });

  it('GET /v1/assets/{key}/link: a 15-minute pre-signed URL that works without any header, until it expires', async () => {
    expect((await fetch(`${BASE}/v1/assets/${key}/link`)).status).toBe(401);
    const r = await fetch(`${BASE}/v1/assets/${key}/link`, { headers: bearer() });
    expect(r.headers.get('cache-control')).toBe('no-store');
    const { url, expiresAt } = (await r.json()) as { url: string; expiresAt: string };
    expect(new URL(url).searchParams.get('X-Amz-Expires')).toBe('900');
    expect(Math.abs(Date.parse(expiresAt) - Date.now() - 900_000)).toBeLessThan(2000);
    expect(url).not.toContain('t-1');
    const got = await fetch(url);
    expect(got.status).toBe(200);
    expect(await got.text()).toBe(LAB);
    // tampering with the type it is served as breaks the signature
    const t = new URL(url); t.searchParams.set('response-content-type', 'text/html');
    expect((await fetch(t)).status).toBe(403);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 15 * 60_000 + 1000);
    expect((await fetch(url)).status).toBe(403);
  });

  it('a /v1/files redirect expires after 5 minutes', async () => {
    const loc = (await fetch(`${BASE}/v1/files/${h}`, { headers: bearer(), redirect: 'manual' })).headers.get('location')!;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 4 * 60_000);
    expect((await fetch(loc)).status).toBe(200);
    vi.setSystemTime(Date.now() + 2 * 60_000);
    expect((await fetch(loc)).status).toBe(403);
  });

  it('names /v1/files/{h} as a bearer store; a withdrawn key is 410', async () => {
    const stores = (await (await fetch(`${BASE}/v1/stores`)).json()) as { items: unknown[] };
    expect(stores.items).toEqual([{ id: 'library', kind: 'derived', template: `${BASE}/v1/files/{h}`, auth: 'bearer' }]);
    const w = await fetch(`${BASE}/v1/assets/${key}/withdraw`, { method: 'POST', headers: { ...bearer('a-1'), 'Content-Type': 'application/json' }, body: '{}' });
    expect(w.status).toBe(200);
    expect((await fetch(`${BASE}/v1/files/${h}`, { headers: bearer(), redirect: 'manual' })).status).toBe(410);
    expect((await fetch(`${BASE}/v1/assets/${key}/link`, { headers: bearer() })).status).toBe(410);
    expect(objects.size).toBe(0);
  });
});
