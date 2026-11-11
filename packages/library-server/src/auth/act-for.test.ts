import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { c1FromSha256 } from '@chalk-format/model';
import { checkKeySetup, createLibraryApp, diskStorage, libraryFromEnv, openDb, tokenCallers, type Db } from '../index.js';

// a library whose dashboard key acts for the signed-in person (registry-api §10.7), and the same library with
// HUMAN_ACCOUNTS=off; a bootstrap administrator (a-1) and author (t-1)
const BASE = 'http://library.test';
const SECRET = 'a-test-secret-that-is-long-enough-0123456789';
const BOOK = 'physics-9-10-bn';
const Q1 = '11111111-1111-4111-8111-111111111111';
const RITA = { id: 'staff:5b0c3a52-6d2e-4f7e-9a51-0c1d2e3f4a5b', name: 'রিতা Rita' };
let db: Db, dir: string, app: ReturnType<typeof createLibraryApp>;
const make = (humanAccounts = true) => createLibraryApp({
  db, storage: diskStorage(dir, { uploadBase: BASE }), publicUrl: `${BASE}/files/`, callers: tokenCallers('ci:t-1,root!:a-1'),
  publicRead: true, issuer: BASE, auth: { rateLimit: { perUser: 1000, perAddress: 1000 }, keySecret: SECRET, humanAccounts },
});
const fetchApp = (async (input: RequestInfo | URL, init?: RequestInit) => app.fetch(new Request(input, init))) as typeof fetch;
const actor = (a: unknown) => Buffer.from(typeof a === 'string' ? a : JSON.stringify(a)).toString('base64url');
const call = async (path: string, o: { method?: string; token?: string; body?: unknown; actor?: string } = {}) => {
  const res = await fetchApp(`${BASE}${path}`, {
    method: o.method ?? (o.body !== undefined ? 'POST' : 'GET'),
    headers: { ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}), ...(o.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(o.actor !== undefined ? { 'Chalk-Actor': o.actor } : {}) },
    ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- answers of many shapes, checked by the assertions
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};
/** Uploads and registers bytes as `token` (acting for `as`): the asset record. */
const upload = async (text: string, token: string, as?: string) => {
  const bytes = new TextEncoder().encode(text), sha256 = createHash('sha256').update(bytes).digest('hex'), key = c1FromSha256(`sha256:${sha256}`);
  const r = await call('/v1/uploads', { token, ...(as ? { actor: as } : {}), body: { key, sha256, type: 'image/png', size: bytes.byteLength } });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  await fetchApp(r.body.upload.url, { method: 'PUT', headers: r.body.upload.headers ?? {}, body: bytes });
  const reg = await call('/v1/assets', { token, ...(as ? { actor: as } : {}), body: { key, sha256, type: 'image/png', size: bytes.byteLength, title: text } });
  expect(reg.status, JSON.stringify(reg.body)).toBe(200);
  return reg.body as { key: string; uploadedBy: string };
};
let dash: { id: string; key: string }, plain: { id: string; key: string };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'chalk-library-actfor-'));
  const pg = process.env.CHALK_LIBRARY_TEST_DB;
  db = await openDb(pg ?? 'pglite:', pg ? { schema: `actfor_test_${Date.now().toString(36)}` } : {});
  app = make();
  const k1 = await call('/v1/admin/keys', { token: 'a-1', body: { name: 'pathshalax-dashboard', roles: ['author'], actFor: true } });
  expect(k1.status).toBe(201);
  dash = k1.body;
  plain = (await call('/v1/admin/keys', { token: 'a-1', body: { name: 'library-sync', roles: ['author'] } })).body;
}, 60_000);
afterAll(async () => { await db?.close(); rmSync(dir, { recursive: true, force: true }); });

