import type { Context, MiddlewareHandler } from 'hono';
import { hasRole, type Caller, type Role } from './roles.js';

/**
 * One check for every route: `const denied = requireRole(c, 'author'); if (denied) return denied;`.
 *
 * - no valid token: 401 `unauthorized` (a `reader` route of a library with PUBLIC_READ=true lets it through, as
 *   before roles existed);
 * - a valid token without the role: 403 `forbidden`.
 *
 * It reads what `authenticate` put on the request, so it works on every route under `/v1/`.
 */
export type { Role } from './roles.js';
export type AuthVariables = { caller: Caller | null; publicRead: boolean; bearer: boolean };

export function requireRole(c: Context, role: Role): Response | null {
  const caller = c.get('caller') as Caller | null | undefined;
  if (role === 'reader' && !caller && c.get('publicRead') === true) return null; // fails closed off `authenticate`'s routes
  if (!caller) {
    c.header('WWW-Authenticate', c.get('bearer') ? 'Bearer realm="chalk-library", error="invalid_token"' : 'Bearer realm="chalk-library"');
    return c.json({ error: { code: 'unauthorized', message: c.get('bearer') ? 'this token is not valid (expired, revoked or not from this library)' : 'a token is needed' } }, 401);
  }
  if (!hasRole(caller, role)) return c.json({ error: { code: 'forbidden', message: `this needs the ${role} role` } }, 403);
  return null;
}

/** Reads `Authorization: Bearer …` once per request and puts the caller (or null) on it. */
export function authenticate(o: { publicRead: boolean; resolve: (token: string, c: Context) => Promise<Caller | null> }): MiddlewareHandler {
  return async (c, next) => {
    const h = c.req.header('authorization');
    const token = h && /^Bearer /i.test(h) ? h.slice(7).trim() : '';
    c.set('publicRead', o.publicRead);
    c.set('bearer', Boolean(token));
    c.set('caller', token ? await o.resolve(token, c) : null);
    await next();
  };
}
