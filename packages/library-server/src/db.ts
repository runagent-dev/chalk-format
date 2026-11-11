import { mkdirSync, readFileSync } from 'node:fs';

/**
 * The library's database: Postgres (the reference schema, spec/1.2/registry.sql). Postgres in production
 * (`postgres://…`); PGlite, Postgres compiled to WebAssembly, for tests and small setups (`pglite:` in memory,
 * `pglite:./data` on disk), so a library can start with no database to install.
 */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Runs `fn` in one transaction: its queries all happen or none does (an error rolls back). */
  begin<T>(fn: (query: Db['query']) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** The reference schema: next to the bundle in a deployment (dist/registry.sql), else from the repository. */
function schemaSql(): string {
  for (const u of [new URL('./registry.sql', import.meta.url), new URL('../../../spec/1.2/registry.sql', import.meta.url)]) {
    try { return readFileSync(u, 'utf8'); } catch { /* try the next place */ }
  }
  throw new Error('registry.sql not found');
}

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
    if (dir) mkdirSync(dir, { recursive: true });
    const pg = new PGlite({ ...(dir ? { dataDir: dir } : {}), extensions: { pg_trgm } });
    db = {
      async query<T>(sql: string, params: unknown[] = []) { return (await pg.query<T>(sql, params)).rows; },
      begin: (fn) => pg.transaction((tx) => fn(async <T>(sql: string, params: unknown[] = []) => (await tx.query<T>(sql, params)).rows)),
      async close() { await pg.close(); },
    };
    await migrate(db, (sql) => pg.transaction((tx) => tx.exec(sql)).then(() => undefined));
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
      begin: <T>(fn: (query: Db['query']) => Promise<T>) => sql.begin((tx) => fn(async <R>(text: string, params: unknown[] = []) => (await tx.unsafe(text, params as never[])) as unknown as R[])) as Promise<T>,
      async close() { await sql.end(); },
    };
    await migrate(db, (text) => sql.begin((tx) => tx.unsafe(text).simple()).then(() => undefined));
  }
  return db;
}

