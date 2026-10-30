import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import { CLOCK_SKEW_S, jwkOf, keyFromPem, kidOf, newKeyPair, signAccessToken, verifyAccessToken, type Jwk, type SigningKey } from './jwt.js';
import { hashPassword, MAX_PASSWORD, passwordProblem, verifyPassword } from './password.js';
import { expandRoles, type Caller, type Role } from './roles.js';
import { isSealed, keySealer, openSuccessor, sealSuccessor } from './sealed.js';

/**
 * The library as its own identity provider (spec/1.2/registry-api.md §10): users with passwords, access tokens
 * signed with the library's Ed25519 keys, rotating refresh tokens, and API keys for machines. Everything secret is
 * kept only as a hash (passwords: scrypt; refresh tokens and API keys: SHA-256). The private signing keys are in the
 * database (table auth_keys), sealed with AES-256-GCM under a key derived from `keySecret` (AUTH_KEY_SECRET), so a
 * copy of the database alone cannot sign tokens. Without `keySecret` the library has no user accounts: creating
 * one, or a signing key rotation, is refused (see `checkKeySetup`).
 */
export type AuthOptions = {
  db: Db;
  /** Access token lifetime in seconds (default 900). */
  accessTtl?: number;
  /** Refresh token lifetime in seconds (default 30 days). */
  refreshTtl?: number;
  /** How long a user's state (disabled or not) is trusted before it is read again, in ms (default 10 s). */
  userCacheMs?: number;
  /**
   * Seconds after a refresh token was used during which sending it again gives the same successor instead of
   * ending the sign-in (default 30; 0: never; the spec allows at most 60). Covers an answer lost on its way to the client.
   */
  refreshGrace?: number;
  /** AUTH_KEY_SECRET: seals the private signing keys (at least 32 characters). */
  keySecret?: string;
  now?: () => number;
};

export type TokenResponse = { access_token: string; token_type: 'Bearer'; expires_in: number; refresh_token: string; roles: Role[] };
export type UserRecord = { id: string; username: string; roles: Role[]; disabled: boolean; createdAt: string; updatedAt: string; lastSignInAt: string | null };
export type ApiKeyRecord = { id: string; name: string; hint: string; roles: Role[]; createdBy: string | null; createdAt: string; lastUsedAt: string | null; revokedAt: string | null };

