import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assetKeyAndSha256, storeDescriptorSchema, type StoreDescriptor } from '@chalk-format/model';
import { createRegistryClient, createResolver, registryLibrary, standardPath } from '@chalk-format/store';
import { adoptPrefixes, checkLibrary, createLibraryApp, diskStorage, libraryFromEnv, openDb, s3Storage, tokenCallers, type Db, type Storage } from './index.js';

// Files adopted in place (registry-api §3.1): a book written into the library's own bucket by another tool
// (chalk-books/<slug>/…) is verified where it is, served from there, and found by readers through the library's
// indexed store, on a disk library and on an S3 bucket, public and private.

const BASE = 'http://library.test';
const PAGE = new TextEncoder().encode(JSON.stringify({ page: 1, blocks: ['adopted in place'] }));
const IMG = new TextEncoder().encode('\x89PNG not really, but bytes all the same');
const json = { 'Content-Type': 'application/json' };
const bearer = (t = 't-1') => ({ Authorization: `Bearer ${t}` });
const text = (b: ArrayBuffer | Uint8Array) => new TextDecoder().decode(b);
type Rec = { key: string; status: string; title: string | null; tags: string[]; locations?: { store: string; path: string }[] };

/** Count the reads a storage does (verification reads the object; a second adopt must not). */
function counting(s: Storage) {
  const reads: string[] = [];
  return { reads, storage: new Proxy(s, { get: (t, k) => (k === 'read' ? (p: string) => { reads.push(p); return t.read(p); } : Reflect.get(t, k)) }) as typeof s };
}

