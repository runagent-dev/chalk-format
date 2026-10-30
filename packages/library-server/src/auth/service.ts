import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import { CLOCK_SKEW_S, jwkOf, keyFromPem, kidOf, newKeyPair, signAccessToken, verifyAccessToken, type Jwk, type SigningKey } from './jwt.js';
import { hashPassword, MAX_PASSWORD, passwordProblem, verifyPassword } from './password.js';
import { expandRoles, type Caller, type Role } from './roles.js';

/**
 * The library as its own identity provider (spec/1.2/registry-api.md §10): users with passwords, access tokens
 * signed with the library's Ed25519 keys, rotating refresh tokens, and API keys for machines. Everything secret is
 * kept only as a hash (passwords: scrypt; refresh tokens and API keys: SHA-256); the signing keys are in the
 * database (table auth_keys), so whoever can read the database can sign tokens.
 */
export type AuthOptions = {
  db: Db;
  /** Access token lifetime in seconds (default 900). */
  accessTtl?: number;
  /** Refresh token lifetime in seconds (default 30 days). */
  refreshTtl?: number;
  /** How long a user's state (disabled or not) is trusted before it is read again, in ms (default 10 s). */
  userCacheMs?: number;
  now?: () => number;
};

export type TokenResponse = { access_token: string; token_type: 'Bearer'; expires_in: number; refresh_token: string; roles: Role[] };
export type UserRecord = { id: string; username: string; roles: Role[]; disabled: boolean; createdAt: string; updatedAt: string; lastSignInAt: string | null };
export type ApiKeyRecord = { id: string; name: string; hint: string; roles: Role[]; createdBy: string | null; createdAt: string; lastUsedAt: string | null; revokedAt: string | null };

/** A request the service refuses: a status and a code for the API's error shape. */
export class AuthError extends Error {
  constructor(readonly status: 400 | 404 | 409, readonly code: string, message: string) { super(message); }
}

type UserRow = { id: string; username: string; password_hash: string; roles: string[]; disabled: boolean; created_at: Date | string; updated_at: Date | string; last_sign_in_at: Date | string | null };
type KeyRow = { id: string; name: string; hint: string; roles: string[]; created_by: string | null; created_at: Date | string; last_used_at: Date | string | null; revoked_at: Date | string | null };

/** How often an instance re-reads the signing keys (another instance or the CLI may have rotated them). */
const RELOAD_MS = 5 * 60_000;
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._@-]{0,63}$/;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const iso = (d: Date | string | null) => (d == null ? null : new Date(d).toISOString());
const userRecord = (r: UserRow): UserRecord => ({
  id: r.id, username: r.username, roles: expandRoles(r.roles), disabled: r.disabled,
  createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!, lastSignInAt: iso(r.last_sign_in_at),
});
const keyRecord = (r: KeyRow): ApiKeyRecord => ({
  id: r.id, name: r.name, hint: r.hint, roles: expandRoles(r.roles), createdBy: r.created_by,
  createdAt: iso(r.created_at)!, lastUsedAt: iso(r.last_used_at), revokedAt: iso(r.revoked_at),
});
export const normalizeUsername = (u: string) => u.trim().normalize('NFC').toLowerCase();

export type Auth = ReturnType<typeof createAuth>;

