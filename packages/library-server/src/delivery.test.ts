import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { storeDescriptorSchema } from '@chalk-format/model';
import { createRegistryClient } from '@chalk-format/store';
import { checkLibrary, createLibraryApp, diskStorage, libraryFromEnv, openDb, tokenCallers, type Db, type DeliveryOptions, type LibraryOptions } from './index.js';

// a private library on disk (PUBLIC_READ=false) next to a public one over the same database and folder
const BASE = 'http://library.test';
const LAB = '<!doctype html><script>parent.postMessage(1, "*")</script><p>a lab</p>';
let db: Db, dir: string;
let priv: ReturnType<typeof createLibraryApp>, pub: ReturnType<typeof createLibraryApp>;
let key: string, h: string, path: string;

const options = (o: Partial<LibraryOptions & DeliveryOptions>): LibraryOptions & DeliveryOptions => ({
  db, storage: diskStorage(dir, { uploadBase: BASE, linkSecret: 'test link secret' }), publicUrl: `${BASE}/files/`, callers: tokenCallers('teacher:t-1,admin!:a-1'), ...o,
});
const get = (app: typeof priv, url: string, headers: Record<string, string> = {}) => app.fetch(new Request(url.startsWith('http') ? url : `${BASE}${url}`, { headers }));
const bearer = (t = 't-1') => ({ Authorization: `Bearer ${t}` });
const link = async (k = key) => (await (await get(priv, `/v1/assets/${k}/link`, bearer())).json()) as { url: string; expiresAt: string };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'chalk-delivery-'));
  db = await openDb('pglite:');
  priv = createLibraryApp(options({ publicRead: false }));
  pub = createLibraryApp(options({}));
  const fetchPriv = (async (input: RequestInfo | URL, init?: RequestInit) => priv.fetch(new Request(input, init))) as typeof fetch;
  const rec = await createRegistryClient(BASE, { token: 't-1', fetch: fetchPriv }).add(new TextEncoder().encode(LAB), { type: 'text/html', title: 'a lab', filename: 'lab.html' });
  key = rec.key; h = key.slice(3); path = `c1/${h.slice(0, 2)}/${h.slice(2, 4)}/${h}`;
}, 60_000);
afterAll(async () => { await db?.close(); rmSync(dir, { recursive: true, force: true }); });
afterEach(() => { vi.useRealTimers(); });

const expectNeverAPage = (r: Response) => {
  expect(r.headers.get('content-type')).toBe('application/octet-stream');
  expect(r.headers.get('content-security-policy')).toBe('sandbox');
  expect(r.headers.get('x-content-type-options')).toBe('nosniff');
};

