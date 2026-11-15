import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { c1FromSha256 } from '@chalk-format/model';
import { checkKeySetup, createLibraryApp, diskStorage, libraryFromEnv, openDb } from './index.js';
import { SCHEMA_VERSION } from './db.js';

const BASE = 'http://library.test';
const dirs: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

// MIGRATE_ON_START=false: the server changes nothing in its schema, and refuses one that is not current
describe('migrations at start, or as a release step', { timeout: 60_000 }, () => {
  it('an unmigrated schema: the server refuses to start and says what to run', async () => {
    await expect(openDb('pglite:', { migrate: false })).rejects.toThrow(/has no tables yet.*chalk-library migrate/);
    await expect(libraryFromEnv({ DATABASE_URL: `pglite:${tmp('chalk-mig-')}`, MIGRATE_ON_START: 'false' })).rejects.toThrow(/not current/);
    await expect(libraryFromEnv({ DATABASE_URL: 'pglite:', MIGRATE_ON_START: 'later' })).rejects.toThrow(/MIGRATE_ON_START must be on or off/);
  });

  it('a migrated schema starts; one a step behind does not', async () => {
    const url = `pglite:${tmp('chalk-mig-')}`;
    // the release step (chalk-library migrate)
    await (await openDb(url)).close();
    const o = await libraryFromEnv({ DATABASE_URL: url, MIGRATE_ON_START: 'false' });
    expect((await o.db.query<{ n: number }>('SELECT count(*)::int AS n FROM chalk_library_schema'))[0]!.n).toBe(SCHEMA_VERSION);
    await o.db.query('DELETE FROM chalk_library_schema WHERE version = $1', [SCHEMA_VERSION]);
    await o.db.close();
    await expect(openDb(url, { migrate: false })).rejects.toThrow(new RegExp(`steps ${SCHEMA_VERSION} are missing`));
    // migrating again applies only what is missing (each step is additive and IF NOT EXISTS)
    await (await openDb(url)).close();
    await (await openDb(url, { migrate: false })).close();
  });
});

