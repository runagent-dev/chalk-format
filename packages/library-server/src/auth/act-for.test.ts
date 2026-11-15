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
    // a request without a body (taking a link off) takes the person from the header
    const off = await fetchApp(`${BASE}/v1/books/${BOOK}/links/${plainLink.body.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${dash.key}`, 'Chalk-Actor': as } });
    expect(off.status, await off.clone().text()).toBe(200);
    expect((await db.query<{ reviewed_by: string; status: string }>('SELECT reviewed_by, status FROM book_links WHERE id = $1', [plainLink.body.id]))[0]).toEqual({ reviewed_by: RITA.id, status: 'rejected' });
  });

  it('rejects malformed bodies under Chalk-Actor without changing links; only an empty DELETE may omit JSON', async () => {
    const line = { key: 'malformed/0/0', pageId: 'malformed', pageNo: 18, idx: 0, block: 0, kind: 'body', text: 'preserved', textHash: 'hm', rects: [] };
    await call(`/v1/books/${BOOK}/lines/sync`, { token: 't-1', body: { lines: [line] } });
    const id = ((await call(`/v1/books/${BOOK}/lines/all`)).body.items as { id: string; key: string }[]).find((l) => l.key === line.key)!.id;
    const link = await call(`/v1/books/${BOOK}/links`, { token: dash.key, actor: actor(RITA), body: { questionId: Q1, lineId: id } });
    expect(link.status).toBe(201);
    const before = await db.query('SELECT * FROM book_links WHERE id = $1', [link.body.id]);
    for (const [method, path] of [
      ['PATCH', `/links/${link.body.id}`],
      ['DELETE', `/links/${link.body.id}`],
      ['POST', `/lines/${id}/links/remove`],
    ] as const) {
      for (const body of ['not json at all', '{"status":"rejec']) {
        const res = await fetchApp(`${BASE}/v1/books/${BOOK}${path}`, { method, body, headers: {
          Authorization: `Bearer ${dash.key}`, 'Chalk-Actor': actor(RITA), 'Content-Type': 'application/json',
        } });
        expect(res.status, `${method} ${path} ${body}`).toBe(400);
        expect(await db.query('SELECT * FROM book_links WHERE id = $1', [link.body.id])).toEqual(before);
      }
    }
    const emptyPost = await fetchApp(`${BASE}/v1/books/${BOOK}/lines/${id}/links/remove`, { method: 'POST', headers: { Authorization: `Bearer ${dash.key}`, 'Chalk-Actor': actor(RITA) } });
    expect(emptyPost.status).toBe(400);
    expect(await db.query('SELECT * FROM book_links WHERE id = $1', [link.body.id])).toEqual(before);
    const emptyDelete = await fetchApp(`${BASE}/v1/books/${BOOK}/links/${link.body.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${dash.key}`, 'Chalk-Actor': actor(RITA) } });
    expect(emptyDelete.status).toBe(200);
  });

  it('only a key acting for someone may write a staff: or system: id (400 actor_requires_act_for)', async () => {
    const line = { key: 'p8/0/0', pageId: 'p8', pageNo: 8, idx: 0, block: 0, kind: 'body', text: 'eight', textHash: 'h8', rects: [] };
    await call(`/v1/books/${BOOK}/lines/sync`, { token: 't-1', body: { lines: [line] } });
    const id = ((await call(`/v1/books/${BOOK}/lines/all`)).body.items as { id: string; key: string }[]).find((l) => l.key === 'p8/0/0')!.id;
    for (const token of [plain.key, 't-1', 'a-1', dash.key]) {
      for (const by of ['staff:5b0c3a52', 'system:library-sync', ' Staff:x']) {
        const link = await call(`/v1/books/${BOOK}/links`, { token, body: { questionId: Q1, lineId: id, by } });
        expect(link.status, `${token} ${by}`).toBe(400);
        expect(link.body.error.code).toBe('actor_requires_act_for');
      }
      const rects = await call(`/v1/books/${BOOK}/lines/${id}/rects`, { method: 'PUT', token, body: { rects: [{ x: 1, y: 1, w: 1, fs: 1 }], by: 'staff:rita' } });
      expect(rects.body.error.code).toBe('actor_requires_act_for');
    }
    expect((await db.query("SELECT 1 FROM book_links WHERE reviewed_by LIKE 'staff:%' AND line_id = $1", [id])).length).toBe(0);
    expect((await call(`/v1/books/${BOOK}/links`, { token: plain.key, body: { questionId: Q1, lineId: id, by: 'rafi' } })).status).toBe(201);
  });

  it('import restores the original reviewers: staff:/system: ones only from an act-for key or an administrator', async () => {
    const lineId = '33333333-3333-4333-8333-333333333333', linkId = '44444444-4444-4444-8444-444444444444';
    const restore = (reviewedBy: string) => ({
      lines: [{ id: lineId, key: 'p9/0/0', pageId: 'p9', pageNo: 9, idx: 0, block: 0, kind: 'body', text: 'nine', textHash: 'h9', rects: [] }],
      links: [{ id: linkId, questionId: Q1, lineId, role: 'answers_from', scope: 'sentence', method: 'human', status: 'confirmed', reviewedBy }],
    });
    const reviewer = async () => (await db.query<{ reviewed_by: string }>('SELECT reviewed_by FROM book_links WHERE id = $1', [linkId]))[0]?.reviewed_by;
    for (const token of [plain.key, 't-1']) {
      const r = await call(`/v1/books/${BOOK}/import`, { token, body: restore('staff:old-1') });
      expect(r.status, token).toBe(400);
      expect(r.body.error.code).toBe('actor_requires_act_for');
    }
    expect((await call(`/v1/books/${BOOK}/import`, { token: 't-1', body: restore('rafi') })).status).toBe(200);
    expect(await reviewer()).toBe('rafi');
    expect((await call(`/v1/books/${BOOK}/import`, { token: 'a-1', body: restore('staff:old-1') })).status).toBe(200);
    expect(await reviewer()).toBe('staff:old-1');
    // acting for someone, the restored rows keep their reviewers (the exception to §10.7)
    expect((await call(`/v1/books/${BOOK}/import`, { token: dash.key, actor: actor(RITA), body: restore('system:old-sync') })).status).toBe(200);
    expect(await reviewer()).toBe('system:old-sync');
  });

  it('records each person once in actors, with the latest name, after a change made for them; listed for administrators', async () => {
    await upload('rita, renamed', dash.key, actor({ ...RITA, name: '  Rita Akter ' }));
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

  it('reads, refusals and failed changes record no actor', async () => {
    const seen = async (id: string) => (await db.query('SELECT 1 FROM actors WHERE id = $1', [id])).length;
    expect((await call('/v1/search', { token: dash.key, actor: actor({ id: 'staff:reader-only', name: 'R' }) })).status).toBe(200);
    expect((await call('/v1/auth/me', { token: dash.key, actor: actor({ id: 'staff:reader-only', name: 'R' }) })).status).toBe(200);
    expect(await seen('staff:reader-only')).toBe(0);
    expect((await call('/v1/uploads', { token: plain.key, actor: actor({ id: 'staff:refused', name: 'R' }), body: {} })).status).toBe(403);
    expect((await call('/v1/admin/keys', { token: dash.key, actor: actor({ id: 'staff:refused', name: 'R' }), body: { name: 'x', roles: ['reader'] } })).status).toBe(403);
    expect((await call('/v1/uploads', { token: dash.key, actor: actor({ id: 'staff:failed', name: 'R' }), body: {} })).status).toBe(400);
    expect(await seen('staff:refused') + await seen('staff:failed')).toBe(0);
  });

  it('a malformed header is 400 and records nothing', async () => {
    const bad = ['', 'not base64!', actor('not json'), actor([RITA]), actor({ id: 'rita', name: 'Rita' }), actor({ id: 'staff:', name: 'Rita' }), actor({ id: `staff:${'x'.repeat(81)}`, name: 'Rita' }),
      actor({ id: 'user:1', name: 'Rita' }), actor({ id: 'staff:a b', name: 'Rita' }), actor({ id: 'staff:1' }), actor({ id: 'staff:1', name: '' }), actor({ id: 'staff:1', name: 'x'.repeat(121) }),
      actor({ id: 'staff:1', name: 'line\nbreak' }), actor({ id: 'staff:1', name: 7 }), actor({ id: 'staff:1', name: '   ' }), actor({ id: 'staff:1', name: 'c1\u0085control' }),
      actor({ id: 'staff:1', name: 'evil\u202Eright-to-left' }), actor({ id: 'staff:1', name: 'iso\u2067late' }), actor({ id: 'staff:1', name: 'line\u2028sep' }), actor({ id: 'staff:1', name: 'para\u2029sep' })];
    for (const h of bad) {
      const r = await call('/v1/uploads', { token: dash.key, actor: h, body: {} });
      expect(r.status, h).toBe(400);
      expect(r.body.error.code).toBe('invalid');
    }
    expect((await call('/v1/auth/me', { token: dash.key, actor: actor({ id: 'system:library-sync', name: ` ${'x'.repeat(120)} ` }) })).status).toBe(200);
    // Bengali (with its joiners) is a name like any other
    expect((await call('/v1/auth/me', { token: dash.key, actor: actor({ id: 'staff:2', name: 'রিতা আক্তার\u200C' }) })).body.actingFor.name).toBe('রিতা আক্তার\u200C');
    expect((await db.query("SELECT 1 FROM actors WHERE id = 'staff:1'")).length).toBe(0);
  });

  it('browsers are not offered it (CORS): an act-for key belongs on a server', async () => {
    const res = await fetchApp(`${BASE}/v1/uploads`, { method: 'OPTIONS', headers: { Origin: 'https://dashboard.example.org', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'chalk-actor' } });
    expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).not.toContain('chalk-actor');
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