describe('a private library on disk (PUBLIC_READ=false)', () => {
  it('passes the conformance checks, reading its bearer store with the token', async () => {
    const fetchPriv = (async (input: RequestInfo | URL, init?: RequestInit) => priv.fetch(new Request(input, init))) as typeof fetch;
    const failed = (await checkLibrary(BASE, { token: 't-1', adminToken: 'a-1', fetch: fetchPriv })).filter((r) => !r.ok);
    expect(failed, JSON.stringify(failed, null, 1)).toEqual([]);
  });

  it('names its own /v1/files/{h} as a bearer store, without a token', async () => {
    const r = await get(priv, '/v1/stores');
    expect(r.status).toBe(200);
    const { items } = (await r.json()) as { items: unknown[] };
    expect(items).toEqual([{ id: 'library', kind: 'derived', template: `${BASE}/v1/files/{h}`, auth: 'bearer' }]);
    expect(storeDescriptorSchema.safeParse(items[0]).success).toBe(true);
    // derived from the request: not for shared caches; a proxy's https is kept, its host is not taken
    expect(r.headers.get('cache-control')).toBe('private, max-age=300');
    const behind = (await (await get(priv, '/v1/stores', { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'evil.test' })).json()) as { items: { template: string }[] };
    expect(behind.items[0]!.template).toBe('https://library.test/v1/files/{h}');
    // SERVER_URL configured: that address, cacheable
    const set = createLibraryApp(options({ publicRead: false, serverUrl: 'https://library.example.org/' }));
    const r2 = await get(set, '/v1/stores');
    expect(((await r2.json()) as { items: { template: string }[] }).items[0]!.template).toBe('https://library.example.org/v1/files/{h}');
    expect(r2.headers.get('cache-control')).toBe('public, max-age=300');
  });

  it('GET /v1/files/{key}: the bytes with a token, ranges, never a page; 401 without one', async () => {
    expect((await get(priv, `/v1/files/${h}`)).status).toBe(401);
    expect((await get(priv, `/v1/files/${h}`, bearer('wrong'))).status).toBe(401);
    for (const k of [h, key, encodeURIComponent(key)]) {
      const r = await get(priv, `/v1/files/${k}`, bearer());
      expect(r.status).toBe(200);
      expectNeverAPage(r);
      expect(r.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
      // kept per token: a browser must not answer a request without one from this
      expect(r.headers.get('vary')).toContain('Authorization');
      expect(await r.text()).toBe(LAB);
    }
    // an author's (and an admin's) token reads too: reading needs any role
    expect((await get(priv, `/v1/files/${h}`, bearer('a-1'))).status).toBe(200);
    const part = await get(priv, `/v1/files/${h}`, { ...bearer(), Range: 'bytes=2-8' });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 2-8/${LAB.length}`);
    expect(await part.text()).toBe('doctype');
    const tail = await get(priv, `/v1/files/${h}`, { ...bearer(), Range: 'bytes=-8' });
    expect(await tail.text()).toBe('a lab</p>'.slice(-8));
    expect((await get(priv, `/v1/files/${h}`, { ...bearer(), Range: 'bytes=9999-' })).status).toBe(416);
    expect((await get(priv, `/v1/files/${'a'.repeat(25)}a`, bearer())).status).toBe(404);
    expect((await get(priv, '/v1/files/not-a-key', bearer())).status).toBe(404);
  });

  it('/files/ answers only signed links: 403 without one, and an HMAC link works without a token', async () => {
    expect((await get(priv, `/files/${path}`)).status).toBe(403);
    expect((await get(priv, `/files/${path}`, bearer())).status).toBe(403); // a token is not a signature
    expect((await get(priv, `/v1/assets/${key}/link`)).status).toBe(401);
    const l = await link();
    expect(l.url.startsWith(`${BASE}/files/${path}?exp=`)).toBe(true);
    expect(l.url).not.toContain('t-1');
    const left = Date.parse(l.expiresAt) - Date.now();
    expect(left).toBeGreaterThan(14 * 60_000);
    expect(left).toBeLessThanOrEqual(15 * 60_000);
    const r = await get(priv, l.url);
    expect(r.status).toBe(200);
    expectNeverAPage(r);
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    // a browser keeps it no longer than the link lasts
    const maxAge = Number(/^private, max-age=(\d+)$/.exec(r.headers.get('cache-control') ?? '')?.[1]);
    expect(maxAge).toBeGreaterThan(14 * 60);
    expect(maxAge).toBeLessThanOrEqual(15 * 60);
    expect(await r.text()).toBe(LAB);
    const part = await get(priv, l.url, { Range: 'bytes=2-8' });
    expect(part.status).toBe(206);
    expect(await part.text()).toBe('doctype');
  });

  it('refuses tampered, moved and expired links', async () => {
    const { url } = await link();
    const u = new URL(url);
    const sig = u.searchParams.get('sig')!;
    const variants = [
      (x: URL) => x.searchParams.set('sig', (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1)),
      (x: URL) => x.searchParams.set('exp', String(Number(x.searchParams.get('exp')) + 3600)),
      (x: URL) => x.searchParams.delete('sig'),
      (x: URL) => x.searchParams.set('fn', 'evil.html'),
      (x: URL) => x.searchParams.set('exp', 'abc'),
    ];
    for (const change of variants) { const t = new URL(u); change(t); expect((await get(priv, t.href)).status).toBe(403); }
    // the same signature on another file
    const other = await createRegistryClient(BASE, { token: 't-1', fetch: (async (i: RequestInfo | URL, n?: RequestInit) => priv.fetch(new Request(i, n))) as typeof fetch })
      .add(new TextEncoder().encode('another file'), { type: 'image/png', title: 'other' });
    const oh = other.key.slice(3), moved = new URL(u);
    moved.pathname = `/files/c1/${oh.slice(0, 2)}/${oh.slice(2, 4)}/${oh}`;
    expect((await get(priv, moved.href)).status).toBe(403);
    // a link signed with another secret
    const elsewhere = diskStorage(dir, { uploadBase: BASE, linkSecret: 'another secret' });
    expect((await get(priv, (await elsewhere.presignGet(path, 60, { contentType: 'text/html' })).url)).status).toBe(403);
    // expired
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 15 * 60_000 + 1000);
    expect((await get(priv, url)).status).toBe(403);
  });

  it('a signed file name is served as an inline file name, never as a type', async () => {
    const s = diskStorage(dir, { uploadBase: BASE, linkSecret: 'test link secret' });
    const { url } = await s.presignGet(path, 60, { contentType: 'text/html', filename: 'পরীক্ষা lab.html' });
    const r = await get(priv, url);
    expect(r.status).toBe(200);
    expectNeverAPage(r);
    expect(r.headers.get('content-disposition')).toBe(`inline; filename*=UTF-8''${encodeURIComponent('পরীক্ষা lab.html')}`);
  });

  it('a withdrawn key: 410 for the token and a valid link, 403 for anyone else', async () => {
    const w = await createRegistryClient(BASE, { token: 't-1', fetch: (async (i: RequestInfo | URL, n?: RequestInit) => priv.fetch(new Request(i, n))) as typeof fetch })
      .add(new TextEncoder().encode('to be withdrawn'), { type: 'image/png', title: 'gone' });
    const wh = w.key.slice(3), wpath = `c1/${wh.slice(0, 2)}/${wh.slice(2, 4)}/${wh}`;
    const before = await link(w.key);
    const res = await priv.fetch(new Request(`${BASE}/v1/assets/${w.key}/withdraw`, { method: 'POST', headers: { ...bearer('a-1'), 'Content-Type': 'application/json' }, body: '{}' }));
    expect(res.status).toBe(200);
    expect((await get(priv, `/v1/files/${wh}`, bearer())).status).toBe(410);
    expect((await get(priv, `/v1/assets/${w.key}/link`, bearer())).status).toBe(410);
    expect((await get(priv, before.url)).status).toBe(410);
    expect((await get(priv, `/files/${wpath}`)).status).toBe(403);
    expect((await get(priv, `/v1/files/${wh}`)).status).toBe(401);
  });
});

describe('a public library (PUBLIC_READ=true, the default) is unchanged', () => {
  it('names the public store, and /files/ serves without a signature as before', async () => {
    const r = await get(pub, '/v1/stores');
    expect(await r.json()).toEqual({ items: [{ id: 'library', kind: 'derived', template: `${BASE}/files/c1/{h0}/{h1}/{h}` }] });
    expect(r.headers.get('cache-control')).toBe('public, max-age=300');
    const f = await get(pub, `/files/${path}`);
    expect(f.status).toBe(200);
    expect(Object.fromEntries([...f.headers].filter(([k]) => k !== 'date'))).toEqual({
      'content-type': 'application/octet-stream', 'cache-control': 'public, max-age=31536000, immutable', 'accept-ranges': 'bytes',
      'access-control-allow-origin': '*', 'x-content-type-options': 'nosniff', 'content-security-policy': 'sandbox', 'content-length': String(LAB.length),
    });
    expect(await f.text()).toBe(LAB);
    expect((await get(pub, '/files/c1/xx/yy/not-a-key')).status).toBe(404);
  });

  it('reading stays open: the new routes need no token either', async () => {
    expect((await get(pub, `/v1/files/${h}`)).status).toBe(200);
    const l = (await (await get(pub, `/v1/assets/${key}/link`)).json()) as { url: string };
    expect((await get(pub, l.url)).status).toBe(200);
    // a public /files/ ignores a link's query, so it serves a tampered one as it serves a bare path
    expect((await get(pub, l.url.replace(/sig=[^&]+/, 'sig=x'))).status).toBe(200);
  });
});

describe('settings', () => {
  it('FILE_LINK_SECRET signs disk links (else derived from UPLOAD_SECRET); SERVER_URL only when set', async () => {
    const env = { DATABASE_URL: 'pglite:', STORAGE: 'disk', DISK_DIR: dir, PUBLIC_READ: 'false' };
    const a = await libraryFromEnv({ ...env, FILE_LINK_SECRET: 'from env' });
    const b = await libraryFromEnv({ ...env, UPLOAD_SECRET: 'up', SERVER_URL: 'https://lib.example.org' });
    try {
      expect(a.serverUrl).toBeUndefined();
      expect(b.serverUrl).toBe('https://lib.example.org');
      const q = (url: string) => Object.fromEntries(new URL(url).searchParams) as { exp: string; sig: string };
      const la = await a.storage.presignGet(path, 60, { contentType: 'image/png' });
      expect(diskStorage(dir, { uploadBase: BASE, linkSecret: 'from env' }).link(path, q(la.url))).toEqual({});
      const lb = await b.storage.presignGet(path, 60, { contentType: 'image/png' });
      expect(lb.url.startsWith('https://lib.example.org/files/')).toBe(true);
      expect(diskStorage(dir, { uploadBase: BASE, secret: 'up' }).link(path, q(lb.url))).toEqual({});
      expect(diskStorage(dir, { uploadBase: BASE, secret: 'other' }).link(path, q(lb.url))).toBeNull();
    } finally { await a.db.close(); await b.db.close(); }
  }, 60_000);
});
