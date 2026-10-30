// A small in-process library server that follows the library authentication contract (users, access and refresh tokens, a bearer store),
// for the client's tests and the reader's sign-in e2e. NOT a server to deploy: tokens are JWT-shaped but not signed (the fake remembers which
// it issued), passwords are kept as given. Requests in, responses out (`handle`), so it serves as a `fetch` in unit tests and behind
// node:http in the browser e2e.
//
// What it does as the contract says: POST /v1/auth/token (password and refresh_token grants, JSON or form; 400 invalid_grant /
// invalid_request / unsupported_grant_type), refresh tokens rotated on every use and a reused one revoking its whole family, POST
// /v1/auth/revoke (always 200), GET /v1/auth/me, and with PUBLIC_READ=false: 401 without a valid access token on every /v1 route, a store
// advertised with `auth: 'bearer'` and template `<base>v1/files/{h}`, GET /v1/files/{h} serving the bytes.
import { assetKeyAndSha256 } from '@chalk-format/model';

export type FakeUser = { password: string; roles: string[]; sub?: string };
export type FakeItem = { key: string; sha256: string; bytes: Uint8Array; type: string; tags: string[]; createdAt: string };
type Refresh = { family: string; user: string; used: boolean; revoked: boolean };

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const random = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const enc = new TextEncoder();