describe('an API key acting for a person (Chalk-Actor)', () => {
  it('keys say whether they act for people; an administrator turns it on and off', async () => {
    expect(dash).toMatchObject({ name: 'pathshalax-dashboard', actFor: true });
    expect(plain).toMatchObject({ actFor: false });
    const list = (await call('/v1/admin/keys', { token: 'a-1' })).body.items as { id: string; actFor: boolean }[];
    expect(list.find((k) => k.id === dash.id)?.actFor).toBe(true);
    expect((await call(`/v1/admin/keys/${plain.id}`, { method: 'PATCH', token: 'a-1', body: { actFor: true } })).body).toMatchObject({ id: plain.id, actFor: true });
    expect((await call('/v1/auth/me', { token: plain.key, actor: actor({ id: 'system:test', name: 'test' }) })).status).toBe(200);
    expect((await call(`/v1/admin/keys/${plain.id}`, { method: 'PATCH', token: 'a-1', body: { actFor: false } })).body).toMatchObject({ actFor: false });
    expect((await call(`/v1/admin/keys/${plain.id}`, { method: 'PATCH', token: 't-1', body: { actFor: true } })).status).toBe(403);
    expect((await call('/v1/admin/keys/no-such-key', { method: 'PATCH', token: 'a-1', body: { actFor: true } })).status).toBe(404);
    expect((await call(`/v1/admin/keys/${plain.id}`, { method: 'PATCH', token: 'a-1', body: { roles: ['admin'] } })).status).toBe(400);
  });

  it('an upload records the person\'s id, not the key\'s name; ?mine=1 is that person\'s', async () => {
    const a = await upload('rita made this', dash.key, actor(RITA));
    expect(a.uploadedBy).toBe(RITA.id);
    const b = await upload('the dashboard itself', dash.key);
    expect(b.uploadedBy).toBe('pathshalax-dashboard');
    const mine = async (as?: string) => ((await call('/v1/search?mine=1', { token: dash.key, ...(as ? { actor: as } : {}) })).body.items as { key: string }[]).map((x) => x.key);
    expect(await mine(actor(RITA))).toEqual([a.key]);
    expect(await mine()).toEqual([b.key]);
    expect(await mine(actor({ id: 'staff:someone-else', name: 'Someone' }))).toEqual([]);
  });

  it('highlight changes record the person: links, reviews, drawn boxes (the body\'s `by` is replaced, or may be left out)', async () => {
    const line = (idx: number) => ({ key: `p6/${idx}/0`, pageId: 'p6', pageNo: 6, idx, block: 0, kind: 'body', text: `line ${idx}`, textHash: `h${idx}`, rects: [{ x: 100, y: 100 + idx * 30, w: 500, fs: 18 }] });
    expect((await call(`/v1/books/${BOOK}/lines/sync`, { token: dash.key, body: { lines: [line(0), line(1)] } })).status).toBe(200);
    const ids = Object.fromEntries(((await call(`/v1/books/${BOOK}/lines/all`)).body.items as { id: string; key: string }[]).map((l) => [l.key, l.id]));
    const as = actor(RITA);
    const link = await call(`/v1/books/${BOOK}/links`, { token: dash.key, actor: as, body: { questionId: Q1, lineId: ids['p6/0/0'], by: 'someone-else' } });
    expect(link.status, JSON.stringify(link.body)).toBe(201);
    expect(link.body).toMatchObject({ reviewedBy: RITA.id });
    const moved = await call(`/v1/books/${BOOK}/links/${link.body.id}`, { method: 'PATCH', token: dash.key, actor: actor({ id: 'staff:arun-1', name: 'Arun' }), body: { lineId: ids['p6/1/0'] } });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body).toMatchObject({ reviewedBy: 'staff:arun-1' });
    const drawn = await call(`/v1/books/${BOOK}/lines/${ids['p6/0/0']}/rects`, { method: 'PUT', token: dash.key, actor: as, body: { rects: [{ x: 140, y: 100, w: 380, fs: 18 }] } });
    expect(drawn.body.line).toMatchObject({ rectsManual: true, rectsBy: RITA.id });
    // without the header the body's `by` is kept, as before
    const plainLink = await call(`/v1/books/${BOOK}/links`, { token: dash.key, body: { questionId: Q1, lineId: ids['p6/0/0'], by: 'library-sync' } });
    expect(plainLink.body).toMatchObject({ reviewedBy: 'library-sync' });
    // and is still required then
    expect((await call(`/v1/books/${BOOK}/links`, { token: dash.key, body: { questionId: Q1, lineId: ids['p6/0/0'] } })).status).toBe(400);
  });

  it('records each person once in actors, with the latest name; listed for administrators', async () => {
    expect((await call('/v1/auth/me', { token: dash.key, actor: actor({ ...RITA, name: 'Rita Akter' }) })).status).toBe(200);
    const list = await call('/v1/admin/actors', { token: 'a-1' });
    expect(list.status).toBe(200);
    const items = list.body.items as { id: string; name: string; firstSeenAt: string; lastSeenAt: string }[];
    expect(items.filter((a) => a.id === RITA.id)).toEqual([expect.objectContaining({ id: RITA.id, name: 'Rita Akter' })]);
    expect(items.map((a) => a.id)).toContain('staff:arun-1');
    expect((await call('/v1/admin/actors', { token: 't-1' })).status).toBe(403);
  });

  it('who am I: the key, and the person it acts for', async () => {
    const me = await call('/v1/auth/me', { token: dash.key, actor: actor(RITA) });
    expect(me.body).toMatchObject({ sub: dash.id, name: 'pathshalax-dashboard', kind: 'api-key', actFor: true, actingFor: RITA });
    expect((await call('/v1/auth/me', { token: dash.key })).body).not.toHaveProperty('actingFor');
  });

  it('from any other caller the header is refused (403 act_for_not_allowed), never ignored', async () => {
    for (const token of [plain.key, 't-1', 'a-1', undefined]) {
      const r = await call('/v1/search', { ...(token ? { token } : {}), actor: actor(RITA) });
      expect(r.status, String(token)).toBe(403);
      expect(r.body.error.code).toBe('act_for_not_allowed');
    }
    // a token that is not valid stays a 401 (the client should sign in again), header or not
    expect((await call('/v1/uploads', { token: 'clk_not-a-key', actor: actor(RITA), body: {} })).status).toBe(401);
  });

  it('a malformed header is 400 and records nothing', async () => {
    const bad = ['', 'not base64!', actor('not json'), actor([RITA]), actor({ id: 'rita', name: 'Rita' }), actor({ id: 'staff:', name: 'Rita' }), actor({ id: `staff:${'x'.repeat(81)}`, name: 'Rita' }),
      actor({ id: 'user:1', name: 'Rita' }), actor({ id: 'staff:a b', name: 'Rita' }), actor({ id: 'staff:1' }), actor({ id: 'staff:1', name: '' }), actor({ id: 'staff:1', name: 'x'.repeat(121) }),
      actor({ id: 'staff:1', name: 'line\nbreak' }), actor({ id: 'staff:1', name: 7 })];
    for (const h of bad) {
      const r = await call('/v1/uploads', { token: dash.key, actor: h, body: {} });
      expect(r.status, h).toBe(400);
      expect(r.body.error.code).toBe('invalid');
    }
    expect((await call('/v1/auth/me', { token: dash.key, actor: actor({ id: 'system:library-sync', name: 'x'.repeat(120) }) })).status).toBe(200);
    expect((await db.query("SELECT 1 FROM actors WHERE id = 'staff:1'")).length).toBe(0);
  });

  it('browsers may send it (CORS)', async () => {
    const res = await fetchApp(`${BASE}/v1/uploads`, { method: 'OPTIONS', headers: { Origin: 'https://dashboard.example.org', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'chalk-actor' } });
    expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('chalk-actor');
  });
});