export function createAuth(o: AuthOptions) {
  const { db } = o;
  const accessTtl = o.accessTtl ?? 900, refreshTtl = o.refreshTtl ?? 30 * 24 * 3600;
  const userCacheMs = o.userCacheMs ?? 10_000;
  const now = o.now ?? Date.now;

  // ---- signing keys: made on first use, re-read now and then (another instance may have rotated) ----
  type Loaded = { keys: Map<string, SigningKey>; signer: SigningKey; at: number };
  let loaded: Promise<Loaded> | null = null, lastMissReload = 0;
  const load = async (): Promise<Loaded> => {
    // a retired key stays until every token it signed has expired, including tokens an instance that has not
    // re-read its keys yet signed with it (RELOAD_MS)
    const read = () => db.query<{ kid: string; public_key: string; private_key: string | null; retired_at: Date | string | null }>(
      `SELECT kid, public_key, private_key, retired_at FROM auth_keys WHERE retired_at IS NULL OR retired_at > now() - make_interval(secs => $1) ORDER BY created_at DESC, kid`,
      [accessTtl + CLOCK_SKEW_S + RELOAD_MS / 1000]);
    let rows = await read();
    if (!rows.some((r) => !r.retired_at && r.private_key)) {
      const k = newKeyPair();
      await db.query('INSERT INTO auth_keys (kid, public_key, private_key) VALUES ($1, $2, $3)', [k.kid, k.publicPem, k.privatePem]);
      rows = await read();
    }
    const keys = new Map(rows.map((r) => [r.kid, keyFromPem(r.kid, r.public_key, r.retired_at ? undefined : r.private_key ?? undefined)]));
    // two instances starting at once may both make a key: every instance signs with the newest
    const signer = keys.get(rows.find((r) => !r.retired_at && r.private_key)!.kid)!;
    return { keys, signer, at: now() };
  };
  const keys = async (fresh = false) => {
    const cur = loaded && (await loaded.catch(() => null));
    if (!cur || fresh || now() - cur.at > RELOAD_MS) {
      const p = load();
      loaded = p;
      p.catch(() => { if (loaded === p) loaded = null; });
    }
    return loaded!;
  };

  // ---- users' state, cached briefly: an access token is checked on every request ----
  const userOk = new Map<string, { ok: boolean; at: number }>();
  const userActive = async (id: string) => {
    const c = userOk.get(id);
    if (c && now() - c.at < userCacheMs) return c.ok;
    const ok = (await db.query<{ disabled: boolean }>('SELECT disabled FROM auth_users WHERE id = $1', [id]))[0]?.disabled === false;
    if (userOk.size > 10_000) userOk.clear();
    userOk.set(id, { ok, at: now() });
    return ok;
  };

  // ---- tokens ----
  const issue = async (user: UserRow, issuer: string, family?: string): Promise<TokenResponse> => {
    const { signer } = await keys();
    const roles = expandRoles(user.roles);
    const refresh = randomBytes(32).toString('base64url');
    await db.query(`INSERT INTO auth_refresh_tokens (id, token_hash, family_id, user_id, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))`,
      [randomUUID(), sha256(refresh), family ?? randomUUID(), user.id, refreshTtl]);
    return {
      access_token: signAccessToken(signer, { iss: issuer, sub: user.id, name: user.username, roles }, accessTtl, now()),
      token_type: 'Bearer', expires_in: accessTtl, refresh_token: refresh, roles,
    };
  };
  /** After issuing: if the user was disabled or got a new password meanwhile, the new sign-in is revoked at once. */
  const stillValid = async (user: UserRow, tokens: TokenResponse) => {
    const now = (await db.query<{ password_hash: string; disabled: boolean }>('SELECT password_hash, disabled FROM auth_users WHERE id = $1', [user.id]))[0];
    if (now && !now.disabled && now.password_hash === user.password_hash) return tokens;
    await db.query(`UPDATE auth_refresh_tokens SET revoked_at = now() WHERE family_id = (SELECT family_id FROM auth_refresh_tokens WHERE token_hash = $1) AND revoked_at IS NULL`, [sha256(tokens.refresh_token)]);
    return null;
  };
  const revokeFamily = (family: string) => db.query('UPDATE auth_refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL', [family]);
  const revokeUser = (id: string) => db.query('UPDATE auth_refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
  let lastSweep = 0;
  const sweep = async () => {
    if (now() - lastSweep < 3600_000) return;
    lastSweep = now();
    // whole sign-ins only, once their newest token has expired: an old used token of a live sign-in must stay, so
    // that sending it again is still recognised as reuse
    await db.query(`DELETE FROM auth_refresh_tokens WHERE family_id IN
      (SELECT family_id FROM auth_refresh_tokens GROUP BY family_id HAVING max(expires_at) < now() - interval '7 days')`);
  };
  const userByName = async (username: string) => (await db.query<UserRow>('SELECT * FROM auth_users WHERE username = $1', [normalizeUsername(username)]))[0] ?? null;
  const userById = async (id: string) => (await db.query<UserRow>('SELECT * FROM auth_users WHERE id = $1', [id]))[0] ?? null;

  return {
    accessTtl,

    /** The public keys readers of tokens need (JWKS, RFC 7517). */
    async jwks(): Promise<{ keys: Jwk[] }> {
      // read again when older than a few seconds: a key another instance just made must be published at once
      const cur = loaded && (await loaded.catch(() => null));
      return { keys: [...(await keys(!cur || now() - cur.at > 5_000)).keys.values()].map(jwkOf) };
    },

    /** A new signing key; the old one stops signing now and leaves JWKS once its tokens have expired. */
    async rotateSigningKey(): Promise<string> {
      const k = newKeyPair();
      await db.query('INSERT INTO auth_keys (kid, public_key, private_key) VALUES ($1, $2, $3)', [k.kid, k.publicPem, k.privatePem]);
      await db.query('UPDATE auth_keys SET retired_at = now(), private_key = NULL WHERE retired_at IS NULL AND kid <> $1', [k.kid]);
      await keys(true);
      return k.kid;
    },

    /** grant_type=password. null: the name or the password is wrong, or the user is disabled (one answer for all three). */
    async passwordGrant(username: string, password: string, issuer: string): Promise<TokenResponse | null> {
      void sweep().catch(() => {});
      if (typeof password !== 'string' || password.length > MAX_PASSWORD) return null;
      const u = typeof username === 'string' && USERNAME_PATTERN.test(normalizeUsername(username)) ? await userByName(username) : null;
      // the password is checked even for unknown users, so the time taken does not say which names exist
      const ok = await verifyPassword(password, u?.password_hash ?? null);
      if (!u || !ok || u.disabled) return null;
      await db.query('UPDATE auth_users SET last_sign_in_at = now() WHERE id = $1', [u.id]);
      // a password reset or disabling that ran while this was checking the old password wins
      return stillValid(u, await issue(u, issuer));
    },

    /** grant_type=refresh_token: the token is used up; using it again revokes every token descended from the same sign-in. */
    async refreshGrant(token: string, issuer: string): Promise<TokenResponse | null> {
      if (typeof token !== 'string' || !token) return null;
      // a family is revoked once any of its tokens is: that also covers a successor inserted after the revocation
      const r = (await db.query<{ id: string; family_id: string; user_id: string; rotated_at: unknown; revoked: boolean; live: boolean }>(
        `SELECT id, family_id, user_id, rotated_at, expires_at > now() AS live,
          EXISTS (SELECT 1 FROM auth_refresh_tokens f WHERE f.family_id = t.family_id AND f.revoked_at IS NOT NULL) AS revoked
        FROM auth_refresh_tokens t WHERE token_hash = $1`, [sha256(token)]))[0];
      if (!r || r.revoked) return null;
      if (r.rotated_at) { await revokeFamily(r.family_id); return null; }
      if (!r.live) return null;
      // used up exactly once, even when two requests race with the same token
      const won = await db.query('UPDATE auth_refresh_tokens SET rotated_at = now() WHERE id = $1 AND rotated_at IS NULL AND revoked_at IS NULL RETURNING id', [r.id]);
      if (!won.length) { await revokeFamily(r.family_id); return null; }
      const u = await userById(r.user_id);
      if (!u || u.disabled) { await revokeFamily(r.family_id); return null; }
      const tokens = await issue(u, issuer, r.family_id);
      // a reuse that revoked the family while this request ran: the new token is revoked with it
      const revoked = await db.query('SELECT 1 FROM auth_refresh_tokens WHERE family_id = $1 AND revoked_at IS NOT NULL LIMIT 1', [r.family_id]);
      if (revoked.length) { await revokeFamily(r.family_id); return null; }
      return stillValid(u, tokens);
    },

    /** Signing out: the refresh token and every token of its family stop working. Unknown tokens are ignored. */
    async revoke(token: string): Promise<void> {
      if (typeof token !== 'string' || !token) return;
      const r = (await db.query<{ family_id: string }>('SELECT family_id FROM auth_refresh_tokens WHERE token_hash = $1', [sha256(token)]))[0];
      if (r) await revokeFamily(r.family_id);
    },

    /** The caller a bearer token names (an access token or an API key), or null. */
    async resolve(token: string, issuer: string): Promise<Caller | null> {
      if (token.startsWith('clk_')) {
        const k = (await db.query<{ id: string; name: string; roles: string[] }>('SELECT id, name, roles FROM auth_api_keys WHERE key_hash = $1 AND revoked_at IS NULL', [sha256(token)]))[0];
        if (!k) return null;
        // when it was last used, to the minute: not a write on every request
        void db.query("UPDATE auth_api_keys SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')", [k.id]).catch(() => {});
        const roles = expandRoles(k.roles);
        return { user: k.name, sub: k.id, roles, admin: roles.includes('admin'), kind: 'api-key' };
      }
      const kid = kidOf(token);
      if (!kid) return null;
      let ks = await keys();
      if (!ks.keys.has(kid) && now() - lastMissReload > 10_000) { lastMissReload = now(); ks = await keys(true); }
      const key = ks.keys.get(kid);
      const c = key ? verifyAccessToken(token, key, issuer, now()) : null;
      if (!c || !(await userActive(c.sub))) return null;
      const roles = expandRoles(c.roles);
      return { user: c.name, sub: c.sub, roles, admin: roles.includes('admin'), kind: 'user' };
    },

    // ---- users (administrators, the CLI) ----
    async createUser(i: { username: string; password: string; roles: Role[] }): Promise<UserRecord> {
      const username = normalizeUsername(i.username);
      if (!USERNAME_PATTERN.test(username)) throw new AuthError(400, 'invalid', 'a username is 1 to 64 letters, digits, ".", "_", "@" or "-"');
      const bad = passwordProblem(i.password); if (bad) throw new AuthError(400, 'invalid', bad);
      const roles = expandRoles(i.roles); if (!roles.length) throw new AuthError(400, 'invalid', 'a user needs a role');
      const rows = await db.query<UserRow>('INSERT INTO auth_users (id, username, password_hash, roles) VALUES ($1, $2, $3, $4) ON CONFLICT (username) DO NOTHING RETURNING *',
        [randomUUID(), username, await hashPassword(i.password), roles]);
      if (!rows[0]) throw new AuthError(409, 'conflict', `${username} already exists`);
      return userRecord(rows[0]);
    },
    async listUsers(): Promise<UserRecord[]> { return (await db.query<UserRow>('SELECT * FROM auth_users ORDER BY username')).map(userRecord); },
    async findUser(idOrName: string): Promise<UserRecord | null> {
      const u = (await db.query<UserRow>('SELECT * FROM auth_users WHERE id::text = $1 OR username = $2', [idOrName, normalizeUsername(idOrName)]))[0];
      return u ? userRecord(u) : null;
    },
    /** A new password or disabling a user ends every sign-in of that user (refresh tokens revoked). */
    async updateUser(id: string, p: { password?: string; roles?: Role[]; disabled?: boolean }): Promise<UserRecord> {
      if (p.password !== undefined) { const bad = passwordProblem(p.password); if (bad) throw new AuthError(400, 'invalid', bad); }
      if (p.roles !== undefined && !expandRoles(p.roles).length) throw new AuthError(400, 'invalid', 'a user needs a role');
      const rows = await db.query<UserRow>(`UPDATE auth_users SET password_hash = COALESCE($2, password_hash), roles = COALESCE($3, roles), disabled = COALESCE($4, disabled),
        updated_at = now() WHERE id = $1 RETURNING *`, [id, p.password !== undefined ? await hashPassword(p.password) : null, p.roles ? expandRoles(p.roles) : null, p.disabled ?? null]);
      if (!rows[0]) throw new AuthError(404, 'not_found', 'no such user');
      if (p.password !== undefined || p.disabled) await revokeUser(id);
      userOk.delete(id);
      return userRecord(rows[0]);
    },

    // ---- API keys ----
    async createApiKey(i: { name: string; roles: Role[]; createdBy?: string }): Promise<ApiKeyRecord & { key: string }> {
      const name = i.name.trim();
      if (!name || name.length > 100) throw new AuthError(400, 'invalid', 'a key needs a name (at most 100 characters)');
      const roles = expandRoles(i.roles); if (!roles.length) throw new AuthError(400, 'invalid', 'a key needs a role');
      const key = `clk_${randomBytes(32).toString('base64url')}`;
      const rows = await db.query<KeyRow>('INSERT INTO auth_api_keys (id, name, key_hash, hint, roles, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
        [randomUUID(), name, sha256(key), `${key.slice(0, 8)}…`, roles, i.createdBy ?? null]);
      return { ...keyRecord(rows[0]!), key };
    },
    async listApiKeys(): Promise<ApiKeyRecord[]> { return (await db.query<KeyRow>('SELECT * FROM auth_api_keys ORDER BY created_at')).map(keyRecord); },
    /** false: no such key, or it was already revoked. */
    async revokeApiKey(id: string): Promise<boolean> {
      return (await db.query('UPDATE auth_api_keys SET revoked_at = now() WHERE id::text = $1 AND revoked_at IS NULL RETURNING id', [id])).length > 0;
    },
  };
}
