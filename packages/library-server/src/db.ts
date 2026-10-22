import { readFileSync } from 'node:fs';

/**
 * The library's database: Postgres (the reference schema, spec/1.2/registry.sql). Postgres in production
 * (`postgres://…`); PGlite, Postgres compiled to WebAssembly, for tests and small setups (`pglite:` in memory,
 * `pglite:./data` on disk), so a library can start with no database to install.
 */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

const SCHEMA = new URL('../../../spec/1.2/registry.sql', import.meta.url);

/**
 * `schema`: Postgres only: everything the library makes (tables, its migration record, the pg_trgm extension) goes
 * into this schema, so a library can share a database with an app without touching the app's tables. Default
 * `chalk_library`.
 */
export async function openDb(url: string, o: { schema?: string } = {}): Promise<Db> {
  let db: Db;
  if (url.startsWith('pglite:')) {
    const { PGlite } = await import('@electric-sql/pglite');
    const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
    const dir = url.slice('pglite:'.length);
    const pg = new PGlite({ ...(dir ? { dataDir: dir } : {}), extensions: { pg_trgm } });
    db = {
      async query<T>(sql: string, params: unknown[] = []) { return (await pg.query<T>(sql, params)).rows; },
      async close() { await pg.close(); },
    };
    await migrate(db, (sql) => pg.exec(sql).then(() => undefined));
  } else {
    const { default: postgres } = await import('postgres');
    const schema = o.schema ?? 'chalk_library';
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error(`not a schema name: ${schema}`);
    const setup = postgres(url, { max: 1, onnotice: () => {} });
    await setup.unsafe(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await setup.end();
    // every connection works in the library's schema (public after it, for what the database already has)
    const sql = postgres(url, { max: 10, onnotice: () => {}, connection: { search_path: `${schema}, public` } });
    db = {
      async query<T>(text: string, params: unknown[] = []) { return (await sql.unsafe(text, params as never[])) as unknown as T[]; },
      async close() { await sql.end(); },
    };
    await migrate(db, (text) => sql.unsafe(text).simple().then(() => undefined));
  }
  return db;
}

/** The reference schema, once. Later versions add numbered steps here (backward compatible only). */
async function migrate(db: Db, exec: (sql: string) => Promise<void>) {
  await db.query('CREATE TABLE IF NOT EXISTS chalk_library_schema (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await db.query<{ version: number }>('SELECT version FROM chalk_library_schema')).map((r) => r.version));
  if (!done.has(1)) {
    await exec(readFileSync(SCHEMA, 'utf8'));
    await db.query('INSERT INTO chalk_library_schema (version) VALUES (1)');
  }
}
