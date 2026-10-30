import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { libraryFromEnv, openDb, type Db } from '../index.js';
import { AuthError, checkKeySetup, createAuth } from './service.js';

// the token signing keys are encrypted at rest with AUTH_KEY_SECRET (AES-256-GCM)
const SECRET = 'first-secret-that-is-long-enough-0123456789';
const OTHER = 'second-secret-that-is-long-enough-987654321';
const open: Db[] = [];
const fresh = async () => { const db = await openDb('pglite:'); open.push(db); return db; };
const stored = async (db: Db) => db.query<{ kid: string; private_key: string | null; retired_at: unknown }>('SELECT kid, private_key, retired_at FROM auth_keys ORDER BY created_at');
afterEach(async () => { await Promise.all(open.splice(0).map((d) => d.close())); });

describe('AUTH_KEY_SECRET', { timeout: 30_000 }, () => {
  it('a library without accounts starts without it, as before; its key is sealed when the secret is first set', async () => {
    const db = await fresh();
    const plain = await createAuth({ db }).jwks();
    const before = await stored(db);
    expect(before[0]!.private_key).toContain('BEGIN PRIVATE KEY');
    await expect(checkKeySetup(db, { publicRead: true })).resolves.toBeUndefined();
    // set the secret: the same key, now sealed; the public key (JWKS) unchanged, tokens still verify
    await checkKeySetup(db, { publicRead: true, keySecret: SECRET });
    const after = await stored(db);
    expect(after.map((r) => r.kid)).toEqual(before.map((r) => r.kid));
    expect(after[0]!.private_key).toMatch(/^enc:v1:/);
    expect(after[0]!.private_key).not.toContain('PRIVATE KEY');
    expect(await createAuth({ db, keySecret: SECRET }).jwks()).toEqual(plain);
    // new keys are sealed from the start
    await createAuth({ db, keySecret: SECRET }).rotateSigningKey();
    const rotated = await stored(db);
    expect(rotated.filter((r) => !r.retired_at).every((r) => r.private_key!.startsWith('enc:v1:'))).toBe(true);
    expect(rotated.filter((r) => r.retired_at).every((r) => r.private_key === null)).toBe(true);
  });

  it('signs and verifies with a sealed key', async () => {
    const db = await fresh();
    const auth = createAuth({ db, keySecret: SECRET });
    await auth.createUser({ username: 'kim', password: 'kims-password-1', roles: ['reader'] });
    const t = (await auth.passwordGrant('kim', 'kims-password-1', 'http://x.test'))!;
    // another instance with the same secret reads the key and accepts the token
    expect(await createAuth({ db, keySecret: SECRET }).resolve(t.access_token, 'http://x.test')).toMatchObject({ user: 'kim', kind: 'user' });
  });

  it('is needed to add users, to rotate the key, and once there are users or PUBLIC_READ=false', async () => {
    const db = await fresh();
    const without = createAuth({ db });
    const err = await without.createUser({ username: 'kim', password: 'kims-password-1', roles: ['reader'] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect(err).toMatchObject({ status: 503, code: 'not_configured' });
    await expect(without.rotateSigningKey()).rejects.toMatchObject({ code: 'not_configured' });
    await expect(checkKeySetup(db, { publicRead: false })).rejects.toThrow(/PUBLIC_READ=false\) needs it/);
    await createAuth({ db, keySecret: SECRET }).createUser({ username: 'kim', password: 'kims-password-1', roles: ['reader'] });
    await expect(checkKeySetup(db, { publicRead: true })).rejects.toThrow(/encrypted with it|user accounts/);
  });

  it('refuses to start with no secret or the wrong one for sealed keys; rotating with a new secret recovers', async () => {
    const db = await fresh();
    await checkKeySetup(db, { publicRead: true, keySecret: SECRET });
    await expect(checkKeySetup(db, { publicRead: true })).rejects.toThrow(/encrypted with it/);
    await expect(checkKeySetup(db, { publicRead: true, keySecret: OTHER })).rejects.toThrow(/does not decrypt/);
    // a sealed value moved to another kid does not open either (bound to its row)
    const [a] = await stored(db);
    await db.query("INSERT INTO auth_keys (kid, public_key, private_key) SELECT 'moved', public_key, private_key FROM auth_keys WHERE kid = $1", [a!.kid]);
    await db.query('UPDATE auth_keys SET retired_at = now() WHERE kid = $1', [a!.kid]);
    await expect(checkKeySetup(db, { publicRead: true, keySecret: SECRET })).rejects.toThrow(/does not decrypt the token signing key moved/);
    // the secret was lost: a rotation with the new one retires the unreadable keys without reading them
    await createAuth({ db, keySecret: OTHER }).rotateSigningKey();
    await expect(checkKeySetup(db, { publicRead: true, keySecret: OTHER })).resolves.toBeUndefined();
  });

  it('refuses a secret too short to be a key', async () => {
    expect(() => createAuth({ db: {} as Db, keySecret: 'short' })).toThrow(/at least 32 characters/);
  });

  it('the server from the environment: refuses PUBLIC_READ=false without it, starts with it', async () => {
    await expect(libraryFromEnv({ REFRESH_TOKEN_GRACE: '61' })).rejects.toThrow(/0 to 60/);
    await expect(libraryFromEnv({ DATABASE_URL: 'pglite:', PUBLIC_READ: 'false', DISK_DIR: join(tmpdir(), 'chalk-library-unused') })).rejects.toThrow(/AUTH_KEY_SECRET/);
    const o = await libraryFromEnv({ DATABASE_URL: 'pglite:', PUBLIC_READ: 'false', AUTH_KEY_SECRET: SECRET, REFRESH_TOKEN_GRACE: '0', DISK_DIR: join(tmpdir(), 'chalk-library-unused') });
    open.push(o.db);
    expect(o.auth).toMatchObject({ keySecret: SECRET, refreshGrace: 0 });
    expect((await stored(o.db))[0]!.private_key).toMatch(/^enc:v1:/);
  });
});
