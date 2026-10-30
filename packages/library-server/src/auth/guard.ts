import type { Context } from 'hono';

/**
 * STAND-IN, replaced by the roles work (library authentication, task A1): the same signature, implemented on
 * today's checks so the routes that use it (delivery.ts) work before roles exist.
 *
 *   reader  any caller with a token (today's `reader` rule when PUBLIC_READ=false; a public library does not
 *           call this for reading)
 *   author  any caller with a token (today's `writer` rule)
 *   admin   a caller whose name ends in `!` in TOKENS
 *
 * A Response to send (401 without a valid token, 403 with one that may not do this), or null to go on.
 */
export type Role = 'reader' | 'author' | 'admin';

export function requireRole(c: Context, role: Role): Response | null {
  const caller = c.get('caller') as { user: string; admin?: boolean } | null | undefined;
  if (!caller) return c.json({ error: { code: 'unauthorized', message: 'a token is needed' } }, 401);
  if (role === 'admin' && !caller.admin) return c.json({ error: { code: 'forbidden', message: 'only an administrator can do this' } }, 403);
  return null;
}