describe('adopting a file in place: a public disk library', () => {
  let db: Db, dir: string, app: ReturnType<typeof createLibraryApp>, reads: string[];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => app.fetch(new Request(input, init))) as typeof fetch;
  const adopt = (body: object, token = 't-1') => f(`${BASE}/v1/assets/adopt`, { method: 'POST', headers: { ...json, ...bearer(token) }, body: JSON.stringify(body) });
  const put = (path: string, bytes: Uint8Array) => { const p = join(dir, ...path.split('/')); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, bytes); };
  let page: { key: string; sha256: string }, img: { key: string; sha256: string };
  const PAGE_PATH = 'chalk-books/physics-9/pages/1-0a1b2c3d.json', IMG_PATH = 'chalk-books/physics-9/assets/sha256-figure.png';

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'chalk-adopt-'));
    db = await openDb('pglite:');
    const c = counting(diskStorage(dir, { uploadBase: BASE }));
    reads = c.reads;
    app = createLibraryApp({ db, storage: c.storage, publicUrl: `${BASE}/files/`, callers: tokenCallers('teacher:t-1,admin!:a-1'), adoptPrefixes: ['chalk-books/'] });
    page = await assetKeyAndSha256(PAGE); img = await assetKeyAndSha256(IMG);
    put(PAGE_PATH, PAGE); put(IMG_PATH, IMG);
  }, 60_000);
  afterAll(async () => { await db?.close(); rmSync(dir, { recursive: true, force: true }); });

  it('refuses what it must not record: wrong bytes, a wrong size, nothing there, a path outside its prefixes or the bucket, a key that is not the sha256\'s', async () => {
    const other = await assetKeyAndSha256(new TextEncoder().encode('something else'));
    const size = PAGE.byteLength, type = 'application/vnd.chalk.page+json';
    expect((await adopt({ ...other, type, size, path: PAGE_PATH })).status).toBe(422);
    expect((await adopt({ ...page, type, size: size + 1, path: PAGE_PATH })).status).toBe(422);
    expect((await adopt({ ...page, type, size, path: 'chalk-books/physics-9/pages/missing.json' })).status).toBe(409);
    expect((await adopt({ ...page, type, size, path: 'elsewhere/1.json' })).status).toBe(403);
    expect((await adopt({ ...page, type, size, path: `c1/${page.key.slice(3, 5)}/x` })).status).toBe(403);
    for (const path of ['chalk-books/../secret', '/chalk-books/x', 'chalk-books//x', 'chalk-books/./x', 'chalk-books\\x']) expect((await adopt({ ...page, type, size, path })).status, path).toBe(400);
    expect((await adopt({ ...page, key: other.key, type, size, path: PAGE_PATH })).status).toBe(400);
    expect((await adopt({ ...page, type: 'application/x-msdownload', size, path: PAGE_PATH })).status).toBe(415);
    const anon = await f(`${BASE}/v1/assets/adopt`, { method: 'POST', headers: json, body: JSON.stringify({ ...page, type, size, path: PAGE_PATH }) });
    expect(anon.status).toBe(401);
    // a link under the prefix that leads out of the library's folder is not a file in it
    const outside = mkdtempSync(join(tmpdir(), 'chalk-outside-')), secret = new TextEncoder().encode('not the library\'s');
    writeFileSync(join(outside, 'secret'), secret); mkdirSync(join(dir, 'chalk-books', 'links'), { recursive: true });
    symlinkSync(join(outside, 'secret'), join(dir, 'chalk-books', 'links', 'secret'));
    expect((await adopt({ ...(await assetKeyAndSha256(secret)), type: 'image/png', size: secret.byteLength, path: 'chalk-books/links/secret' })).status).toBe(409);
    rmSync(outside, { recursive: true, force: true });
    // nothing recorded, and the owner's file is where it was
    expect((await (await f(`${BASE}/v1/assets/check`, { method: 'POST', headers: { ...json, ...bearer() }, body: JSON.stringify({ keys: [page.key, other.key] }) })).json())).toMatchObject({ missing: [page.key, other.key] });
    expect(existsSync(join(dir, ...PAGE_PATH.split('/')))).toBe(true);
  });

  it('verifies by reading the object once, records it where it is, copies nothing', async () => {
    reads.length = 0;
    const r = await adopt({ ...page, type: 'application/vnd.chalk.page+json', size: PAGE.byteLength, path: PAGE_PATH, title: 'Page 1', tags: ['book:physics-9'] });
    expect(r.status).toBe(200);
    const rec = (await r.json()) as Rec;
    expect(rec).toMatchObject({ key: page.key, status: 'available', title: 'Page 1', tags: ['book:physics-9'], locations: [{ store: 'library', path: PAGE_PATH }] });
    expect(reads).toEqual([PAGE_PATH]);
    expect(existsSync(join(dir, ...standardPath(page.key).split('/')))).toBe(false);
    expect((await adopt({ ...img, type: 'image/png', size: IMG.byteLength, path: IMG_PATH, filename: 'figure.png' })).status).toBe(200);
  });

  it('adopting again updates the descriptive fields and never reads the bytes again', async () => {
    reads.length = 0;
    const r = await adopt({ ...page, type: 'application/vnd.chalk.page+json', size: PAGE.byteLength, path: PAGE_PATH, title: 'Page one', subject: 'physics' });
    expect(await r.json()).toMatchObject({ key: page.key, title: 'Page one', subject: 'physics', tags: ['book:physics-9'] });
    expect(reads).toEqual([]);
  });

  it('names an indexed store after the derived one; its shard says where each adopted file is', async () => {
    const r = await f(`${BASE}/v1/stores`);
    const { items } = (await r.json()) as { items: StoreDescriptor[] };
    expect(items).toEqual([{ id: 'library', kind: 'derived', template: `${BASE}/files/c1/{h0}/{h1}/{h}` }, { id: 'library-adopted', kind: 'indexed', base: `${BASE}/` }]);
    for (const d of items) storeDescriptorSchema.parse(d);
    const h = page.key.slice(3), shard = await f(`${BASE}/index/${h.slice(0, 2)}.json`);
    expect(shard.status).toBe(200);
    expect(shard.headers.get('cache-control')).toBe('public, max-age=60');
    expect(shard.headers.get('access-control-allow-origin')).toBe('*');
    const body = (await shard.json()) as { v: number; entries: Record<string, { p: string; s: number; t: string }> };
    expect(body.v).toBe(1);
    expect(body.entries[h]).toEqual({ p: `${BASE}/files/${PAGE_PATH}`, s: PAGE.byteLength, t: 'application/vnd.chalk.page+json' });
    for (const k of Object.keys(body.entries)) expect(k.slice(0, 2)).toBe(h.slice(0, 2));
    const etag = shard.headers.get('etag')!;
    expect((await f(`${BASE}/index/${h.slice(0, 2)}.json`, { headers: { 'If-None-Match': etag } })).status).toBe(304);
    // a shard with nothing adopted is a 404, as spec 1.2 §5.3 says; a name that is not a shard too
    const empty = ['aa', 'ab', 'ac'].find((s) => s !== h.slice(0, 2) && s !== img.key.slice(3, 5))!;
    expect((await f(`${BASE}/index/${empty}.json`)).status).toBe(404);
    expect((await f(`${BASE}/index/zz1.json`)).status).toBe(404);
  });

  it('a reader resolves an adopted key through /v1/stores: the derived store 404s, the index finds it, the bytes verify', async () => {
    const { items } = (await (await f(`${BASE}/v1/stores`)).json()) as { items: StoreDescriptor[] };
    const h = page.key.slice(3);
    expect((await f(`${BASE}/files/c1/${h.slice(0, 2)}/${h.slice(2, 4)}/${h}`)).status).toBe(404);
    const seen: string[] = [];
    const reader = createResolver({ hostStores: items, fetch: ((u: RequestInfo | URL, i?: RequestInit) => { seen.push(String(u)); return f(u, i); }) as typeof fetch });
    const got = await reader.resolve(page.key, 'application/vnd.chalk.page+json');
    expect(got?.from).toBe('library-adopted');
    expect(text(got!.bytes)).toBe(text(PAGE));
    expect(seen).toEqual([`${BASE}/files/${standardPath(page.key)}`, `${BASE}/index/${h.slice(0, 2)}.json`, `${BASE}/files/${PAGE_PATH}`]);
    // and the file itself: immutable, its registered type, never a page
    const r = await f(`${BASE}/files/${PAGE_PATH}`);
    expect(r.headers.get('content-type')).toBe('application/vnd.chalk.page+json');
    expect(r.headers.get('cache-control')).toContain('immutable');
    const part = await f(`${BASE}/files/${PAGE_PATH}`, { headers: { Range: 'bytes=0-6' } });
    expect([part.status, await part.text()]).toEqual([206, text(PAGE).slice(0, 7)]);
    // a file the library did not adopt is not served, even under the prefix
    put('chalk-books/physics-9/book.json', new TextEncoder().encode('{}'));
    expect((await f(`${BASE}/files/chalk-books/physics-9/book.json`)).status).toBe(404);
  });

  it('every other read path goes through the location: /v1/files, the link, registryLibrary get and url', async () => {
    const r = await f(`${BASE}/v1/files/${img.key}`);
    expect([r.status, text(await r.arrayBuffer())]).toEqual([200, text(IMG)]);
    const { url } = (await (await f(`${BASE}/v1/assets/${img.key}/link`)).json()) as { url: string };
    expect(url.startsWith(`${BASE}/files/${IMG_PATH}?`)).toBe(true);
    expect(text(await (await f(url)).arrayBuffer())).toBe(text(IMG));
    const lib = registryLibrary({ url: BASE, fetch: f });
    expect(await lib.url(img.key)).toBe(`${BASE}/files/${IMG_PATH}`);
    expect(text((await lib.get(img.key))!.bytes)).toBe(text(IMG));
  });

  it('the upload flow is unchanged: an uploaded key stays at its standard path, outside the index; adopting it later keeps it there', async () => {
    const client = createRegistryClient(BASE, { token: 't-1', fetch: f });
    const bytes = new TextEncoder().encode('uploaded the usual way');
    const rec = await client.add(bytes, { type: 'image/png', title: 'usual' });
    expect(rec.locations).toEqual([{ store: 'library', path: standardPath(rec.key) }]);
    const lib = registryLibrary({ url: BASE, fetch: f });
    expect(await lib.url(rec.key)).toBe(`${BASE}/files/${standardPath(rec.key)}`);
    const shard = await f(`${BASE}/index/${rec.key.slice(3, 5)}.json`);
    if (shard.status === 200) expect(((await shard.json()) as { entries: Record<string, unknown> }).entries[rec.key.slice(3)]).toBeUndefined();
    // the same bytes written into a book too: adopting finds the key available, verified at the standard path, and reads nothing
    put('chalk-books/physics-9/assets/usual.png', bytes);
    reads.length = 0;
    const again = (await (await adopt({ key: rec.key, sha256: rec.sha256, type: 'image/png', size: bytes.byteLength, path: 'chalk-books/physics-9/assets/usual.png', tags: ['book:physics-9'] })).json()) as Rec;
    expect(again.locations).toEqual([{ store: 'library', path: standardPath(rec.key) }]);
    expect(again.tags).toEqual(['book:physics-9']);
    expect(reads).toEqual([]);
  });

  it('a pending upload is completed by adopting; a location whose object its owner deleted is replaced', async () => {
    const bytes = new TextEncoder().encode('started as an upload'), k = await assetKeyAndSha256(bytes);
    const up = await f(`${BASE}/v1/uploads`, { method: 'POST', headers: { ...json, ...bearer() }, body: JSON.stringify({ ...k, type: 'image/png', size: bytes.byteLength }) });
    expect(up.status).toBe(200);
    // the uploader PUT other bytes and never registered them: the library's own copy, unverified, at the standard path
    const { upload } = (await up.json()) as { upload: { url: string; headers?: Record<string, string> } };
    expect((await f(upload.url, { method: 'PUT', headers: upload.headers ?? {}, body: new TextEncoder().encode('started as an uplaod') })).status).toBe(200);
    expect(existsSync(join(dir, ...standardPath(k.key).split('/')))).toBe(true);
    put('chalk-books/b2/assets/a.png', bytes);
    expect(await (await adopt({ ...k, type: 'image/png', size: bytes.byteLength, path: 'chalk-books/b2/assets/a.png' })).json()).toMatchObject({ status: 'available', locations: [{ path: 'chalk-books/b2/assets/a.png' }] });
    // adopting removed it, so the derived store 404s; registryLibrary looks at the index first anyway
    expect(existsSync(join(dir, ...standardPath(k.key).split('/')))).toBe(false);
    expect(text((await registryLibrary({ url: BASE, fetch: f }).get(k.key))!.bytes)).toBe(text(bytes));
    unlinkSync(join(dir, 'chalk-books', 'b2', 'assets', 'a.png'));
    put('chalk-books/b3/assets/a.png', bytes);
    expect(await (await adopt({ ...k, type: 'image/png', size: bytes.byteLength, path: 'chalk-books/b3/assets/a.png' })).json()).toMatchObject({ locations: [{ path: 'chalk-books/b3/assets/a.png' }] });
    expect(text(await (await f(`${BASE}/v1/files/${k.key}`)).arrayBuffer())).toBe(text(bytes));
  });

  it('withdrawing an adopted key never deletes its file; readers get nothing; adopting it again is 410', async () => {
    const w = await f(`${BASE}/v1/assets/${img.key}/withdraw`, { method: 'POST', headers: { ...json, ...bearer('a-1') }, body: '{}' });
    expect(w.status).toBe(200);
    expect(existsSync(join(dir, ...IMG_PATH.split('/')))).toBe(true);
    expect((await f(`${BASE}/v1/files/${img.key}`)).status).toBe(410);
    expect((await f(`${BASE}/files/${IMG_PATH}`)).status).toBe(410);
    const shard = await f(`${BASE}/index/${img.key.slice(3, 5)}.json`);
    if (shard.status === 200) expect(((await shard.json()) as { entries: Record<string, unknown> }).entries[img.key.slice(3)]).toBeUndefined();
    expect((await adopt({ ...img, type: 'image/png', size: IMG.byteLength, path: IMG_PATH })).status).toBe(410);
  });

  it('still passes the conformance checks', async () => {
    const results = await checkLibrary(BASE, { token: 't-1', adminToken: 'a-1', fetch: f });
    expect(results.filter((x) => !x.ok)).toEqual([]);
  });
});

