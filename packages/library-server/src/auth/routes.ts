import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { requireRole, type AuthVariables } from './guard.js';
import { rateLimiter } from './rate-limit.js';
import { ROLES, rolesOf } from './roles.js';
import { AuthError, normalizeUsername, type Auth } from './service.js';

/**
 * The HTTP side of the library's identity provider (spec/1.2/registry-api.md §10): discovery, the token endpoint
 * (OAuth 2.0 shaped: password and refresh_token grants), signing out, who am I, and the administrators' endpoints
 * for users and API keys.
 */
export type AuthRouteOptions = {
  /** The issuer of this request (`iss`): the server's public base URL, without a trailing slash. */
  issuer: (c: Context) => string;
  /** Token requests per minute and username (default 10) and per address (default 60). Counted in this process. */
  rateLimit?: { perUser?: number; perAddress?: number };
  /** Take the caller's address from the last `X-Forwarded-For` entry (behind one reverse proxy). Default false. */
  trustProxy?: boolean;
};

const rolesSchema = z.array(z.enum(ROLES)).min(1);
const newUserSchema = z.object({ username: z.string().min(1).max(64), password: z.string(), roles: rolesSchema });
const patchUserSchema = z.object({ password: z.string().optional(), roles: rolesSchema.optional(), disabled: z.boolean().optional() }).strict();
const newKeySchema = z.object({ name: z.string().min(1).max(100), roles: rolesSchema });