export function fakeAuthLibrary(o: {
  /** The server's public base URL, ending in `/`. */
  base: string;
  users: Record<string, FakeUser>;
  /** Access token lifetime in seconds (the contract: 900). */
  accessSeconds?: number;
  /** The server's clock in ms (tests move it). */
  now?: () => number;
  /** Answer CORS (for a browser on another origin). */
  cors?: boolean;
}) {
  const now = o.now ?? Date.now;
  const accessSeconds = o.accessSeconds ?? 900;
  const items: FakeItem[] = [];
  const access = new Map<string, { user: string; exp: number }>();   // jti → who, until when (seconds)
  const refresh = new Map<string, Refresh>();
  /** What happened, for the tests: every request (path, whether it had a token, the status) and every grant. */
  const log: { method: string; path: string; token: boolean; status: number }[] = [];
  const grants: { grant: string; ok: boolean; error?: string }[] = [];

  const json = (v: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', ...headers } });
  const oauthError = (error: string, status = 400) => json({ error }, status);

  const issue = (username: string, family = random(16)) => {
    const u = o.users[username]!;
    const iat = Math.floor(now() / 1000), jti = random(12);
    const header = b64url(enc.encode(JSON.stringify({ alg: 'EdDSA', kid: 'fake-1', typ: 'JWT' })));
    const payload = b64url(enc.encode(JSON.stringify({ iss: o.base, aud: 'chalk-library', sub: u.sub ?? `u-${username}`, name: username, roles: u.roles, iat, exp: iat + accessSeconds, jti })));
    access.set(jti, { user: username, exp: iat + accessSeconds });
    const rt = random(32);
    refresh.set(rt, { family, user: username, used: false, revoked: false });
    return { access_token: `${header}.${payload}.${random(64)}`, token_type: 'Bearer', expires_in: accessSeconds, refresh_token: rt, roles: u.roles };
  };

  /** The user a request's bearer token names, or null (no token, unknown, expired). */
  const caller = (req: Request): string | null => {
    const h = req.headers.get('authorization');
    if (!h?.startsWith('Bearer ')) return null;
    const part = h.slice(7).split('.')[1];
    if (!part) return null;
    try {
      const claims = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as { jti?: string; exp?: number };
      const a = claims.jti ? access.get(claims.jti) : undefined;
      return a && a.exp > now() / 1000 ? a.user : null;
    } catch { return null; }
  };

  const revokeFamily = (family: string) => { for (const r of refresh.values()) if (r.family === family) r.revoked = true; };

  async function body(req: Request): Promise<Record<string, unknown>> {
    const text = await req.text();
    if ((req.headers.get('content-type') ?? '').includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
    try { const v: unknown = JSON.parse(text); return v && typeof v === 'object' ? v as Record<string, unknown> : {}; } catch { return {}; }
  }

  async function route(req: Request): Promise<Response> {
    const u = new URL(req.url);
    const path = u.pathname;
    if (req.method === 'POST' && path === '/v1/auth/token') {
      const b = await body(req);
      const grant = String(b.grant_type ?? '');
      const done = (r: Response, error?: string) => { grants.push({ grant, ok: r.ok, ...(error ? { error } : {}) }); return r; };
      if (grant === 'password') {
        if (typeof b.username !== 'string' || typeof b.password !== 'string') return done(oauthError('invalid_request'), 'invalid_request');
        const user = o.users[b.username];
        if (!user || user.password !== b.password) return done(oauthError('invalid_grant'), 'invalid_grant');
        return done(json(issue(b.username)));
      }
      if (grant === 'refresh_token') {
        if (typeof b.refresh_token !== 'string') return done(oauthError('invalid_request'), 'invalid_request');
        const r = refresh.get(b.refresh_token);
        if (!r || r.revoked) return done(oauthError('invalid_grant'), 'invalid_grant');
        // a rotated token used again: someone else has a copy; end the whole sign-in
        if (r.used) { revokeFamily(r.family); return done(oauthError('invalid_grant'), 'reused'); }
        r.used = true;
        return done(json(issue(r.user, r.family)));
      }
      return done(oauthError('unsupported_grant_type'), 'unsupported_grant_type');
    }
    if (req.method === 'POST' && path === '/v1/auth/revoke') {
      const b = await body(req);
      const r = typeof b.refresh_token === 'string' ? refresh.get(b.refresh_token) : undefined;
      if (r) revokeFamily(r.family);
      return json({});
    }
    if (!path.startsWith('/v1/')) return json({ error: { code: 'not_found', message: 'not found' } }, 404);
    // PUBLIC_READ=false: everything else needs a valid access token
    const who = caller(req);
    if (!who) return json({ error: { code: 'unauthorized', message: 'sign in first' } }, 401, { 'www-authenticate': 'Bearer' });
    if (path === '/v1/auth/me') { const user = o.users[who]!; return json({ sub: user.sub ?? `u-${who}`, name: who, roles: user.roles, kind: 'user' }); }
    if (path === '/v1/stores') return json({ items: [{ id: 'library', kind: 'derived', template: `${o.base}v1/files/{h}`, auth: 'bearer' }] });
    if (path === '/v1/search') {
      const tags = u.searchParams.getAll('tag');
      const hits = items.filter((i) => tags.every((t) => i.tags.includes(t))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return json({ items: hits.map((i) => ({ key: i.key, sha256: i.sha256, type: i.type, size: i.bytes.byteLength, tags: i.tags, status: 'available', createdAt: i.createdAt })) });
    }
    if (path.startsWith('/v1/files/')) {
      const h = path.slice('/v1/files/'.length);
      const hit = items.find((i) => i.key.slice(3) === h);
      return hit ? new Response(hit.bytes as unknown as BodyInit, { headers: { 'content-type': hit.type, 'cache-control': 'private, max-age=240' } }) : json({ error: { code: 'not_found', message: 'no such item' } }, 404);
    }
    return json({ error: { code: 'not_found', message: 'not found' } }, 404);
  }

  const corsHeaders = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, PUT, OPTIONS', 'access-control-max-age': '600' };

  async function handle(req: Request): Promise<Response> {
    if (o.cors && req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
    const r = await route(req);
    const u = new URL(req.url);
    log.push({ method: req.method, path: u.pathname, token: req.headers.has('authorization'), status: r.status });
    if (!o.cors) return r;
    const h = new Headers(r.headers);
    for (const [k, v] of Object.entries(corsHeaders)) h.set(k, v);
    return new Response(r.body, { status: r.status, headers: h });
  }

  return {
    handle,
    /** As a `fetch` (unit tests). */
    fetch: ((input: string | URL | Request, init?: RequestInit) => handle(new Request(input, init))) as typeof fetch,
    log, grants, items,
    /** Adds an item (bytes, type, tags); returns it. */
    async add(bytes: Uint8Array, type: string, tags: string[] = [], createdAt = new Date(now()).toISOString()): Promise<FakeItem> {
      const { key, sha256 } = await assetKeyAndSha256(bytes);
      const item = { key, sha256, bytes, type, tags, createdAt };
      items.push(item);
      return item;
    },
    /** The refresh tokens still usable (not used, not revoked). */
    liveRefreshTokens: () => [...refresh.entries()].filter(([, r]) => !r.used && !r.revoked).map(([t]) => t),
    /** Ends every sign-in at once (an admin disabling the user). */
    revokeAll: () => { for (const r of refresh.values()) r.revoked = true; },
  };
}
