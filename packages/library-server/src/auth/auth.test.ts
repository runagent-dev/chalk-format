import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { checkLibrary, createLibraryApp, diskStorage, openDb, tokenCallers, type Db } from '../index.js';
import { keyFromPem, signAccessToken } from './jwt.js';

// a private library (PUBLIC_READ=false) in this process, with a bootstrap author (t-1) and administrator (a-1)
const BASE = 'http://library.test';
let db: Db, dir: string, app: ReturnType<typeof createLibraryApp>;
const fetchApp = (async (input: RequestInfo | URL, init?: RequestInit) => app.fetch(new Request(input, init))) as typeof fetch;
const call = (path: string, o: { method?: string; token?: string; body?: unknown; form?: Record<string, string> } = {}) => fetchApp(`${BASE}${path}`, {
  method: o.method ?? (o.body || o.form ? 'POST' : 'GET'),
  headers: { ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}), ...(o.form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : o.body ? { 'Content-Type': 'application/json' } : {}) },
  ...(o.form ? { body: new URLSearchParams(o.form).toString() } : o.body ? { body: JSON.stringify(o.body) } : {}),
});
type Tokens = { access_token: string; refresh_token: string; expires_in: number; token_type: string; roles: string[] };
const signIn = async (username: string, password: string) => call('/v1/auth/token', { body: { grant_type: 'password', username, password } });
const tokensOf = async (username: string, password: string) => { const r = await signIn(username, password); expect(r.status).toBe(200); return (await r.json()) as Tokens; };
const refresh = (refresh_token: string) => call('/v1/auth/token', { body: { grant_type: 'refresh_token', refresh_token } });
const part = (t: string, i: number) => JSON.parse(Buffer.from(t.split('.')[i]!, 'base64url').toString()) as Record<string, unknown>;
const b64 = (x: unknown) => (Buffer.isBuffer(x) ? x : Buffer.from(typeof x === 'string' ? x : JSON.stringify(x))).toString('base64url');
const PW = { rita: 'reader-password-1', arun: 'author-password-1', ada: 'admin-password-1', dan: 'disabled-password-1' };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'chalk-library-auth-'));
  db = await openDb('pglite:');
  app = createLibraryApp({
    db, storage: diskStorage(dir, { uploadBase: BASE }), publicUrl: `${BASE}/files/`, callers: tokenCallers('ci:t-1,root!:a-1'),
    publicRead: false, issuer: BASE, auth: { rateLimit: { perUser: 1000, perAddress: 1000 } },
  });
  for (const [username, roles] of [['rita', ['reader']], ['arun', ['author']], ['ada', ['admin']], ['dan', ['reader']]] as const) {
    const r = await call('/v1/admin/users', { token: 'a-1', body: { username, password: PW[username], roles } });
    expect(r.status, await r.clone().text()).toBe(201);
  }
}, 60_000);
afterAll(async () => { await db?.close(); rmSync(dir, { recursive: true, force: true }); });