// A runtime login that may only read and write the rows of the library's schema (no CREATE anywhere), as in a
// deployment where an owner login runs `chalk-library migrate`. Needs a real Postgres where the given login can
// make roles: CHALK_LIBRARY_TEST_DB=postgres://postgres:…@localhost:5432/db
const SUPER = process.env.CHALK_LIBRARY_TEST_DB;
describe.skipIf(!SUPER)('a runtime login with DML rights only (real Postgres)', { timeout: 120_000 }, () => {
  it('migrated by the owner, then served by a login that cannot create anything', async () => {
    const { default: postgres } = await import('postgres');
    // a database of its own: pg_trgm exists once per database, in one schema
    const id = Date.now().toString(36), database = `rt_db_${id}`, schema = 'chalk_library', owner = `rt_owner_${id}`, runtime = `rt_app_${id}`;
    const admin = postgres(SUPER!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE ${database}`);
    const as = (user?: string) => { const u = new URL(SUPER!); u.pathname = `/${database}`; if (user) { u.username = user; u.password = `pw-${user}`; } return u.toString(); };
    const sql = postgres(as(), { max: 1, onnotice: () => {} });
    try {
      // the database's setup (a superuser): the owner owns the schema, pg_trgm lives in it, the runtime login gets DML
      await sql.unsafe(`CREATE ROLE ${owner} LOGIN PASSWORD 'pw-${owner}'`);
      await sql.unsafe(`CREATE ROLE ${runtime} LOGIN PASSWORD 'pw-${runtime}'`);
      await sql.unsafe(`CREATE SCHEMA ${schema} AUTHORIZATION ${owner}`);
      await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA ${schema}`);
      await sql.unsafe(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
      await sql.unsafe(`GRANT CONNECT ON DATABASE ${database} TO ${owner}, ${runtime}`);
      await sql.unsafe('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
      await sql.unsafe(`GRANT USAGE ON SCHEMA ${schema} TO ${runtime}`);
      await sql.unsafe(`ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${schema} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${runtime}`);
      await sql.unsafe(`ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${schema} GRANT USAGE, SELECT ON SEQUENCES TO ${runtime}`);

      // before the release step the runtime login cannot start; it cannot migrate either
      await expect(openDb(as(runtime), { schema, migrate: false })).rejects.toThrow(/has no tables yet/);
      await expect(openDb(as(runtime), { schema })).rejects.toThrow();
      // the release step, as the owner
      await (await openDb(as(owner), { schema })).close();

      const db = await openDb(as(runtime), { schema, migrate: false });
      try {
        await expect(db.query('CREATE TABLE x (a int)')).rejects.toThrow(/permission denied/);
        const keySecret = 'a-test-secret-that-is-long-enough-0123456789';
        await checkKeySetup(db, { publicRead: true, keySecret });
        const dir = tmp('chalk-rt-');
        const app = createLibraryApp({ db, storage: diskStorage(dir, { uploadBase: BASE }), publicUrl: `${BASE}/files/`, callers: (t) => (t === 'root' ? { user: 'root', sub: 'root', admin: true, roles: ['reader', 'author', 'admin'], kind: 'bootstrap' } : null), publicRead: true, issuer: BASE, auth: { keySecret } });
        const call = async (path: string, o: { method?: string; token?: string; body?: unknown; actor?: unknown } = {}) => {
          const res = await app.fetch(new Request(`${BASE}${path}`, {
            method: o.method ?? (o.body !== undefined ? 'POST' : 'GET'),
            headers: { ...(o.token === '' ? {} : { Authorization: `Bearer ${o.token ?? 'root'}` }), 'Content-Type': 'application/json', ...(o.actor ? { 'Chalk-Actor': Buffer.from(JSON.stringify(o.actor)).toString('base64url') } : {}) },
            ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
          }));
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- answers of many shapes
          return { status: res.status, body: (await res.json().catch(() => null)) as any };
        };
        // keys, acting for a person, an upload, search (pg_trgm), highlights, the users and their signing key
        const key = await call('/v1/admin/keys', { body: { name: 'dashboard', roles: ['author'], actFor: true } });
        expect(key.status).toBe(201);
        const rita = { id: 'staff:rita-1', name: 'Rita' };
        const bytes = new TextEncoder().encode('runtime login'), sha256 = createHash('sha256').update(bytes).digest('hex'), k = c1FromSha256(`sha256:${sha256}`);
        const up = await call('/v1/uploads', { token: key.body.key, actor: rita, body: { key: k, sha256, type: 'image/png', size: bytes.byteLength } });
        expect(up.status, JSON.stringify(up.body)).toBe(200);
        await app.fetch(new Request(up.body.upload.url, { method: 'PUT', body: bytes }));
        const reg = await call('/v1/assets', { token: key.body.key, actor: rita, body: { key: k, sha256, type: 'image/png', size: bytes.byteLength, title: 'ফলক runtime login' } });
        expect(reg.body).toMatchObject({ status: 'available', uploadedBy: rita.id });
        expect((await call('/v1/search?q=runtime')).body.items.map((x: { key: string }) => x.key)).toEqual([k]);
        expect((await call('/v1/admin/actors')).body.items).toEqual([expect.objectContaining(rita)]);
        expect((await call('/v1/books/rt-book/lines/sync', { body: { lines: [{ key: 'p1/0/0', pageId: 'p1', pageNo: 1, idx: 0, block: 0, kind: 'body', text: 'a', textHash: 'h', rects: [] }] } })).status).toBe(200);
        expect((await call('/v1/admin/users', { body: { username: 'arun', password: 'author-password-1', roles: ['author'] } })).status).toBe(201);
        expect((await call('/v1/auth/token', { token: '', body: { grant_type: 'password', username: 'arun', password: 'author-password-1' } })).status).toBe(200);
      } finally { await db.close(); }
    } finally {
      await sql.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      for (const r of [owner, runtime]) await admin.unsafe(`DROP ROLE IF EXISTS ${r}`);
      await admin.end();
    }
  });
});