/** The reference schema, once. Later versions add numbered steps here (backward compatible only). */
async function migrate(db: Db, exec: (sql: string) => Promise<void>) {
  await db.query('CREATE TABLE IF NOT EXISTS chalk_library_schema (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await db.query<{ version: number }>('SELECT version FROM chalk_library_schema')).map((r) => r.version));
  if (!done.has(1)) {
    await exec(schemaSql());
    await db.query('INSERT INTO chalk_library_schema (version) VALUES (1)');
  }
  // the tables and their record in one transaction (exec runs in one): a step is applied entirely or not at all
  if (!done.has(2)) await exec(`${AUTH_SQL}\nINSERT INTO chalk_library_schema (version) VALUES (2);`);
  // step 3: a rotated refresh token keeps its successor, sealed with the rotated token itself, so that sending it
  // again within the grace window gives the same successor (a lost answer does not sign the device out)
  if (!done.has(3)) await exec('ALTER TABLE auth_refresh_tokens ADD COLUMN IF NOT EXISTS successor text;\nINSERT INTO chalk_library_schema (version) VALUES (3);');
  // step 4: files adopted in place (registry-api §3.1). A key may be at several paths of one store (two books that
  // hold the same file, each its own copy), and a path is checked now and then: when it was, and whether it was gone.
  if (!done.has(4)) await exec(`ALTER TABLE locations DROP CONSTRAINT IF EXISTS locations_pkey;
ALTER TABLE locations ADD PRIMARY KEY (key, store, path);
ALTER TABLE locations ADD COLUMN IF NOT EXISTS checked_at timestamptz;
ALTER TABLE locations ADD COLUMN IF NOT EXISTS missing boolean NOT NULL DEFAULT false;
INSERT INTO chalk_library_schema (version) VALUES (4);`);
  // step 5: the highlights of books (registry-api §11), editable records: the lines of a book and the questions linked to them
  if (!done.has(5)) await exec(`${HIGHLIGHTS_SQL}\nINSERT INTO chalk_library_schema (version) VALUES (5);`);
  // step 6: a line's boxes as a person drew them (registry-api §11.3, lines/:id/rects): shown instead of the computed ones, and kept by a sync
  if (!done.has(6)) await exec(`ALTER TABLE book_lines ADD COLUMN IF NOT EXISTS rects_manual jsonb;
ALTER TABLE book_lines ADD COLUMN IF NOT EXISTS rects_by text;
ALTER TABLE book_lines ADD COLUMN IF NOT EXISTS rects_at timestamptz;
INSERT INTO chalk_library_schema (version) VALUES (6);`);
  // step 7: API keys that act for people (registry-api §10.7, Chalk-Actor), and the people they acted for: the records
  // keep an actor's id (staff:<id>, system:<job>), this table its latest display name
  if (!done.has(7)) await exec(`ALTER TABLE auth_api_keys ADD COLUMN IF NOT EXISTS act_for boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS actors (
  id             text PRIMARY KEY,
  name           text NOT NULL,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now()
);
INSERT INTO chalk_library_schema (version) VALUES (7);`);
}

/** Step 5: book highlights (spec/1.2/registry-api.md §11). Questions are named by their lasting id only (no foreign key: they are manifests). */
const HIGHLIGHTS_SQL = `
CREATE TABLE IF NOT EXISTS book_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book           text NOT NULL,
  key            text NOT NULL,                   -- the line's lasting name in the book: "<page id>/<hash>/<n>"
  page_id        text NOT NULL,
  page_no        integer NOT NULL,
  idx            integer NOT NULL,                -- place on the page, from 0
  block          integer NOT NULL,                -- the paragraph
  kind           text NOT NULL,                   -- body, heading, formula, caption
  text           text NOT NULL,
  text_hash      text NOT NULL,
  chapter_no     integer,
  chapter_title  text,
  section        text,
  rects          jsonb NOT NULL DEFAULT '[]',     -- [{x, y, w, fs}] in page units, one per printed line
  retired_at     timestamptz,                     -- the text layer no longer has it: kept, so its links are kept
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (book, key)
);
CREATE INDEX IF NOT EXISTS book_lines_page ON book_lines (book, page_no, idx);
CREATE INDEX IF NOT EXISTS book_lines_chapter ON book_lines (book, chapter_no);
CREATE TABLE IF NOT EXISTS book_links (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book           text NOT NULL,
  question_id    uuid NOT NULL,                   -- the question manifest's lasting id (spec 1.7)
  line_id        uuid NOT NULL REFERENCES book_lines (id) ON DELETE CASCADE,
  role           text NOT NULL DEFAULT 'answers_from',
  scope          text NOT NULL DEFAULT 'sentence',
  method         text NOT NULL DEFAULT 'auto',    -- auto (a matcher's) or human
  status         text NOT NULL DEFAULT 'suggested', -- suggested, confirmed, rejected (a removal remembered)
  score          real,
  rationale      text,
  question_type  text,
  reviewed_by    text,
  reviewed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (question_id, line_id, role)
);
CREATE INDEX IF NOT EXISTS book_links_line ON book_links (line_id);
CREATE INDEX IF NOT EXISTS book_links_book ON book_links (book, status);
CREATE INDEX IF NOT EXISTS book_links_question ON book_links (question_id);
`;

/**
 * Step 2: the library as its own identity provider (spec/1.2/registry-api.md §10). Not part of the reference
 * registry schema: another registry may issue tokens however it likes. Secrets are kept only as hashes.
 */
const AUTH_SQL = `
CREATE TABLE IF NOT EXISTS auth_users (
  id               text PRIMARY KEY,
  username         text NOT NULL UNIQUE,
  password_hash    text NOT NULL,                  -- scrypt$N$r$p$salt$hash
  roles            text[] NOT NULL,                -- reader, author, admin (expanded: an author also holds reader)
  disabled         boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  last_sign_in_at  timestamptz
);
-- refresh tokens: one row per token; the tokens of one sign-in share a family, which is revoked as a whole when
-- a used token comes back (theft detection)
CREATE TABLE IF NOT EXISTS auth_refresh_tokens (
  id          text PRIMARY KEY,
  token_hash  char(64) NOT NULL UNIQUE,            -- SHA-256, hex
  family_id   text NOT NULL,
  user_id     text NOT NULL REFERENCES auth_users (id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  rotated_at  timestamptz,                         -- used once: a new token was issued for it
  revoked_at  timestamptz
);
CREATE INDEX IF NOT EXISTS auth_refresh_tokens_family ON auth_refresh_tokens (family_id);
CREATE INDEX IF NOT EXISTS auth_refresh_tokens_user ON auth_refresh_tokens (user_id);
CREATE TABLE IF NOT EXISTS auth_api_keys (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  key_hash      char(64) NOT NULL UNIQUE,          -- SHA-256 of clk_…, hex
  hint          text NOT NULL,                     -- the first characters, to tell keys apart in a list
  roles         text[] NOT NULL,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
-- the library's token signing keys (Ed25519); a retired key keeps its public half until its tokens expire
CREATE TABLE IF NOT EXISTS auth_keys (
  kid          text PRIMARY KEY,
  alg          text NOT NULL DEFAULT 'EdDSA',
  public_key   text NOT NULL,                      -- SPKI PEM
  private_key  text,                               -- PKCS#8 PEM, sealed (enc:v1:…) with AUTH_KEY_SECRET; removed when the key is retired
  created_at   timestamptz NOT NULL DEFAULT now(),
  retired_at   timestamptz
);
`;
