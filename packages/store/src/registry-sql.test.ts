import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

// spec/1.2/registry.sql is informative, but it must work: run it in a real Postgres (PGlite) and use it.
const sql = readFileSync(new URL('../../../spec/1.2/registry.sql', import.meta.url), 'utf8');
const key = (c: string) => 'c1:' + c.repeat(25) + 'a';

describe('the reference registry schema', async () => {
  const db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(sql);
  await db.exec(`
    INSERT INTO stores (id, kind, template) VALUES ('r2', 'derived', 'https://media.example/c1/{h0}/{h1}/{h}');
    INSERT INTO assets (key, sha256, type, size, title, filename, tags, subject, status) VALUES
      ('${key('a')}', '${'a'.repeat(64)}', 'video/mp4', 1000, 'সরল দোলক · Simple pendulum', 'pendulum.mp4', '{physics,oscillation}', 'physics', 'available'),
      ('${key('b')}', '${'b'.repeat(64)}', 'model/gltf-binary', 2000, 'স্ক্রু গজ · Screw gauge', 'screw-gauge.glb', '{physics,measurement}', 'physics', 'available'),
      ('${key('c')}', '${'c'.repeat(64)}', 'audio/mpeg', 300, 'সুরশলাকা ৪৪০ Hz · Tuning fork', 'fork.mp3', '{physics,sound}', 'physics', 'available');
    INSERT INTO locations (key, store, path) VALUES ('${key('a')}', 'r2', 'c1/aa/aa/${'a'.repeat(25)}a');
  `);
  const search = async (q: string, type = '%') => (await db.query<{ title: string }>(
    `SELECT title FROM assets WHERE status = 'available' AND type LIKE $2 AND $1 <% search_text
     ORDER BY word_similarity($1, search_text) DESC, created_at DESC LIMIT 30`, [q, type])).rows.map((r) => r.title);

  it('finds by a Bengali word, an English word, or a misspelling', async () => {
    expect(await search('দোলক')).toEqual(['সরল দোলক · Simple pendulum']);
    expect(await search('gauge')).toEqual(['স্ক্রু গজ · Screw gauge']);
    expect(await search('pendulm')).toEqual(['সরল দোলক · Simple pendulum']);
    expect(await search('দোলক', 'audio/%')).toEqual([]);
  });

  it('refuses keys that are not canonical c1 keys', async () => {
    await expect(db.exec(`INSERT INTO assets (key, sha256, type, size) VALUES ('C1:ABC', '${'d'.repeat(64)}', 'image/png', 1)`)).rejects.toThrow();
    await expect(db.exec(`INSERT INTO assets (key, sha256, type, size) VALUES ('${'c1:' + 'd'.repeat(26)}', '${'d'.repeat(64)}', 'image/png', 1)`)).rejects.toThrow();
  });

  it('keeps a derived store consistent: a template, and only for derived stores', async () => {
    await expect(db.exec(`INSERT INTO stores (id, kind) VALUES ('bad', 'derived')`)).rejects.toThrow();
    await expect(db.exec(`INSERT INTO stores (id, kind, base, template) VALUES ('bad2', 'api', 'https://x/', 'https://x/{h}')`)).rejects.toThrow();
  });

  it('answers "which books use this" and never loses an asset a book uses', async () => {
    await db.exec(`INSERT INTO book_assets (book_id, key) VALUES ('physics-9', '${key('a')}'), ('physics-10', '${key('a')}')`);
    const used = await db.query<{ book_id: string }>(`SELECT book_id FROM book_assets WHERE key = $1 ORDER BY book_id`, [key('a')]);
    expect(used.rows.map((r) => r.book_id)).toEqual(['physics-10', 'physics-9']);
    await expect(db.exec(`DELETE FROM assets WHERE key = '${key('a')}'`)).rejects.toThrow();
  });
});