// scrypt makes every sign-in take a moment on purpose
describe('the library as its own identity provider', { timeout: 30_000 }, () => {
  it('publishes its keys and its endpoints', async () => {
    const conf = await (await call('/.well-known/openid-configuration')).json() as Record<string, unknown>;
    expect(conf).toMatchObject({ issuer: BASE, jwks_uri: `${BASE}/.well-known/jwks.json`, token_endpoint: `${BASE}/v1/auth/token` });
    const jwks = await (await call('/.well-known/jwks.json')).json() as { keys: Record<string, string>[] };
    expect(jwks.keys[0]).toMatchObject({ kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', use: 'sig' });
    expect(Object.keys(jwks.keys[0]!)).not.toContain('d');
  });

  it('signs in with a password: an EdDSA access token with the contract claims, and a refresh token', async () => {
    const t = await tokensOf('Rita', PW.rita);
    expect(t).toMatchObject({ token_type: 'Bearer', expires_in: 900, roles: ['reader'] });
    expect(t.refresh_token.length).toBeGreaterThanOrEqual(43);
    const h = part(t.access_token, 0), c = part(t.access_token, 1);
    const jwks = await (await call('/.well-known/jwks.json')).json() as { keys: { kid: string }[] };
    expect(h).toMatchObject({ alg: 'EdDSA', typ: 'JWT' });
    expect(jwks.keys.map((k) => k.kid)).toContain(h.kid);
    expect(c).toMatchObject({ iss: BASE, aud: 'chalk-library', name: 'rita', roles: ['reader'] });
    expect((c.exp as number) - (c.iat as number)).toBe(900);
    expect(typeof c.jti).toBe('string');
    expect(await (await call('/v1/auth/me', { token: t.access_token })).json()).toMatchObject({ sub: c.sub, name: 'rita', roles: ['reader'], kind: 'user' });
    // form-encoded too, as OAuth clients send it
    expect((await call('/v1/auth/token', { form: { grant_type: 'password', username: 'rita', password: PW.rita } })).status).toBe(200);
  });

  it('refuses a wrong password and an unknown user with the same answer', async () => {
    const wrong = await signIn('rita', 'not-the-password');
    const unknown = await signIn('nobody', 'not-the-password');
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toEqual(await unknown.json());
    expect((await call('/v1/auth/token', { body: { grant_type: 'client_credentials' } })).status).toBe(400);
    expect(await (await call('/v1/auth/token', { body: { grant_type: 'client_credentials' } })).json()).toMatchObject({ error: 'unsupported_grant_type' });
    expect(await (await call('/v1/auth/token', { body: { username: 'rita' } })).json()).toMatchObject({ error: 'invalid_request' });
  });

  it('a disabled user cannot sign in, refresh, or use a token it already has', async () => {
    const t = await tokensOf('dan', PW.dan);
    expect((await call('/v1/search', { token: t.access_token })).status).toBe(200);
    const id = part(t.access_token, 1).sub as string;
    expect((await call(`/v1/admin/users/${id}`, { method: 'PATCH', token: 'a-1', body: { disabled: true } })).status).toBe(200);
    expect(await (await signIn('dan', PW.dan)).json()).toMatchObject({ error: 'invalid_grant' });
    expect((await refresh(t.refresh_token)).status).toBe(400);
    expect((await call('/v1/search', { token: t.access_token })).status).toBe(401);
    await call(`/v1/admin/users/${id}`, { method: 'PATCH', token: 'a-1', body: { disabled: false } });
    expect((await signIn('dan', PW.dan)).status).toBe(200);
  });

  it('refuses expired, forged, other-key, other-audience, other-issuer and tampered tokens, and alg none or HS256', async () => {
    const t = await tokensOf('rita', PW.rita);
    const kid = part(t.access_token, 0).kid as string;
    const row = (await db.query<{ public_key: string; private_key: string }>('SELECT public_key, private_key FROM auth_keys WHERE kid = $1', [kid]))[0]!;
    const real = keyFromPem(kid, row.public_key, row.private_key);
    const claims = { iss: BASE, sub: part(t.access_token, 1).sub as string, name: 'rita', roles: ['reader'] };
    const ok = (token: string) => call('/v1/search', { token }).then((r) => r.status);
    expect(await ok(signAccessToken(real, claims, 900))).toBe(200);
    // within the clock skew, and past it
    expect(await ok(signAccessToken(real, claims, 900, Date.now() - 900_000 - 10_000))).toBe(200);
    expect(await ok(signAccessToken(real, claims, 900, Date.now() - 900_000 - 60_000))).toBe(401);
    // issued in the future
    expect(await ok(signAccessToken(real, claims, 900, Date.now() + 120_000))).toBe(401);
    // another issuer; another audience (signed by hand with the real key)
    expect(await ok(signAccessToken(real, { ...claims, iss: 'http://other.test' }, 900))).toBe(401);
    const handSigned = (header: object, payload: object) => {
      const input = `${b64(header)}.${b64(payload)}`;
      return `${input}.${b64(sign(null, Buffer.from(input), real.privateKey!))}`;
    };
    const now = Math.floor(Date.now() / 1000), base = { ...claims, aud: 'chalk-library', iat: now, exp: now + 900, jti: 'x' };
    expect(await ok(handSigned({ alg: 'EdDSA', kid }, base))).toBe(200);
    expect(await ok(handSigned({ alg: 'EdDSA', kid }, { ...base, aud: 'another-api' }))).toBe(401);
    expect(await ok(handSigned({ alg: 'EdDSA', kid }, { ...base, exp: undefined }))).toBe(401);
    // a key of our own making, under the library's kid and under another kid
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const forger = { kid, privateKey, publicKey };
    expect(await ok(signAccessToken(forger, claims, 900))).toBe(401);
    expect(await ok(signAccessToken({ ...forger, kid: 'not-a-library-key' }, claims, 900))).toBe(401);
    // a token whose claims were changed after signing
    const [h, , s] = t.access_token.split('.');
    expect(await ok(`${h}.${b64({ ...part(t.access_token, 1), roles: ['admin'] })}.${s}`)).toBe(401);
    // alg none, and HS256 keyed with the public key (the classic confusion)
    expect(await ok(`${b64({ alg: 'none', kid })}.${b64(base)}.`)).toBe(401);
    expect(await ok(`${b64({ alg: 'none', kid })}.${b64(base)}.${b64('x')}`)).toBe(401);
    const hsInput = `${b64({ alg: 'HS256', kid, typ: 'JWT' })}.${b64(base)}`;
    expect(await ok(`${hsInput}.${createHmac('sha256', row.public_key).update(hsInput).digest('base64url')}`)).toBe(401);
    expect(await ok('not.a.token')).toBe(401);
    const r = await call('/v1/search', { token: 'garbage' });
    expect(r.headers.get('www-authenticate')).toContain('invalid_token');
  });

  it('rotates refresh tokens, and reusing one revokes the whole sign-in', async () => {
    const first = await tokensOf('arun', PW.arun);
    const r2 = await refresh(first.refresh_token);
    expect(r2.status).toBe(200);
    const second = (await r2.json()) as Tokens;
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(second.roles).toEqual(['reader', 'author']);
    // the first one again: theft. Both it and its successor stop working; another sign-in is not touched
    const other = await tokensOf('arun', PW.arun);
    expect(await (await refresh(first.refresh_token)).json()).toMatchObject({ error: 'invalid_grant' });
    expect((await refresh(second.refresh_token)).status).toBe(400);
    expect((await refresh(other.refresh_token)).status).toBe(200);
    // signing out: always 200; the token is done
    const t = await tokensOf('arun', PW.arun);
    expect((await call('/v1/auth/revoke', { body: { refresh_token: t.refresh_token } })).status).toBe(200);
    expect((await refresh(t.refresh_token)).status).toBe(400);
    expect((await call('/v1/auth/revoke', { body: { refresh_token: 'never-issued' } })).status).toBe(200);
    expect((await refresh('never-issued')).status).toBe(400);
  });

  it('limits sign-in attempts per username and per address', async () => {
    const limited = createLibraryApp({ db, storage: diskStorage(dir, { uploadBase: BASE }), publicUrl: `${BASE}/files/`, callers: () => null, issuer: BASE, auth: { rateLimit: { perUser: 3, perAddress: 6 } } });
    const post = (body: object) => limited.fetch(new Request(`${BASE}/v1/auth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await post({ grant_type: 'password', username: 'rita', password: 'wrong-guess-' + i })).status);
    expect(statuses).toEqual([400, 400, 400, 429]);
    const r = await post({ grant_type: 'password', username: 'rita', password: PW.rita });
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    // other names from the same address, until the address is limited too
    expect((await post({ grant_type: 'password', username: 'arun', password: PW.arun })).status).toBe(200);
    expect((await post({ grant_type: 'refresh_token', refresh_token: 'x' })).status).toBe(429);
  });

  it('one role check for every route: a reader cannot write, an author cannot withdraw or manage users', async () => {
    const rita = (await tokensOf('rita', PW.rita)).access_token, arun = (await tokensOf('arun', PW.arun)).access_token, ada = (await tokensOf('ada', PW.ada)).access_token;
    const { assetKeyAndSha256 } = await import('@chalk-format/model');
    const { createRegistryClient } = await import('@chalk-format/store');
    const bytes = new TextEncoder().encode(`roles ${Date.now()}`);
    const k = await assetKeyAndSha256(bytes);
    const upload = { ...k, type: 'image/png', size: bytes.byteLength };
    expect((await call('/v1/uploads', { body: upload })).status).toBe(401);
    expect((await call('/v1/uploads', { token: rita, body: upload })).status).toBe(403);
    expect((await call('/v1/assets', { token: rita, body: upload })).status).toBe(403);
    expect((await call('/v1/books/b/assets', { method: 'PUT', token: rita, body: { keys: [] } })).status).toBe(403);
    expect((await call('/v1/search', { token: rita })).status).toBe(200);
    expect((await call('/v1/assets/check', { token: rita, body: { keys: [k.key] } })).status).toBe(200);
    const added = await createRegistryClient(BASE, { token: arun, fetch: fetchApp }).add(bytes, { type: 'image/png', title: 'roles' });
    expect(added.uploadedBy).toBe('arun');
    expect((await call(`/v1/assets/${added.key}/withdraw`, { token: arun, body: { reason: 'x' } })).status).toBe(403);
    expect((await call(`/v1/assets/${added.key}/withdraw`, { token: rita, body: { reason: 'x' } })).status).toBe(403);
    expect((await call('/v1/admin/users', { token: arun })).status).toBe(403);
    expect((await call('/v1/admin/keys', { token: arun, body: { name: 'x', roles: ['admin'] } })).status).toBe(403);
    expect((await call(`/v1/assets/${added.key}/withdraw`, { token: ada, body: { reason: 'x' } })).status).toBe(200);
    expect((await call('/v1/admin/users', { token: ada })).status).toBe(200);
  });

  it('bootstrap tokens keep working: plain ones are authors, ! ones administrators', async () => {
    expect(await (await call('/v1/auth/me', { token: 't-1' })).json()).toEqual({ sub: 'ci', name: 'ci', roles: ['reader', 'author'], kind: 'bootstrap' });
    expect(await (await call('/v1/auth/me', { token: 'a-1' })).json()).toEqual({ sub: 'root', name: 'root', roles: ['reader', 'author', 'admin'], kind: 'bootstrap' });
    expect((await call('/v1/auth/me')).status).toBe(401);
  });

  it('API keys: shown once, stored hashed, used as a bearer token, revocable', async () => {
    const r = await call('/v1/admin/keys', { token: 'a-1', body: { name: 'publisher', roles: ['author'] } });
    expect(r.status).toBe(201);
    const { id, key } = (await r.json()) as { id: string; key: string };
    expect(key).toMatch(/^clk_[A-Za-z0-9_-]{43}$/);
    expect(await (await call('/v1/auth/me', { token: key })).json()).toEqual({ sub: id, name: 'publisher', roles: ['reader', 'author'], kind: 'api-key' });
    const { assetKeyAndSha256 } = await import('@chalk-format/model');
    const k = await assetKeyAndSha256(new TextEncoder().encode(`key ${Date.now()}`));
    expect((await call('/v1/uploads', { token: key, body: { ...k, type: 'image/png', size: 10 } })).status).toBe(200);
    await new Promise((res) => setTimeout(res, 50));
    const listed = (await (await call('/v1/admin/keys', { token: 'a-1' })).json()) as { items: Record<string, unknown>[] };
    const mine = listed.items.find((i) => i.id === id)!;
    expect(JSON.stringify(listed)).not.toContain(key);
    expect(mine.lastUsedAt).toBeTruthy();
    expect((await call(`/v1/admin/keys/${id}`, { method: 'DELETE', token: 'a-1' })).status).toBe(200);
    expect((await call('/v1/search', { token: key })).status).toBe(401);
    expect((await call(`/v1/admin/keys/${id}`, { method: 'DELETE', token: 'a-1' })).status).toBe(404);
  });

  it('checks what an administrator sends: roles, password length, names taken', async () => {
    expect((await call('/v1/admin/users', { token: 'a-1', body: { username: 'short', password: 'short', roles: ['reader'] } })).status).toBe(400);
    expect((await call('/v1/admin/users', { token: 'a-1', body: { username: 'x', password: 'long-enough-1', roles: ['owner'] } })).status).toBe(400);
    expect((await call('/v1/admin/users', { token: 'a-1', body: { username: 'RITA', password: 'long-enough-1', roles: ['reader'] } })).status).toBe(409);
    expect((await call('/v1/admin/users/nope', { method: 'PATCH', token: 'a-1', body: { disabled: true } })).status).toBe(404);
  });

  it('rotating the signing key keeps tokens signed with the old one valid until they expire', async () => {
    const { createAuth } = await import('./service.js');
    const before = await tokensOf('rita', PW.rita);
    await createAuth({ db }).rotateSigningKey();
    await new Promise((res) => setTimeout(res, 5_100));
    // this app re-reads its keys when it meets a kid it does not know, or every 5 minutes
    expect((await call('/v1/search', { token: before.access_token })).status).toBe(200);
    const jwks = (await (await call('/.well-known/jwks.json')).json()) as { keys: { kid: string }[] };
    expect(jwks.keys.length).toBeGreaterThanOrEqual(2);
    expect(jwks.keys.map((k) => k.kid)).toContain(part(before.access_token, 0).kid);
  });

  it('passes the conformance check signed in with a username and a password', async () => {
    const results = await checkLibrary(BASE, { username: 'arun', password: PW.arun, fetch: fetchApp });
    expect(results.filter((r) => !r.ok), JSON.stringify(results.filter((r) => !r.ok))).toEqual([]);
    expect(results.map((r) => r.name)).toContain('a refresh token gives new tokens once, and using it again ends the sign-in');
  });

  it('never writes a password, a refresh token or an API key to the log, and keeps only hashes', async () => {
    const out: string[] = [];
    const spies = (['log', 'error', 'warn', 'info', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); }));
    const writes = [vi.spyOn(process.stdout, 'write'), vi.spyOn(process.stderr, 'write')].map((s) => s.mockImplementation((c: unknown) => { out.push(String(c)); return true; }));
    try {
      const secretPw = 'a-very-secret-password-9';
      await call('/v1/admin/users', { token: 'a-1', body: { username: 'sam', password: secretPw, roles: ['reader'] } });
      await signIn('sam', 'a-wrong-secret-guess-9');
      const t = await tokensOf('sam', secretPw);
      const r2 = (await (await refresh(t.refresh_token)).json()) as Tokens;
      await refresh(t.refresh_token);
      const { key } = (await (await call('/v1/admin/keys', { token: 'a-1', body: { name: 'logs', roles: ['reader'] } })).json()) as { key: string };
      await call('/v1/search', { token: key });
      await call('/v1/auth/token', { body: { grant_type: 'password', username: 'sam', password: { not: 'a string' } } });
      const secrets = [secretPw, 'a-wrong-secret-guess-9', t.refresh_token, r2.refresh_token, key, t.access_token];
      const logged = out.join('\n');
      for (const s of secrets) expect(logged).not.toContain(s);
      const stored = JSON.stringify(await Promise.all(['auth_users', 'auth_refresh_tokens', 'auth_api_keys'].map((x) => db.query(`SELECT * FROM ${x}`))));
      for (const s of secrets) expect(stored).not.toContain(s);
    } finally { [...spies, ...writes].forEach((s) => s.mockRestore()); }
  });

  it('a public library (PUBLIC_READ=true) reads without a token, as before, even with a token it does not know', async () => {
    const pub = createLibraryApp({ db, storage: diskStorage(dir, { uploadBase: BASE }), publicUrl: `${BASE}/files/`, callers: tokenCallers('ci:t-1'), issuer: BASE });
    expect((await pub.fetch(new Request(`${BASE}/v1/search`))).status).toBe(200);
    expect((await pub.fetch(new Request(`${BASE}/v1/search`, { headers: { Authorization: 'Bearer stale' } }))).status).toBe(200);
    expect((await pub.fetch(new Request(`${BASE}/v1/uploads`, { method: 'POST', body: '{}' }))).status).toBe(401);
  });
});