describe('HUMAN_ACCOUNTS=off', { timeout: 30_000 }, () => {
  it('no sign-in, refresh or user administration; users\' tokens are refused; keys and bootstrap tokens work', async () => {
    // a user signed in while accounts were on
    app = make(true);
    expect((await call('/v1/admin/users', { token: 'a-1', body: { username: 'rita', password: 'reader-password-1', roles: ['author'] } })).status).toBe(201);
    const t = await call('/v1/auth/token', { body: { grant_type: 'password', username: 'rita', password: 'reader-password-1' } });
    expect(t.status).toBe(200);
    expect((await call('/v1/auth/me', { token: t.body.access_token })).status).toBe(200);

    app = make(false);
    const pw = await call('/v1/auth/token', { body: { grant_type: 'password', username: 'rita', password: 'reader-password-1' } });
    expect(pw).toMatchObject({ status: 400, body: { error: 'unsupported_grant_type' } });
    expect(await call('/v1/auth/token', { body: { grant_type: 'refresh_token', refresh_token: t.body.refresh_token } })).toMatchObject({ status: 400, body: { error: 'unsupported_grant_type' } });
    expect((await call('/v1/auth/me', { token: t.body.access_token })).status).toBe(401);
    expect((await call('/v1/uploads', { token: t.body.access_token, body: {} })).status).toBe(401);
    expect((await call('/v1/admin/users', { token: 'a-1' })).status).toBe(404);
    expect((await call('/v1/admin/users', { token: 'a-1', body: { username: 'arun', password: 'author-password-1', roles: ['author'] } })).status).toBe(404);
    expect((await call('/v1/admin/users/x', { method: 'PATCH', token: 'a-1', body: { disabled: true } })).status).toBe(404);
    const conf = (await call('/.well-known/openid-configuration')).body as { grant_types_supported: string[] };
    expect(conf.grant_types_supported).toEqual([]);
    // machines keep working, acting for people included
    expect((await call('/v1/auth/me', { token: 't-1' })).body).toMatchObject({ kind: 'bootstrap' });
    expect((await call('/v1/admin/keys', { token: 'a-1' })).status).toBe(200);
    expect((await upload('made while accounts are off', dash.key, actor(RITA))).uploadedBy).toBe(RITA.id);
    app = make(true);
  });

  it('a library with users but HUMAN_ACCOUNTS=off starts without AUTH_KEY_SECRET (no user can sign in)', async () => {
    const d = await openDb('pglite:');
    try {
      await d.query("INSERT INTO auth_users (id, username, password_hash, roles) VALUES ('u1', 'rita', 'x', '{reader}')");
      await expect(checkKeySetup(d, { publicRead: true })).rejects.toThrow(/user accounts/);
      await expect(checkKeySetup(d, { publicRead: true, humanAccounts: false })).resolves.toBeUndefined();
    } finally { await d.close(); }
    await expect(libraryFromEnv({ DATABASE_URL: 'pglite:', HUMAN_ACCOUNTS: 'maybe' })).rejects.toThrow(/HUMAN_ACCOUNTS must be on or off/);
    const o = await libraryFromEnv({ DATABASE_URL: 'pglite:', HUMAN_ACCOUNTS: 'off' });
    expect(o.auth?.humanAccounts).toBe(false);
    await o.db.close();
  }, 60_000);
});
