import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRegistryClient } from '@chalk-format/store';
import { isFileRead } from './app.js';
import { createLibraryApp, diskStorage, libraryFromEnv, openDb, tokenCallers, type Db, type DeliveryOptions, type LibraryOptions } from './index.js';

// PUBLIC_READ=files: a browser without a token still gets the files it was handed a key for; the catalogue and the books'
// text are for callers with a token (a site's server, a dashboard, a staff tool).
const BASE = 'http://library.test';
let db: Db, dir: string, app: ReturnType<typeof createLibraryApp>, key: string;

const options = (o: Partial<LibraryOptions & DeliveryOptions>): LibraryOptions & DeliveryOptions => ({
  db, storage: diskStorage(dir, { uploadBase: BASE, linkSecret: 'test link secret' }), publicUrl: `${BASE}/files/`, callers: tokenCallers('teacher:t-1,admin!:a-1'), ...o,
});
const req = (method: string, url: string, token?: string) =>
  app.fetch(new Request(`${BASE}${url}`, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} }));

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'chalk-files-only-'));
  db = await openDb('pglite:');
  app = createLibraryApp(options({ publicRead: true, publicReadScope: 'files' }));
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => app.fetch(new Request(input, init))) as typeof fetch;
  key = (await createRegistryClient(BASE, { token: 't-1', fetch: f }).add(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), { type: 'image/svg+xml', title: 'a figure', tags: ['book:a-book'] })).key;
}, 60_000);
afterAll(async () => { await db?.close(); rmSync(dir, { recursive: true, force: true }); });

describe('a library with PUBLIC_READ=files', () => {
  it('lets a caller without a token read the stores, one file, one record and its link', async () => {
    expect((await req('GET', '/v1/stores')).status).toBe(200);
    expect([200, 302]).toContain((await req('GET', `/v1/files/${key}`)).status);
    expect((await req('GET', `/v1/assets/${key}`)).status).toBe(200);
    expect((await req('HEAD', `/v1/assets/${encodeURIComponent(key)}`)).status).toBe(200);
  });

  it('refuses search, record lists, the books\' lines and links, and highlights without a token (401)', async () => {
    for (const [m, u] of [
      ['GET', '/v1/search?q=figure'], ['GET', '/v1/search?tag=book:a-book'], ['GET', `/v1/assets/${key}/books`],
      ['GET', '/v1/books/a-book/lines/all'], ['GET', '/v1/books/a-book/lines?pages=1'], ['GET', '/v1/books/a-book/links/all'],
      ['GET', '/v1/books/a-book/chapters'], ['GET', '/v1/books/a-book/pages/counts'], ['GET', '/v1/highlights/tagged?tag=x'],
      ['POST', '/v1/assets/current'], ['POST', '/v1/assets/check'],
    ] as const) expect((await req(m, u)).status, `${m} ${u}`).toBe(401);
  });

  it('answers them as before with a token', async () => {
    const r = await req('GET', '/v1/search?q=figure', 't-1');
    expect(r.status).toBe(200);
    expect(((await r.json()) as { items: { key: string }[] }).items.map((i) => i.key)).toContain(key);
    expect((await req('GET', '/v1/books/a-book/lines/all', 't-1')).status).toBe(200);
  });

  it('still refuses a write without a token, and a bad token everywhere', async () => {
    expect((await req('POST', '/v1/assets')).status).toBe(401);
    expect((await req('GET', '/v1/search?q=x', 'wrong')).status).toBe(401);
  });
});

describe('which reads are file reads', () => {
  it('only GET/HEAD of the stores, one file, one record, one link', () => {
    for (const p of ['/v1/stores', '/v1/files/c1:abc', '/v1/files/c1%3Aabc', '/v1/assets/c1:abc', '/v1/assets/c1:abc/link']) expect(isFileRead('GET', p), p).toBe(true);
    for (const p of ['/v1/search', '/v1/assets', '/v1/assets/c1:abc/books', '/v1/books/x/lines/all', '/v1/files/a/b', '/v1/highlights/tagged', '/v1/stores/x']) expect(isFileRead('GET', p), p).toBe(false);
    expect(isFileRead('POST', '/v1/stores')).toBe(false);
  });
});

describe('PUBLIC_READ from the environment', () => {
  it('takes true, files or false, and refuses anything else', async () => {
    const env = (v?: string) => ({ DATABASE_URL: 'pglite:', STORAGE: 'disk', DISK_DIR: join(tmpdir(), 'chalk-library-unused'), ...(v === undefined ? {} : { PUBLIC_READ: v }), AUTH_KEY_SECRET: 'a test secret of at least thirty-two characters' });
    for (const [v, read, scope] of [[undefined, true, 'all'], ['true', true, 'all'], ['files', true, 'files'], ['false', false, 'all']] as const) {
      const o = await libraryFromEnv(env(v));
      expect([o.publicRead, o.publicReadScope], String(v)).toEqual([read, scope]);
      await o.db.close();
    }
    await expect(libraryFromEnv(env('yes'))).rejects.toThrow(/PUBLIC_READ must be true, files or false/);
  }, 120_000);
});