describe('adopting: off by default, and a private library', () => {
  let db: Db, dir: string;
  beforeAll(async () => { dir = mkdtempSync(join(tmpdir(), 'chalk-adopt-p-')); db = await openDb('pglite:'); }, 60_000);
  afterAll(async () => { await db?.close(); rmSync(dir, { recursive: true, force: true }); });

  it('without ADOPT_PREFIXES adopting is 403 and /v1/stores is what it was', async () => {
    const app = createLibraryApp({ db, storage: diskStorage(dir, { uploadBase: BASE }), publicUrl: `${BASE}/files/`, callers: tokenCallers('teacher:t-1') });
    const k = await assetKeyAndSha256(PAGE);
    const r = await app.fetch(new Request(`${BASE}/v1/assets/adopt`, { method: 'POST', headers: { ...json, ...bearer() }, body: JSON.stringify({ ...k, type: 'image/png', size: PAGE.byteLength, path: 'chalk-books/x.json' }) }));
    expect(r.status).toBe(403);
    const s = await app.fetch(new Request(`${BASE}/v1/stores`));
    expect(s.headers.get('cache-control')).toBe('public, max-age=300');
    expect(await s.json()).toEqual({ items: [{ id: 'library', kind: 'derived', template: `${BASE}/files/c1/{h0}/{h1}/{h}` }] });
  });

  it('PUBLIC_READ=false: no index is named or served; a reader with a token resolves through /v1/files and the signed link', async () => {
    const app = createLibraryApp({ db, storage: diskStorage(dir, { uploadBase: BASE }), publicUrl: `${BASE}/files/`, callers: tokenCallers('teacher:t-1'), publicRead: false, adoptPrefixes: ['chalk-books/'] });
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => app.fetch(new Request(input, init))) as typeof fetch;
    const k = await assetKeyAndSha256(PAGE), path = 'chalk-books/private/pages/1.json';
    mkdirSync(join(dir, 'chalk-books', 'private', 'pages'), { recursive: true }); writeFileSync(join(dir, ...path.split('/')), PAGE);
    expect((await createRegistryClient(BASE, { token: 't-1', fetch: f }).adopt({ ...k, type: 'application/vnd.chalk.page+json', size: PAGE.byteLength, path })).status).toBe('available');
    const { items } = (await (await f(`${BASE}/v1/stores`)).json()) as { items: StoreDescriptor[] };
    expect(items).toEqual([{ id: 'library', kind: 'derived', template: `${BASE}/v1/files/{h}`, auth: 'bearer' }]);
    expect((await f(`${BASE}/index/${k.key.slice(3, 5)}.json`)).status).toBe(404);
    expect((await f(`${BASE}/files/${path}`)).status).toBe(403);
    const reader = createResolver({ hostStores: items, token: () => 't-1', fetch: f });
    expect(text((await reader.resolve(k.key, 'application/vnd.chalk.page+json'))!.bytes)).toBe(text(PAGE));
    const { url } = (await (await f(`${BASE}/v1/assets/${k.key}/link`, { headers: bearer() })).json()) as { url: string };
    expect(url.startsWith(`${BASE}/files/${path}?`)).toBe(true);
    expect(text(await (await f(url)).arrayBuffer())).toBe(text(PAGE));
  });

  it('a key is never available without its location, even between two statements (a reader would look at the standard path)', async () => {
    const bytes = new TextEncoder().encode('pending, then adopted'), k = await assetKeyAndSha256(bytes), path = 'chalk-books/race/a.png';
    mkdirSync(join(dir, 'chalk-books', 'race'), { recursive: true }); writeFileSync(join(dir, ...path.split('/')), bytes);
    // after every statement the app runs, look at what a reader would see
    const states: string[] = [];
    const watched: Db = { close: () => db.close(), async query<T>(sql: string, params?: unknown[]) {
      const r = await db.query<T>(sql, params);
      const [x] = await db.query<{ status: string; path: string | null }>("SELECT a.status, l.path FROM assets a LEFT JOIN locations l ON l.key = a.key AND l.store = 'library' WHERE a.key = $1", [k.key]);
      if (x) states.push(`${x.status}:${x.path ?? '-'}`);
      return r;
    } };
    const app = createLibraryApp({ db: watched, storage: diskStorage(dir, { uploadBase: BASE }), publicUrl: `${BASE}/files/`, callers: tokenCallers('teacher:t-1'), adoptPrefixes: ['chalk-books/'] });
    const call = (p: string, body: object) => app.fetch(new Request(`${BASE}${p}`, { method: 'POST', headers: { ...json, ...bearer() }, body: JSON.stringify(body) }));
    expect((await call('/v1/uploads', { ...k, type: 'image/png', size: bytes.byteLength })).status).toBe(200);
    expect((await call('/v1/assets/adopt', { ...k, type: 'image/png', size: bytes.byteLength, path })).status).toBe(200);
    expect(states).toContain(`available:${path}`);
    expect(states.filter((x) => x.startsWith('available:') && x !== `available:${path}`)).toEqual([]);
  });

  it('a key withdrawn while its bytes are being read is not adopted: 410, and no location', async () => {
    const bytes = new TextEncoder().encode('withdrawn mid-read'), k = await assetKeyAndSha256(bytes), path = 'chalk-books/mid/a.png';
    mkdirSync(join(dir, 'chalk-books', 'mid'), { recursive: true }); writeFileSync(join(dir, ...path.split('/')), bytes);
    let app: ReturnType<typeof createLibraryApp> | null = null;
    const call = (p: string, body: object, t = 't-1') => app!.fetch(new Request(`${BASE}${p}`, { method: 'POST', headers: { ...json, ...bearer(t) }, body: JSON.stringify(body) }));
    const disk = diskStorage(dir, { uploadBase: BASE });
    const storage = new Proxy(disk, { get: (t, key) => (key === 'read' ? async (p: string) => { if (p === path) expect((await call(`/v1/assets/${k.key}/withdraw`, {}, 'a-1')).status).toBe(200); return t.read(p); } : Reflect.get(t, key)) }) as typeof disk;
    app = createLibraryApp({ db, storage, publicUrl: `${BASE}/files/`, callers: tokenCallers('teacher:t-1,admin!:a-1'), adoptPrefixes: ['chalk-books/'] });
    expect((await call('/v1/uploads', { ...k, type: 'image/png', size: bytes.byteLength })).status).toBe(200);
    expect((await call('/v1/assets/adopt', { ...k, type: 'image/png', size: bytes.byteLength, path })).status).toBe(410);
    expect(await db.query('SELECT path FROM locations WHERE key = $1', [k.key])).toEqual([]);
  });

  it('ADOPT_PREFIXES: each made a folder, never the library\'s own layout or a path outside the bucket', async () => {
    expect(adoptPrefixes(' chalk-books , media/old/ ')).toEqual(['chalk-books/', 'media/old/']);
    expect(adoptPrefixes(undefined)).toEqual([]);
    for (const bad of ['c1/', 'c1', '../x', '/abs', 'a/../b']) expect(() => adoptPrefixes(bad), bad).toThrow(/ADOPT_PREFIXES/);
    const o = await libraryFromEnv({ ADOPT_PREFIXES: 'chalk-books', DISK_DIR: dir });
    expect(o.adoptPrefixes).toEqual(['chalk-books/']);
    await o.db.close();
  });
});

