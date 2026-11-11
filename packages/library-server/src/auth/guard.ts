import type { Context, MiddlewareHandler } from 'hono';
import { hasRole, type Actor, type Caller, type Role } from './roles.js';

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

/** `Chalk-Actor`'s id: a person (`staff:<id>`) or a job (`system:<job>`) of the deployment (registry-api §10.7). */
export const ACTOR_ID = /^(staff|system):[A-Za-z0-9._:-]{1,80}$/;

/** `Chalk-Actor: base64url(JSON {"id", "name"})` → the actor, or null when it is not one. */
export function parseActor(header: string): Actor | null {
  const h = header.trim();
  if (!h || h.length > 2048 || !/^[A-Za-z0-9_-]+={0,2}$/.test(h)) return null;
  let v: unknown;
  try { v = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')); } catch { return null; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const { id, name } = v as { id?: unknown; name?: unknown };
  if (typeof id !== 'string' || !ACTOR_ID.test(id) || typeof name !== 'string') return null;
  const n = [...name].length;
  // a display name: 1 to 120 characters, no control characters
  if (n < 1 || n > 120 || !name.trim() || [...name].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) return null;
  return { id, name };
}

/**
 * Reads `Authorization: Bearer …` once per request and puts the caller (or null) on it.
 *
 * `Chalk-Actor` (registry-api §10.7): from a key that may act for people, the caller becomes that person for every
 * record (`user` = the actor's id) and `onActor` notes them; from any other caller it is refused (403
 * `act_for_not_allowed`), so a client set up wrong is noticed instead of writing under the wrong name. A bearer token
 * that is not valid is left to the route (401), header or not.
 */
export function authenticate(o: { publicRead: boolean; resolve: (token: string, c: Context) => Promise<Caller | null>; onActor?: (a: Actor) => Promise<void> }): MiddlewareHandler {
  return async (c, next) => {
    const h = c.req.header('authorization');
    const token = h && /^Bearer /i.test(h) ? h.slice(7).trim() : '';
    c.set('publicRead', o.publicRead);
    c.set('bearer', Boolean(token));
    let caller = token ? await o.resolve(token, c) : null;
    const actorHeader = c.req.header('chalk-actor');
    if (actorHeader !== undefined && (caller || !token)) {
      const fail = (status: number, code: string, message: string) => c.json({ error: { code, message } }, status as never);
      if (!caller?.actFor) return fail(403, 'act_for_not_allowed', 'Chalk-Actor is accepted only from an API key that may act for people');
      const actor = parseActor(actorHeader);
      if (!actor) return fail(400, 'invalid', 'Chalk-Actor must be base64url JSON {"id": "staff:<id>" | "system:<job>", "name": "<1 to 120 characters>"}');
      try { await o.onActor?.(actor); } catch (e) { console.error('Chalk-Actor: the actor could not be recorded:', e); }
      caller = { ...caller, user: actor.id, actingFor: actor, via: caller.user };
    }
    c.set('caller', caller);
    await next();
  };
}