/** A request the service refuses: a status and a code for the API's error shape. */
export class AuthError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 503, readonly code: string, message: string) { super(message); }
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
  const userCacheMs = o.userCacheMs ?? 10_000, refreshGrace = o.refreshGrace ?? 30;
  const now = o.now ?? Date.now;
  const sealer = o.keySecret ? keySealer(o.keySecret) : null;
  const needSecret = (what: string) => {
    if (!sealer) throw new AuthError(503, 'not_configured', `${what} needs AUTH_KEY_SECRET (the key that encrypts the token signing keys); set it and restart`);
  };
  /** A new key pair, its private half sealed when there is a secret. */
  const insertKey = async () => {
    const k = newKeyPair();
    await db.query('INSERT INTO auth_keys (kid, public_key, private_key) VALUES ($1, $2, $3)', [k.kid, k.publicPem, sealer ? sealer.seal(k.kid, k.privatePem) : k.privatePem]);
    return k.kid;
  };
  /** A stored private key in PEM: unsealed, or (stored before there was a secret) sealed in place now. */
  const privatePem = async (kid: string, stored: string): Promise<string> => {
    if (!isSealed(stored)) {
      if (sealer) await db.query('UPDATE auth_keys SET private_key = $2 WHERE kid = $1 AND private_key = $3', [kid, sealer.seal(kid, stored), stored]);
      return stored;
    }
    if (!sealer) throw new Error(`the token signing key ${kid} is encrypted: AUTH_KEY_SECRET is needed to use it`);
    const pem = sealer.open(kid, stored);
    if (pem == null) throw new Error(`AUTH_KEY_SECRET does not decrypt the token signing key ${kid} (was the secret changed? chalk-library signing-key rotate, with the new secret, replaces the key)`);
    return pem;
  };

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
      await insertKey();
      rows = await read();
    }
    const keys = new Map<string, SigningKey>();
    for (const r of rows) keys.set(r.kid, keyFromPem(r.kid, r.public_key, !r.retired_at && r.private_key ? await privatePem(r.kid, r.private_key) : undefined));
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
  /** An access token for `user`, with `refresh` as the refresh token (already stored). */
  const respond = async (user: UserRow, issuer: string, refresh: string): Promise<TokenResponse> => {
    const { signer } = await keys();
    const roles = expandRoles(user.roles);
    return {
      access_token: signAccessToken(signer, { iss: issuer, sub: user.id, name: user.username, roles }, accessTtl, now()),
      token_type: 'Bearer', expires_in: accessTtl, refresh_token: refresh, roles,
    };
  };
  const issue = async (user: UserRow, issuer: string, family: string): Promise<TokenResponse> => {
    const refresh = randomBytes(32).toString('base64url');
    await db.query(`INSERT INTO auth_refresh_tokens (id, token_hash, family_id, user_id, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))`,
      [randomUUID(), sha256(refresh), family, user.id, refreshTtl]);
    return respond(user, issuer, refresh);
  };
  /**
   * After issuing: if the user was disabled or got a new password meanwhile, or a reuse revoked the sign-in while
   * this request ran, the sign-in is revoked (again: that also covers a token inserted after the revocation).
   */
  const stillValid = async (user: UserRow, family: string, tokens: TokenResponse) => {
    const cur = (await db.query<{ password_hash: string; disabled: boolean }>('SELECT password_hash, disabled FROM auth_users WHERE id = $1', [user.id]))[0];
    const revoked = await db.query('SELECT 1 FROM auth_refresh_tokens WHERE family_id = $1 AND revoked_at IS NOT NULL LIMIT 1', [family]);
    if (cur && !cur.disabled && cur.password_hash === user.password_hash && !revoked.length) return tokens;
    await revokeFamily(family);
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
      needSecret('a new signing key');
      // the old keys are not read: this also replaces keys sealed under a secret that was lost or changed
      const kid = await insertKey();
      await db.query('UPDATE auth_keys SET retired_at = now(), private_key = NULL WHERE retired_at IS NULL AND kid <> $1', [kid]);
      await keys(true);
      return kid;
    },

    /** Loads (and, the first time a secret is set, seals) the signing keys; throws when they cannot be used. */
    async loadSigningKeys(): Promise<void> { await keys(true); },

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
      const family = randomUUID();
      return stillValid(u, family, await issue(u, issuer, family));
    },

    /**
     * grant_type=refresh_token: the token is used up and a successor issued. Sent again within `refreshGrace`
     * seconds (an answer lost on its way, two requests racing), it gives the same successor, as long as that has
     * not been used itself; any other reuse revokes every token descended from the same sign-in.
     */
    async refreshGrant(token: string, issuer: string): Promise<TokenResponse | null> {
      if (typeof token !== 'string' || !token) return null;
      type Row = { id: string; family_id: string; user_id: string; rotated_at: unknown; successor: string | null; in_grace: boolean; revoked: boolean; live: boolean };
      // a family is revoked once any of its tokens is: that also covers a successor inserted after the revocation
      const read = async () => (await db.query<Row>(
        `SELECT id, family_id, user_id, rotated_at, successor, expires_at > now() AS live,
          coalesce(rotated_at > now() - make_interval(secs => $2), false) AS in_grace,
          EXISTS (SELECT 1 FROM auth_refresh_tokens f WHERE f.family_id = t.family_id AND f.revoked_at IS NOT NULL) AS revoked
        FROM auth_refresh_tokens t WHERE token_hash = $1`, [sha256(token), refreshGrace]))[0];
      /** The token was used already: the same successor again, within the grace window, or the end of the sign-in. */
      const again = async (r: Row): Promise<TokenResponse | null> => {
        const next = r.in_grace && r.successor ? openSuccessor(token, r.id, r.successor) : null;
        // the successor is stored in the same statement that marked this token used, so it exists here; used in
        // turn, its answer arrived: whoever sends the old token now is not that client. Expired: nothing to give
        const usable = next ? (await db.query('SELECT 1 FROM auth_refresh_tokens WHERE token_hash = $1 AND rotated_at IS NULL AND expires_at > now()', [sha256(next)])).length > 0 : false;
        const u = usable ? await userById(r.user_id) : null;
        if (!next || !usable || !u || u.disabled) { await revokeFamily(r.family_id); return null; }
        return stillValid(u, r.family_id, await respond(u, issuer, next));
      };
      const r = await read();
      if (!r || r.revoked) return null;
      if (r.rotated_at) return again(r);
      if (!r.live) return null;
      // used up exactly once, even when two requests race with the same token. One statement marks it used, keeps
      // the successor sealed with it, and stores the successor's row: whoever sees it used (a retry, the request
      // that lost the race) finds the successor already stored, so signing out with it or revoking works at once
      const next = randomBytes(32).toString('base64url');
      const won = await db.query(`WITH used AS (
          UPDATE auth_refresh_tokens SET rotated_at = now(), successor = $2 WHERE id = $1 AND rotated_at IS NULL AND revoked_at IS NULL RETURNING family_id, user_id)
        INSERT INTO auth_refresh_tokens (id, token_hash, family_id, user_id, expires_at)
          SELECT $3, $4, family_id, user_id, now() + make_interval(secs => $5) FROM used RETURNING id`,
        [r.id, sealSuccessor(token, r.id, next), randomUUID(), sha256(next), refreshTtl]);
      if (!won.length) {
        const lost = await read();
        if (lost && !lost.revoked && lost.rotated_at) return again(lost);
        await revokeFamily(r.family_id);
        return null;
      }
      const u = await userById(r.user_id);
      if (!u || u.disabled) { await revokeFamily(r.family_id); return null; }
      return stillValid(u, r.family_id, await respond(u, issuer, next));
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
      needSecret('a user account');
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

/**
 * At start: the signing keys must be safe to use. With AUTH_KEY_SECRET they are loaded (keys stored before the
 * secret was set are sealed now; a secret that does not open them stops the start). Without it the library may
 * start only as it did before it had accounts: no users, PUBLIC_READ not false, no sealed keys. Throws a message
 * for the operator otherwise.
 */
export async function checkKeySetup(db: Db, o: { keySecret?: string; publicRead: boolean }): Promise<void> {
  if (o.keySecret) { await createAuth({ db, keySecret: o.keySecret }).loadSigningKeys(); return; }
  const sealed = await db.query("SELECT 1 FROM auth_keys WHERE retired_at IS NULL AND private_key LIKE 'enc:v1:%' LIMIT 1");
  if (sealed.length) throw new Error('AUTH_KEY_SECRET is not set, but the token signing keys are encrypted with it');
  const users = await db.query('SELECT 1 FROM auth_users LIMIT 1');
  if (users.length) throw new Error('AUTH_KEY_SECRET is not set: this library has user accounts, so its token signing keys must be encrypted (openssl rand -base64 32)');
  if (!o.publicRead) throw new Error('AUTH_KEY_SECRET is not set: a private library (PUBLIC_READ=false) needs it (openssl rand -base64 32)');
}