// ---- an S3 bucket (a stub that checks a request is signed, like a private bucket) and a CDN in front of it ----
describe('adopting on S3: a public library behind a CDN, and a private one', () => {
  const CREDS = { accessKeyId: 'AKIDTESTADOPT', secretAccessKey: 'adopt-secret' };
  const objects = new Map<string, Uint8Array>(), types = new Map<string, string>(), log: string[] = [];
  let db: Db, s3: ServerType, cdn: ServerType, lib: ServerType, priv: ServerType, S3: string, CDN: string, LIB: string, PRIV: string;
  const PATH = 'chalk-books/chem-10/assets/sha256-diagram.png';
  let k: { key: string; sha256: string };
  const listen = (fetch: (r: Request) => Response | Promise<Response>) => new Promise<{ server: ServerType; url: string }>((done) => {
    const server = serve({ fetch, port: 0, hostname: '127.0.0.1' }, (i: AddressInfo) => done({ server, url: `http://127.0.0.1:${i.port}` }));
  });
  const object = (path: string, method: string) => {
    const o = objects.get(path);
    if (!o) return new Response('NoSuchKey', { status: 404 });
    return new Response(method === 'HEAD' ? null : (o as unknown as BodyInit), { status: 200, headers: { 'Content-Length': String(o.length), 'Content-Type': types.get(path) ?? 'application/octet-stream' } });
  };

  beforeAll(async () => {
    ({ server: s3, url: S3 } = await listen(async (req) => {
      const u = new URL(req.url), path = decodeURIComponent(u.pathname).replace(/^\/books\//, '');
      log.push(`${req.method} ${path}`);
      if (!u.searchParams.has('X-Amz-Signature') && !req.headers.get('authorization')?.startsWith('AWS4-HMAC-SHA256 ')) return new Response('AccessDenied', { status: 403 });
      if (req.method === 'PUT') { objects.set(path, new Uint8Array(await req.arrayBuffer())); return new Response(null, { status: 200 }); }
      if (req.method === 'DELETE') { objects.delete(path); return new Response(null, { status: 204 }); }
      return object(path, req.method);
    }));
    ({ server: cdn, url: CDN } = await listen((req) => object(decodeURIComponent(new URL(req.url).pathname).slice(1), req.method)));
    db = await openDb('pglite:');
    const storage = s3Storage({ endpoint: S3, bucket: 'books', ...CREDS });
    let app: ReturnType<typeof createLibraryApp> | null = null, papp: ReturnType<typeof createLibraryApp> | null = null;
    ({ server: lib, url: LIB } = await listen((r) => app!.fetch(r)));
    ({ server: priv, url: PRIV } = await listen((r) => papp!.fetch(r)));
    const common = { db, storage, publicUrl: `${CDN}/`, callers: tokenCallers('teacher:t-1,admin!:a-1'), adoptPrefixes: ['chalk-books/'] };
    app = createLibraryApp({ ...common, serverUrl: LIB } as Parameters<typeof createLibraryApp>[0]);
    papp = createLibraryApp({ ...common, publicRead: false, serverUrl: PRIV } as Parameters<typeof createLibraryApp>[0]);
    k = await assetKeyAndSha256(IMG);
    objects.set(PATH, IMG); types.set(PATH, 'image/png');   // the dashboard wrote it into the library's bucket
  }, 60_000);
  afterAll(async () => { s3?.close(); cdn?.close(); lib?.close(); priv?.close(); await db?.close(); });

  it('adopts by HEAD and one GET inside the bucket; nothing is written', async () => {
    log.length = 0;
    const rec = await createRegistryClient(LIB, { token: 't-1' }).adopt({ ...k, type: 'image/png', size: IMG.byteLength, path: PATH, title: 'diagram' });
    expect(rec).toMatchObject({ status: 'available', locations: [{ store: 'library', path: PATH }] });
    expect(log).toEqual([`HEAD ${PATH}`, `GET ${PATH}`]);
    expect([...objects.keys()]).toEqual([PATH]);
  });

  it('a public library does not adopt an object its bucket would serve as a page; a private one does', async () => {
    const lab = new TextEncoder().encode('<!doctype html><script>alert(1)</script>'), lk = await assetKeyAndSha256(lab), path = 'chalk-books/chem-10/assets/lab.html';
    objects.set(path, lab); types.set(path, 'text/html; charset=utf-8');
    const body = JSON.stringify({ ...lk, type: 'text/html', size: lab.byteLength, path });
    const r = await fetch(`${LIB}/v1/assets/adopt`, { method: 'POST', headers: { ...json, ...bearer() }, body });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: { message: string } }).error.message).toMatch(/text\/html/);
    types.set(path, 'application/octet-stream');
    expect((await fetch(`${LIB}/v1/assets/adopt`, { method: 'POST', headers: { ...json, ...bearer() }, body })).status).toBe(200);
    const priv2 = 'chalk-books/chem-10/assets/lab2.html', lab2 = new TextEncoder().encode('<p>private</p>'), k2 = await assetKeyAndSha256(lab2);
    objects.set(priv2, lab2); types.set(priv2, 'text/html');
    expect((await fetch(`${PRIV}/v1/assets/adopt`, { method: 'POST', headers: { ...json, ...bearer() }, body: JSON.stringify({ ...k2, type: 'text/html', size: lab2.byteLength, path: priv2 }) })).status).toBe(200);
  });

  it('a reader of the public library: the CDN\'s derived path 404s, the index names the CDN URL of the book\'s file, the bytes verify', async () => {
    const { items } = (await (await fetch(`${LIB}/v1/stores`)).json()) as { items: StoreDescriptor[] };
    expect(items).toEqual([{ id: 'library', kind: 'derived', template: `${CDN}/c1/{h0}/{h1}/{h}` }, { id: 'library-adopted', kind: 'indexed', base: `${LIB}/` }]);
    const seen: string[] = [];
    const reader = createResolver({ hostStores: items, fetch: ((u: RequestInfo | URL, i?: RequestInit) => { seen.push(String(u)); return fetch(u, i); }) as typeof fetch });
    const got = await reader.resolve(k.key, 'image/png');
    expect(got?.from).toBe('library-adopted');
    expect(text(got!.bytes)).toBe(text(IMG));
    expect(seen).toEqual([`${CDN}/${standardPath(k.key)}`, `${LIB}/index/${k.key.slice(3, 5)}.json`, `${CDN}/${PATH}`]);
  });

  it('/v1/files and the link pre-sign the adopted path', async () => {
    const r = await fetch(`${LIB}/v1/files/${k.key}`, { redirect: 'manual' });
    expect(r.status).toBe(302);
    expect(new URL(r.headers.get('location')!).pathname).toBe(`/books/${PATH}`);
    expect(text(await (await fetch(`${LIB}/v1/files/${k.key}`)).arrayBuffer())).toBe(text(IMG));
    const { url } = (await (await fetch(`${LIB}/v1/assets/${k.key}/link`)).json()) as { url: string };
    expect(text(await (await fetch(url)).arrayBuffer())).toBe(text(IMG));
  });

  it('a private library (PUBLIC_READ=false) names no index; a reader with a token follows /v1/files to the adopted object', async () => {
    const { items } = (await (await fetch(`${PRIV}/v1/stores`)).json()) as { items: StoreDescriptor[] };
    expect(items).toEqual([{ id: 'library', kind: 'derived', template: `${PRIV}/v1/files/{h}`, auth: 'bearer' }]);
    expect((await fetch(`${PRIV}/index/${k.key.slice(3, 5)}.json`)).status).toBe(404);
    const reader = createResolver({ hostStores: items, token: () => 't-1' });
    expect(text((await reader.resolve(k.key, 'image/png'))!.bytes)).toBe(text(IMG));
  });

  it('withdrawing deletes only the standard path, never the adopted object', async () => {
    log.length = 0;
    const w = await fetch(`${LIB}/v1/assets/${k.key}/withdraw`, { method: 'POST', headers: { ...json, ...bearer('a-1') }, body: '{}' });
    expect(w.status).toBe(200);
    expect(log).toEqual([`DELETE ${standardPath(k.key)}`]);
    expect(objects.get(PATH)).toBeDefined();
    expect((await fetch(`${LIB}/v1/files/${k.key}`, { redirect: 'manual' })).status).toBe(410);
    expect((await fetch(`${LIB}/index/${k.key.slice(3, 5)}.json`)).status).toBe(404);
  });
});