export function mountAuthRoutes(app: Hono<{ Variables: AuthVariables }>, auth: Auth, o: AuthRouteOptions) {
  const perUser = rateLimiter(o.rateLimit?.perUser ?? 10), perAddress = rateLimiter(o.rateLimit?.perAddress ?? 60);
  const address = (c: Context) => {
    if (o.trustProxy) { const xff = c.req.header('x-forwarded-for')?.split(',').map((s) => s.trim()).filter(Boolean); if (xff?.length) return xff.at(-1)!; }
    try { return getConnInfo(c).remote.address ?? 'unknown'; } catch { return 'unknown'; }
  };
  const fail = (c: Context, status: number, code: string, message: string) => c.json({ error: { code, message } }, status as never);
  const oauthError = (c: Context, status: number, error: string, description?: string) => {
    c.header('Cache-Control', 'no-store');
    return c.json({ error, ...(description ? { error_description: description } : {}) }, status as never);
  };
  const json = async <T>(c: Context, schema: z.ZodType<T>) => {
    const r = schema.safeParse(await c.req.json().catch(() => null));
    return r.success ? { ok: true as const, data: r.data } : { ok: false as const, res: fail(c, 400, 'invalid', r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')) };
  };
  const guarded = async (c: Context, fn: () => Promise<Response>) => {
    try { return await fn(); } catch (e) { if (e instanceof AuthError) return fail(c, e.status, e.code, e.message); throw e; }
  };
  const small = bodyLimit({ maxSize: 16 * 1024, onError: (c) => fail(c, 413, 'too_large', 'at most 16 KiB') });

  // ---- discovery: public ----
  app.get('/.well-known/jwks.json', async (c) => { c.header('Cache-Control', 'public, max-age=300'); c.header('Access-Control-Allow-Origin', '*'); return c.json(await auth.jwks()); });
  app.get('/.well-known/openid-configuration', (c) => {
    const iss = o.issuer(c);
    c.header('Cache-Control', 'public, max-age=300'); c.header('Access-Control-Allow-Origin', '*');
    return c.json({
      issuer: iss, jwks_uri: `${iss}/.well-known/jwks.json`, token_endpoint: `${iss}/v1/auth/token`, revocation_endpoint: `${iss}/v1/auth/revoke`,
      userinfo_endpoint: `${iss}/v1/auth/me`, grant_types_supported: ['password', 'refresh_token'], token_endpoint_auth_methods_supported: ['none'],
      id_token_signing_alg_values_supported: ['EdDSA'], response_types_supported: [], scopes_supported: [], subject_types_supported: ['public'],
    });
  });

  // ---- signing in ----
  app.post('/v1/auth/token', small, async (c) => {
    const type = c.req.header('content-type') ?? '';
    const b = (/application\/x-www-form-urlencoded|multipart\/form-data/i.test(type) ? await c.req.parseBody().catch(() => null) : await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const str = (k: string) => (b && typeof b[k] === 'string' ? (b[k] as string) : undefined);
    const grant = str('grant_type');
    if (!grant) return oauthError(c, 400, 'invalid_request', 'grant_type is required');
    if (grant !== 'password' && grant !== 'refresh_token') return oauthError(c, 400, 'unsupported_grant_type');
    const limited = (r: { ok: boolean; retryAfter: number }) => { c.header('Retry-After', String(r.retryAfter)); return oauthError(c, 429, 'rate_limited', 'too many attempts; try again later'); };
    const byAddress = perAddress.hit(address(c));
    if (!byAddress.ok) return limited(byAddress);
    let tokens;
    if (grant === 'password') {
      const username = str('username'), password = str('password');
      if (!username || !password) return oauthError(c, 400, 'invalid_request', 'username and password are required');
      const byUser = perUser.hit(normalizeUsername(username));
      if (!byUser.ok) return limited(byUser);
      tokens = await auth.passwordGrant(username, password, o.issuer(c));
      if (!tokens) return oauthError(c, 400, 'invalid_grant', 'the username or password is wrong, or the account is disabled');
    } else {
      const refresh = str('refresh_token');
      if (!refresh) return oauthError(c, 400, 'invalid_request', 'refresh_token is required');
      tokens = await auth.refreshGrant(refresh, o.issuer(c));
      if (!tokens) return oauthError(c, 400, 'invalid_grant', 'this refresh token is not valid (expired, used or revoked)');
    }
    c.header('Cache-Control', 'no-store'); c.header('Pragma', 'no-cache');
    return c.json(tokens);
  });

  // signing out: always 200, so it says nothing about the token
  app.post('/v1/auth/revoke', small, async (c) => {
    const type = c.req.header('content-type') ?? '';
    const b = (/application\/x-www-form-urlencoded/i.test(type) ? await c.req.parseBody().catch(() => null) : await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (b && typeof b.refresh_token === 'string') await auth.revoke(b.refresh_token);
    c.header('Cache-Control', 'no-store');
    return c.json({ ok: true });
  });

  app.get('/v1/auth/me', (c) => {
    const caller = c.get('caller');
    if (!caller) { const denied = requireRole(c, 'author'); if (denied) return denied; }
    c.header('Cache-Control', 'no-store');
    return c.json({ sub: caller!.sub ?? caller!.user, name: caller!.user, roles: rolesOf(caller!), kind: caller!.kind ?? 'bootstrap' });
  });

  // ---- administrators: users and API keys ----
  const by = (c: Context<{ Variables: AuthVariables }>) => c.get('caller')!.user;
  app.post('/v1/admin/users', small, async (c) => {
    const denied = requireRole(c, 'admin'); if (denied) return denied;
    const b = await json(c, newUserSchema); if (!b.ok) return b.res;
    return guarded(c, async () => c.json(await auth.createUser(b.data), 201));
  });
  app.get('/v1/admin/users', async (c) => {
    const denied = requireRole(c, 'admin'); if (denied) return denied;
    return c.json({ items: await auth.listUsers() });
  });
  app.patch('/v1/admin/users/:id', small, async (c) => {
    const denied = requireRole(c, 'admin'); if (denied) return denied;
    const b = await json(c, patchUserSchema); if (!b.ok) return b.res;
    const p = b.data;
    return guarded(c, async () => c.json(await auth.updateUser(c.req.param('id'), {
      ...(p.password !== undefined ? { password: p.password } : {}), ...(p.roles ? { roles: p.roles } : {}), ...(p.disabled !== undefined ? { disabled: p.disabled } : {}),
    })));
  });
  app.post('/v1/admin/keys', small, async (c) => {
    const denied = requireRole(c, 'admin'); if (denied) return denied;
    const b = await json(c, newKeySchema); if (!b.ok) return b.res;
    c.header('Cache-Control', 'no-store');
    return guarded(c, async () => c.json(await auth.createApiKey({ ...b.data, createdBy: by(c) }), 201));
  });
  app.get('/v1/admin/keys', async (c) => {
    const denied = requireRole(c, 'admin'); if (denied) return denied;
    return c.json({ items: await auth.listApiKeys() });
  });
  app.delete('/v1/admin/keys/:id', async (c) => {
    const denied = requireRole(c, 'admin'); if (denied) return denied;
    return (await auth.revokeApiKey(c.req.param('id'))) ? c.json({ id: c.req.param('id'), revoked: true }) : fail(c, 404, 'not_found', 'no such key, or it is already revoked');
  });
}
