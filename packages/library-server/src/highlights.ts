import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { ACTOR_LIKE, requireRole, type AuthVariables } from './auth/guard.js';
import type { Caller } from './auth/roles.js';
import type { Db } from './db.js';

/**
 * The highlights of books (spec/1.2/registry-api.md §11): the lines of a book's text and the questions linked to them,
 * as records that change one by one. An editor adds, moves and takes off links; a matcher suggests them; reading apps
 * ask for the lines of the pages they show. Reads need `reader`, writes `author`.
 *
 * A rejected link is kept: it is the memory that a pair was taken off, so a matcher never puts it back. A link is a
 * person's decision when its method is `human`, it was reviewed, or it is confirmed; a question with one is never
 * placed by a matcher (`links/place`).
 */

type Query = Db['query'];
type Fail = (c: Context, status: number, code: string, message: string) => Response;

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ROLES = ['answers_from', 'tests_concept', 'uses_figure', 'formula_source'] as const;
const STATUSES = ['suggested', 'confirmed', 'rejected'] as const;
const SCOPES = ['sentence', 'paragraph', 'section'] as const;
/** The most lines one change of a question's highlight may name: a highlight is a few lines, not a chapter. */
export const MAX_LINE_CHANGES = 200;

/** A uuid, in its canonical form (lower case, as Postgres prints one): every id is compared as the database stores it. */
const uuid = z.string().uuid().transform((s) => s.toLowerCase());
/** An id from the URL (a path part or a query parameter) in the same canonical form; anything else is left as it is and fails its check. */
const idOf = (v: string | undefined) => v?.toLowerCase();
const by = z.string().min(1).max(200);
const role = z.enum(ROLES);
const scope = z.enum(SCOPES);
/** A question's kind as the writer names it (`mcq`, `cq`, …): a plain lower-case name, so it is safe as a key of the counts it is grouped by. */
const TYPE_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const questionType = z.string().regex(TYPE_NAME).optional();
const rect = z.object({ x: z.number(), y: z.number(), w: z.number(), fs: z.number() });
const lineIn = z.object({
  key: z.string().min(1).max(300), pageId: z.string().min(1).max(200), pageNo: z.number().int().min(0), idx: z.number().int().min(0), block: z.number().int().min(0),
  kind: z.string().min(1).max(40), text: z.string().max(20_000), textHash: z.string().min(1).max(200),
  chapterNo: z.number().int().nullable().optional(), chapterTitle: z.string().max(500).nullable().optional(), section: z.string().max(2000).nullable().optional(),
  rects: z.array(rect).max(200),
});
const syncSchema = z.object({ lines: z.array(lineIn).max(200_000) });
const addSchema = z.object({ questionId: uuid, lineId: uuid, role: role.optional(), scope: scope.optional(), questionType, by });
const patchSchema = z.object({ status: z.enum(STATUSES).optional(), role: role.optional(), scope: scope.optional(), lineId: uuid.optional(), by });
const bySchema = z.object({ by });
const removeSchema = z.object({ paragraph: z.boolean().optional(), by });
const moveSchema = z.object({ to: uuid, by });
const linesSchema = z.object({ role, add: z.array(uuid), remove: z.array(uuid), scope: scope.optional(), questionType, by });
const placeSchema = z.object({
  questionId: uuid, questionType,
  proposals: z.array(z.object({ lineId: uuid, role, scope: scope.optional(), score: z.number().nullable().optional(), rationale: z.string().max(2000).nullable().optional() })).max(500),
});
const importSchema = z.object({
  lines: z.array(lineIn.extend({ id: uuid, retiredAt: z.string().nullable().optional() })).max(200_000),
  links: z.array(z.object({
    id: uuid, questionId: uuid, lineId: uuid, role: z.string().min(1).max(40), scope: z.string().min(1).max(40), method: z.string().min(1).max(20), status: z.enum(STATUSES),
    score: z.number().nullable().optional(), rationale: z.string().nullable().optional(), questionType: z.string().regex(TYPE_NAME).nullable().optional(),
    reviewedBy: z.string().nullable().optional(), reviewedAt: z.string().nullable().optional(), createdAt: z.string().optional(),
  })).max(500_000),
});
const questionsSchema = z.object({ questionIds: z.array(uuid).max(5000) });
/** A box a person drew: on the page (page units), with a width and a type size. */
const drawn = z.object({ x: z.number().finite().min(0).max(100_000), y: z.number().finite().min(0).max(100_000), w: z.number().finite().positive().max(100_000), fs: z.number().finite().positive().max(1_000) });
/** `rects`: the line's boxes as a person drew them; null goes back to the computed ones. */
const rectsSchema = z.object({ rects: z.array(drawn).min(1).max(200).nullable(), by });

/** A person's decision, on the links table as `k`. */
const HUMAN = `(k.method = 'human' OR k.reviewed_by IS NOT NULL OR k.status = 'confirmed')`;

/** A line as readers get it: the boxes a person drew when there are any (`rectsManual`), else the computed ones. */
const LINE_COLS = `l.id, l.key, l.page_id AS "pageId", l.page_no AS "pageNo", l.idx, l.block, l.kind, l.text, l.text_hash AS "textHash",
  l.chapter_no AS "chapterNo", l.chapter_title AS "chapterTitle", l.section, coalesce(l.rects_manual, l.rects) AS rects,
  l.rects_manual IS NOT NULL AS "rectsManual", l.rects_by AS "rectsBy", l.retired_at AS "retiredAt"`;
/** A line as a sync compares it: the computed boxes (a person's are never replaced by a sync). */
const SYNC_COLS = `l.id, l.key, l.page_id AS "pageId", l.page_no AS "pageNo", l.idx, l.block, l.kind, l.text, l.text_hash AS "textHash",
  l.chapter_no AS "chapterNo", l.chapter_title AS "chapterTitle", l.section, l.rects, l.retired_at AS "retiredAt"`;
const LINK_COLS = `k.id, k.question_id AS "questionId", k.line_id AS "lineId", k.role, k.scope, k.method, k.status, k.score, k.rationale,
  k.question_type AS "questionType", k.reviewed_by AS "reviewedBy", k.reviewed_at AS "reviewedAt", k.created_at AS "createdAt",
  jsonb_build_object('id', l.id, 'key', l.key, 'pageId', l.page_id, 'pageNo', l.page_no, 'idx', l.idx, 'block', l.block, 'text', l.text,
    'chapterNo', l.chapter_no, 'retiredAt', l.retired_at) AS line`;
const LINKS_FROM = `FROM book_links k JOIN book_lines l ON l.id = k.line_id`;

type LineRow = { id: string; key: string; pageId: string; text: string; textHash: string; retiredAt: string | Date | null; pageNo: number; idx: number; block: number; kind: string; chapterNo: number | null; chapterTitle: string | null; section: string | null; rects: unknown };

class HighlightError extends Error {
  constructor(readonly status: 400 | 404 | 409, readonly code: string, message: string) { super(message); }
}
const notFound = (what: string) => new HighlightError(404, 'not_found', what);
const retired = () => new HighlightError(409, 'conflict', 'that line is no longer in the book');

/**
 * Takes the lock of a question for the rest of the transaction: writes to one question happen one after another. The id is taken in its
 * canonical form (lower case, as Postgres prints a uuid), so two spellings of one id share the lock.
 */
const lockQuestion = (q: Query, id: string) => q(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`chalk-highlights:q:${id.toLowerCase()}`]);

/**
 * Locks every question with a link on these lines, in id order (so two bulk changes never wait on each other crosswise), and gives their ids:
 * a bulk change then touches only those questions' links.
 */
async function lockQuestionsOf(q: Query, lineIds: string[]): Promise<string[]> {
  const ids = (await q<{ id: string }>(`SELECT DISTINCT question_id::text AS id FROM book_links WHERE line_id = ANY($1::uuid[]) ORDER BY 1`, [lineIds])).map((r) => r.id);
  for (const id of ids) await lockQuestion(q, id);
  return ids;
}

async function linkView(q: Query, id: string) {
  return (await q(`SELECT ${LINK_COLS} ${LINKS_FROM} WHERE k.id = $1`, [id]))[0]!;
}

/** The line, if the book has it; `live` also refuses a retired one. */
async function lineOf(q: Query, book: string, id: string, live: boolean) {
  const [l] = await q<{ id: string; retired: boolean }>(`SELECT id, retired_at IS NOT NULL AS retired FROM book_lines WHERE id = $1 AND book = $2`, [id, book]);
  if (!l) throw notFound('that line is not in this book');
  if (live && l.retired) throw retired();
  return l;
}

/** The lines a change on one line covers: the line, or (`paragraph`) every live line of its paragraph. */
async function covered(q: Query, book: string, lineId: string, paragraph: boolean): Promise<string[]> {
  const rows = paragraph
    ? await q<{ id: string }>(`SELECT x.id FROM book_lines x JOIN book_lines l ON l.id = $2 AND l.book = $1
        WHERE x.book = $1 AND x.page_no = l.page_no AND x.block = l.block AND x.retired_at IS NULL`, [book, lineId])
    : await q<{ id: string }>(`SELECT id FROM book_lines WHERE book = $1 AND id = $2`, [book, lineId]);
  return rows.map((r) => r.id);
}

/** Boxes compared by their numbers: jsonb keeps an object's keys in its own order, so the JSON text of the same box differs. */
const boxes = (v: unknown) => JSON.stringify(Array.isArray(v) ? v.map((r: { x?: unknown; y?: unknown; w?: unknown; fs?: unknown }) => [r.x, r.y, r.w, r.fs]) : v);
const sameRects = (a: unknown, b: unknown) => boxes(a) === boxes(b);

/** What a sync would do: lines matched by key; one not sent any more is retired, not deleted. */
export function planLines(stored: LineRow[], lines: z.infer<typeof lineIn>[]) {
  const have = new Map(stored.map((r) => [r.key, r]));
  const want = new Set(lines.map((r) => r.key));
  const write: z.infer<typeof lineIn>[] = [];
  let added = 0, revived = 0;
  for (const r of lines) {
    const h = have.get(r.key);
    if (!h) { write.push(r); added++; continue; }
    if (h.retiredAt || h.pageId !== r.pageId || h.text !== r.text || h.textHash !== r.textHash || h.pageNo !== r.pageNo || h.idx !== r.idx || h.block !== r.block || h.kind !== r.kind || h.chapterNo !== (r.chapterNo ?? null)
      || h.chapterTitle !== (r.chapterTitle ?? null) || h.section !== (r.section ?? null) || !sameRects(h.rects, r.rects)) {
      write.push(r);
      if (h.retiredAt) revived++;
    }
  }
  const retire = stored.filter((s) => !want.has(s.key) && !s.retiredAt).map((s) => s.key);
  return { write, added, changed: write.length - added - revived, revived, retire };
}

const CHUNK = 1000;
const chunks = <T>(list: T[]) => Array.from({ length: Math.ceil(list.length / CHUNK) }, (_, i) => list.slice(i * CHUNK, (i + 1) * CHUNK));
const LINE_RECORDSET = `x(id uuid, key text, "pageId" text, "pageNo" int, idx int, block int, kind text, text text, "textHash" text,
  "chapterNo" int, "chapterTitle" text, section text, rects jsonb, "retiredAt" timestamptz)`;

export function registerHighlights(app: Hono<{ Variables: AuthVariables }>, o: { db: Db; fail: Fail }) {
  const { db, fail } = o;
  const run = async (c: Context, role: 'reader' | 'author', fn: (book: string) => Promise<Response>) => {
    const denied = requireRole(c, role); if (denied) return denied;
    const book = c.req.param('slug') ?? '';
    if (!SLUG.test(book)) return fail(c, 400, 'invalid', 'not a book slug');
    try { return await fn(book); } catch (err) {
      if (err instanceof HighlightError) return fail(c, err.status, err.code, err.message);
      throw err;
    }
  };
  const parse = async <T>(c: Context, schema: z.ZodType<T>): Promise<T> => {
    const caller = c.get('caller') as Caller | null | undefined;
    const actor = caller?.actingFor;
    // a request without a body (DELETE links/{id}) is an empty one for a key acting for a person: `by` comes from the header
    const text = await c.req.text();
    let raw: unknown;
    try {
      raw = actor && c.req.method === 'DELETE' && text === '' ? {} : JSON.parse(text);
    } catch {
      throw new HighlightError(400, 'invalid', 'body must be valid JSON');
    }
    // a key acting for a person (Chalk-Actor, §10.7): the person is `by`, whatever the body says (and it may leave `by` out)
    const takesBy = schema instanceof z.ZodObject && 'by' in schema.shape;
    const r = schema.safeParse(actor && takesBy && raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw, by: actor.id } : raw);
    if (!r.success) throw new HighlightError(400, 'invalid', r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    // only a key acting for someone may name a person or a job of the deployment: anyone else could sign as them
    if (!actor && takesBy && ACTOR_LIKE.test((r.data as { by?: string }).by ?? '')) throw notActing();
    return r.data;
  };
  const notActing = () => new HighlightError(400, 'actor_requires_act_for', 'a staff: or system: id is recorded only from an API key acting for that person (Chalk-Actor)');
  const int = (v: string | undefined) => (v !== undefined && /^\d{1,9}$/.test(v) ? Number(v) : undefined);
  const statusFilter = (c: Context) => (c.req.query('status') === 'confirmed' ? `k.status = 'confirmed'` : `k.status <> 'rejected'`);

  // ---- §11.2 reading ----

  app.get('/v1/books/:slug/lines', (c) => run(c, 'reader', async (book) => {
    const pages = [...new Set((c.req.query('pages') ?? '').split(',').map((s) => int(s.trim())).filter((n): n is number => n !== undefined))];
    if (pages.length > 50) throw new HighlightError(400, 'invalid', 'at most 50 pages at once');
    const out: Record<string, unknown[]> = Object.fromEntries(pages.map((p) => [String(p), []]));
    if (!pages.length) return c.json({ pages: out });
    const lines = await db.query<Record<string, unknown> & { id: string; pageNo: number }>(
      `SELECT ${LINE_COLS} FROM book_lines l WHERE l.book = $1 AND l.page_no = ANY($2::int[]) AND l.retired_at IS NULL ORDER BY l.page_no, l.idx`, [book, pages]);
    const links = await db.query<{ lineId: string; status: string; type: string | null }>(
      `SELECT k.line_id AS "lineId", k.status, k.question_type AS type ${LINKS_FROM} WHERE k.book = $1 AND l.page_no = ANY($2::int[]) AND l.retired_at IS NULL AND ${statusFilter(c)}`, [book, pages]);
    // the kinds are counted in a Map and only then made an object (Object.fromEntries defines own keys), so no kind can reach a prototype
    const byLine = new Map<string, { links: number; suggested: number; types: Map<string, { confirmed: number; suggested: number }> }>();
    for (const k of links) {
      const s = byLine.get(k.lineId) ?? { links: 0, suggested: 0, types: new Map() };
      s.links++;
      if (k.status === 'suggested') s.suggested++;
      if (k.type) {
        const t = s.types.get(k.type) ?? { confirmed: 0, suggested: 0 };
        if (k.status === 'confirmed') t.confirmed++; else t.suggested++;
        s.types.set(k.type, t);
      }
      byLine.set(k.lineId, s);
    }
    const linked = c.req.query('linked') === '1';
    for (const l of lines) {
      const counted = byLine.get(l.id);
      const s = { links: counted?.links ?? 0, suggested: counted?.suggested ?? 0, typeCounts: Object.fromEntries(counted?.types ?? []) };
      if (linked && !s.links) continue;
      const rest: Record<string, unknown> = { ...l };
      delete rest.textHash;
      delete rest.retiredAt;
      out[String(l.pageNo)]!.push({ ...rest, ...s });
    }
    return c.json({ pages: out });
  }));

  app.get('/v1/books/:slug/lines/all', (c) => run(c, 'reader', async (book) => {
    const chapter = int(c.req.query('chapter'));
    const items = await db.query(
      `SELECT ${LINE_COLS} FROM book_lines l WHERE l.book = $1 ${c.req.query('retired') === '1' ? '' : 'AND l.retired_at IS NULL'} ${chapter === undefined ? '' : 'AND l.chapter_no = $2'}
       ORDER BY l.page_no, l.idx, l.key`, chapter === undefined ? [book] : [book, chapter]);
    return c.json({ items });
  }));

  app.get('/v1/books/:slug/chapters', (c) => run(c, 'reader', async (book) => {
    const items = await db.query(`SELECT DISTINCT chapter_no AS no, chapter_title AS title FROM book_lines WHERE book = $1 AND chapter_no IS NOT NULL ORDER BY chapter_no`, [book]);
    return c.json({ items });
  }));

  app.get('/v1/books/:slug/pages/counts', (c) => run(c, 'reader', async (book) => {
    const rows = await db.query<{ pageNo: number; n: number }>(
      `SELECT l.page_no AS "pageNo", count(DISTINCT k.question_id)::int AS n ${LINKS_FROM} WHERE k.book = $1 AND l.retired_at IS NULL AND k.status <> 'rejected' GROUP BY l.page_no`, [book]);
    return c.json({ counts: Object.fromEntries(rows.map((r) => [String(r.pageNo), r.n])) });
  }));

  app.get('/v1/books/:slug/links', (c) => run(c, 'reader', async (book) => {
    const line = idOf(c.req.query('line')), question = idOf(c.req.query('question'));
    if (line !== undefined) {
      if (!uuid.safeParse(line).success) throw new HighlightError(400, 'invalid', 'line: not a uuid');
      const where = c.req.query('paragraph') === '1'
        ? `l.id IN (SELECT x.id FROM book_lines x JOIN book_lines y ON y.id = $2 AND y.book = $1 WHERE x.book = $1 AND x.page_no = y.page_no AND x.block = y.block AND x.retired_at IS NULL)`
        : `l.id = $2`;
      const items = await db.query(`SELECT ${LINK_COLS} ${LINKS_FROM} WHERE k.book = $1 AND ${where} AND ${statusFilter(c)}
        ORDER BY (k.status = 'confirmed') DESC, k.score DESC, k.created_at DESC`, [book, line]);
      return c.json({ items });
    }
    if (question !== undefined) {
      if (!uuid.safeParse(question).success) throw new HighlightError(400, 'invalid', 'question: not a uuid');
      return c.json({ items: await linksOfQuestion(db.query, book, question) });
    }
    // review: by chapter, status and method, in book order
    const where = ['k.book = $1'], params: unknown[] = [book];
    const chapter = int(c.req.query('chapter'));
    if (chapter !== undefined) { params.push(chapter); where.push(`l.chapter_no = $${params.length}`); }
    const status = c.req.query('status');
    if (status && (STATUSES as readonly string[]).includes(status)) { params.push(status); where.push(`k.status = $${params.length}`); } else where.push(`k.status <> 'rejected'`);
    const method = c.req.query('method');
    if (method) { params.push(method); where.push(`k.method = $${params.length}`); }
    const cond = where.join(' AND ');
    const limit = Math.min(int(c.req.query('limit')) ?? 50, 200), offset = int(c.req.query('offset')) ?? 0;
    const [counted, items] = await Promise.all([
      db.query<{ total: number }>(`SELECT count(*)::int AS total ${LINKS_FROM} WHERE ${cond}`, params),
      db.query(`SELECT ${LINK_COLS} ${LINKS_FROM} WHERE ${cond} ORDER BY l.page_no, l.idx, k.created_at DESC LIMIT ${limit} OFFSET ${offset}`, params),
    ]);
    return c.json({ items, total: counted[0]?.total ?? 0 });
  }));

  app.get('/v1/books/:slug/links/all', (c) => run(c, 'reader', async (book) => {
    const items = await db.query(`SELECT ${LINK_COLS} ${LINKS_FROM} WHERE k.book = $1 ${c.req.query('rejected') === '1' ? '' : `AND k.status <> 'rejected'`} ORDER BY k.question_id, l.key, k.role`, [book]);
    return c.json({ items });
  }));

  app.get('/v1/books/:slug/links/orphaned', (c) => run(c, 'reader', async (book) => {
    const items = await db.query(`SELECT ${LINK_COLS} ${LINKS_FROM} WHERE k.book = $1 AND ${HUMAN} AND k.status <> 'rejected' AND l.retired_at IS NOT NULL ORDER BY l.page_no, l.idx`, [book]);
    return c.json({ items });
  }));

  app.post('/v1/highlights/questions', async (c) => {
    const denied = requireRole(c, 'reader'); if (denied) return denied;
    const r = questionsSchema.safeParse(await c.req.json().catch(() => null));
    if (!r.success) return fail(c, 400, 'invalid', r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const rows = await db.query<{ id: string; live: number; human: boolean }>(
      `SELECT k.question_id AS id, (count(*) FILTER (WHERE k.status <> 'rejected'))::int AS live, bool_or(${HUMAN}) AS human
       FROM book_links k WHERE k.question_id = ANY($1::uuid[]) GROUP BY k.question_id`, [r.data.questionIds]);
    const found = new Map(rows.map((x) => [x.id, x]));
    return c.json({ items: Object.fromEntries(r.data.questionIds.map((id) => [id, { live: found.get(id)?.live ?? 0, human: found.get(id)?.human ?? false, any: found.has(id) }])) });
  });

  app.get('/v1/highlights/tagged', async (c) => {
    const denied = requireRole(c, 'reader'); if (denied) return denied;
    const rows = await db.query<{ id: string }>(`SELECT DISTINCT question_id AS id FROM book_links WHERE status <> 'rejected' ORDER BY 1`);
    return c.json({ questionIds: rows.map((r) => r.id) });
  });

  // ---- §11.3 writing ----

  app.post('/v1/books/:slug/lines/sync', (c) => run(c, 'author', async (book) => {
    const { lines } = await parse(c, syncSchema);
    const result = await db.begin(async (q) => {
      // one sync of a book at a time
      await q(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`chalk-highlights:sync:${book}`]);
      const stored = await q<LineRow>(`SELECT ${SYNC_COLS} FROM book_lines l WHERE l.book = $1`, [book]);
      const plan = planLines(stored, lines);
      for (const part of chunks(plan.write)) {
        await q(`INSERT INTO book_lines (book, key, page_id, page_no, idx, block, kind, text, text_hash, chapter_no, chapter_title, section, rects)
          SELECT $1, x.key, x."pageId", x."pageNo", x.idx, x.block, x.kind, x.text, x."textHash", x."chapterNo", x."chapterTitle", x.section, coalesce(x.rects, '[]')
          FROM jsonb_to_recordset($2::text::jsonb) AS ${LINE_RECORDSET}
          ON CONFLICT (book, key) DO UPDATE SET page_id = EXCLUDED.page_id, page_no = EXCLUDED.page_no, idx = EXCLUDED.idx, block = EXCLUDED.block, kind = EXCLUDED.kind,
            text = EXCLUDED.text, text_hash = EXCLUDED.text_hash, chapter_no = EXCLUDED.chapter_no, chapter_title = EXCLUDED.chapter_title, section = EXCLUDED.section, rects = EXCLUDED.rects,
            rects_manual = CASE WHEN book_lines.text_hash = EXCLUDED.text_hash THEN book_lines.rects_manual END,
            rects_by = CASE WHEN book_lines.text_hash = EXCLUDED.text_hash THEN book_lines.rects_by END,
            rects_at = CASE WHEN book_lines.text_hash = EXCLUDED.text_hash THEN book_lines.rects_at END, retired_at = NULL, updated_at = now()`,
        [book, JSON.stringify(part)]);
      }
      for (const part of chunks(plan.retire)) await q(`UPDATE book_lines SET retired_at = now(), updated_at = now() WHERE book = $1 AND retired_at IS NULL AND key = ANY($2::text[])`, [book, part]);
      // a person's link on a line that is gone is kept (links/orphaned lists it); a matcher's alone is turned down, and its question can be placed again
      const gone = await q(`UPDATE book_links k SET status = 'rejected', rationale = 'retired: the line is no longer in the book after re-indexing'
        WHERE k.book = $1 AND NOT ${HUMAN} AND k.status <> 'rejected' AND k.line_id IN (SELECT id FROM book_lines WHERE book = $1 AND retired_at IS NOT NULL) RETURNING k.id`, [book]);
      return { added: plan.added, changed: plan.changed, retired: plan.retire.length, revived: plan.revived, linksRetired: gone.length };
    });
    return c.json(result);
  }));

  app.post('/v1/books/:slug/links', (c) => run(c, 'author', async (book) => {
    const b = await parse(c, addSchema);
    const id = await db.begin(async (q) => {
      await lockQuestion(q, b.questionId);
      await lineOf(q, book, b.lineId, true);
      const [row] = await q<{ id: string }>(`INSERT INTO book_links (book, question_id, line_id, role, scope, method, status, question_type, reviewed_by, reviewed_at)
        VALUES ($1, $2, $3, $4, $5, 'human', 'confirmed', $6, $7, now())
        ON CONFLICT (question_id, line_id, role) DO UPDATE SET status = 'confirmed', scope = EXCLUDED.scope, method = 'human',
          question_type = coalesce(EXCLUDED.question_type, book_links.question_type), reviewed_by = EXCLUDED.reviewed_by, reviewed_at = now()
        RETURNING id`, [book, b.questionId, b.lineId, b.role ?? 'answers_from', b.scope ?? 'sentence', b.questionType ?? null, b.by]);
      return row!.id;
    });
    return c.json(await linkView(db.query, id), 201);
  }));

  app.patch('/v1/books/:slug/links/:id', (c) => run(c, 'author', async (book) => {
    const p = await parse(c, patchSchema);
    const linkId = idOf(c.req.param('id'))!;
    if (!uuid.safeParse(linkId).success) throw notFound('link not found');
    const kept = await db.begin(async (q) => {
      const [cur0] = await q<{ questionId: string }>(`SELECT question_id AS "questionId" FROM book_links WHERE id = $1 AND book = $2`, [linkId, book]);
      if (!cur0) throw notFound('link not found');
      await lockQuestion(q, cur0.questionId);
      const [cur] = await q<{ lineId: string; role: string }>(`SELECT line_id AS "lineId", role FROM book_links WHERE id = $1`, [linkId]);
      if (!cur) throw notFound('link not found');
      const set: Record<string, unknown> = { reviewed_by: p.by };
      if (p.status) set.status = p.status;
      if (p.role) set.role = p.role;
      if (p.scope) set.scope = p.scope;
      // a person who changes what it says (role, scope or line) makes it theirs; confirming a suggestion leaves it the matcher's; turning one down is a person's decision
      if (p.role || p.scope || p.lineId || p.status === 'rejected') set.method = 'human';
      if (p.lineId && p.lineId !== cur.lineId) {
        await lineOf(q, book, p.lineId, true);
        set.line_id = p.lineId;
        if (p.status === undefined) set.status = 'confirmed';
      }
      const target = (set.line_id as string | undefined) ?? cur.lineId, targetRole = (set.role as string | undefined) ?? cur.role;
      const [other] = await q<{ id: string }>(`SELECT id FROM book_links WHERE question_id = $1 AND line_id = $2 AND role = $3 AND id <> $4`, [cur0.questionId, target, targetRole, linkId]);
      if (other) {
        // the question already has that role on that line: that row is kept, confirmed and the person's, and this one goes
        await q(`UPDATE book_links SET status = 'confirmed', method = 'human', reviewed_by = $2, reviewed_at = now() WHERE id = $1`, [other.id, p.by]);
        await q(`DELETE FROM book_links WHERE id = $1`, [linkId]);
        return other.id;
      }
      const cols = Object.keys(set);
      await q(`UPDATE book_links SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')}, reviewed_at = now() WHERE id = $1`, [linkId, ...cols.map((k) => set[k])]);
      return linkId;
    });
    return c.json(await linkView(db.query, kept));
  }));

  app.delete('/v1/books/:slug/links/:id', (c) => run(c, 'author', async (book) => {
    const { by: who } = await parse(c, bySchema);
    const linkId = idOf(c.req.param('id'))!;
    if (!uuid.safeParse(linkId).success) throw notFound('link not found');
    // under the question's lock: taking a link off is a person's decision, so a matcher placing the question at the same moment must see it
    await db.begin(async (q) => {
      const [cur] = await q<{ questionId: string }>(`SELECT question_id AS "questionId" FROM book_links WHERE id = $1 AND book = $2`, [linkId, book]);
      if (!cur) throw notFound('link not found');
      await lockQuestion(q, cur.questionId);
      await q(`UPDATE book_links SET status = 'rejected', method = 'human', reviewed_by = $2, reviewed_at = now() WHERE id = $1`, [linkId, who]);
    });
    return c.json({ removed: 1 });
  }));

  app.post('/v1/books/:slug/lines/:id/links/remove', (c) => run(c, 'author', async (book) => {
    const b = await parse(c, removeSchema);
    const lineId = idOf(c.req.param('id'))!;
    if (!uuid.safeParse(lineId).success) throw notFound('that line is not in this book');
    const removed = await db.begin(async (q) => {
      const ids = await covered(q, book, lineId, Boolean(b.paragraph));
      if (!ids.length) throw notFound('that line is not in this book');
      const locked = await lockQuestionsOf(q, ids);
      const gone = await q(`UPDATE book_links SET status = 'rejected', method = 'human', reviewed_by = $2, reviewed_at = now()
        WHERE line_id = ANY($1::uuid[]) AND status <> 'rejected' AND question_id = ANY($3::uuid[]) RETURNING id`, [ids, b.by, locked]);
      return gone.length;
    });
    return c.json({ removed });
  }));

  // a line's boxes as a person drew them (the computed ones are often a few letters off where a sentence starts or ends inside a printed
  // line): shown instead of the computed ones from now on, and kept by every sync; null goes back to the computed ones
  app.put('/v1/books/:slug/lines/:id/rects', (c) => run(c, 'author', async (book) => {
    const b = await parse(c, rectsSchema);
    const id = idOf(c.req.param('id'))!;
    if (!uuid.safeParse(id).success) throw notFound('that line is not in this book');
    const line = await db.begin(async (q) => {
      await lineOf(q, book, id, true);
      await q(`UPDATE book_lines SET rects_manual = $3::text::jsonb, rects_by = $4, rects_at = CASE WHEN $3::text IS NULL THEN NULL ELSE now() END, updated_at = now() WHERE id = $1 AND book = $2`,
        [id, book, b.rects === null ? null : JSON.stringify(b.rects), b.rects === null ? null : b.by]);
      return (await q(`SELECT ${LINE_COLS} FROM book_lines l WHERE l.id = $1`, [id]))[0];
    });
    return c.json({ line });
  }));

  app.post('/v1/books/:slug/lines/:id/links/move', (c) => run(c, 'author', async (book) => {
    const b = await parse(c, moveSchema);
    const from = idOf(c.req.param('id'))!;
    if (!uuid.safeParse(from).success) throw notFound('that line is not in this book');
    const moved = await db.begin(async (q) => {
      await lineOf(q, book, b.to, true);
      await lineOf(q, book, from, false);
      // checked after both lines are known: moving a line onto itself still answers 404 for a line the book lacks and 409 for a retired one
      if (from === b.to) return 0;
      // the questions involved, locked in one order; only their links move (one that arrives meanwhile, of another question, stays where it is)
      const locked = await lockQuestionsOf(q, [from]);
      // the other line already has that tag: it is kept, becomes the person's, and is confirmed if it had been turned down; rejected rows of the old line stay there
      await q(`UPDATE book_links x SET status = CASE WHEN x.status = 'rejected' THEN 'confirmed' ELSE x.status END, method = 'human', reviewed_by = $3, reviewed_at = now()
        FROM book_links l WHERE l.line_id = $1 AND l.status <> 'rejected' AND l.question_id = ANY($4::uuid[]) AND x.line_id = $2 AND x.question_id = l.question_id AND x.role = l.role`, [from, b.to, b.by, locked]);
      await q(`DELETE FROM book_links l WHERE l.line_id = $1 AND l.status <> 'rejected' AND l.question_id = ANY($3::uuid[])
        AND EXISTS (SELECT 1 FROM book_links x WHERE x.line_id = $2 AND x.question_id = l.question_id AND x.role = l.role)`, [from, b.to, locked]);
      const rows = await q(`UPDATE book_links SET line_id = $2, method = 'human', reviewed_by = $3, reviewed_at = now()
        WHERE line_id = $1 AND status <> 'rejected' AND question_id = ANY($4::uuid[]) RETURNING id`, [from, b.to, b.by, locked]);
      return rows.length;
    });
    return c.json({ moved });
  }));

  app.put('/v1/books/:slug/questions/:question/lines', (c) => run(c, 'author', async (book) => {
    const b = await parse(c, linesSchema);
    const questionId = idOf(c.req.param('question'))!;
    if (!uuid.safeParse(questionId).success) throw new HighlightError(400, 'invalid', 'question: not a uuid');
    const add = [...new Set(b.add)], remove = [...new Set(b.remove)];
    if (!add.length && !remove.length) throw new HighlightError(400, 'invalid', 'name a line to add or take off');
    if (add.length + remove.length > MAX_LINE_CHANGES) throw new HighlightError(400, 'invalid', `at most ${MAX_LINE_CHANGES} lines at once`);
    if (add.some((s) => remove.includes(s))) throw new HighlightError(400, 'invalid', 'a line cannot be added and taken off at once');
    await db.begin(async (q) => {
      await lockQuestion(q, questionId);
      const named = [...add, ...remove];
      const lines = await q<{ id: string; retired: boolean }>(`SELECT id, retired_at IS NOT NULL AS retired FROM book_lines WHERE book = $1 AND id = ANY($2::uuid[])`, [book, named]);
      if (lines.length !== named.length) throw notFound('that line is not in this book');
      if (lines.some((l) => l.retired && add.includes(l.id))) throw retired();
      // the lines the highlight keeps become the person's
      await q(`UPDATE book_links SET method = 'human', status = 'confirmed', reviewed_by = $4, reviewed_at = now()
        WHERE book = $1 AND question_id = $2 AND role = $3 AND status <> 'rejected' AND NOT (line_id = ANY($5::uuid[]))`, [book, questionId, b.role, b.by, remove]);
      // a line taken off is the person's removal whatever its row was meanwhile (or none), so a matcher never places the question again
      for (const lineId of remove) await q(`INSERT INTO book_links (book, question_id, line_id, role, scope, method, status, question_type, reviewed_by, reviewed_at)
        VALUES ($1, $2, $3, $4, $5, 'human', 'rejected', $6, $7, now())
        ON CONFLICT (question_id, line_id, role) DO UPDATE SET status = 'rejected', method = 'human', reviewed_by = EXCLUDED.reviewed_by, reviewed_at = now()`,
      [book, questionId, lineId, b.role, b.scope ?? 'sentence', b.questionType ?? null, b.by]);
      for (const lineId of add) await q(`INSERT INTO book_links (book, question_id, line_id, role, scope, method, status, question_type, reviewed_by, reviewed_at)
        VALUES ($1, $2, $3, $4, $5, 'human', 'confirmed', $6, $7, now())
        ON CONFLICT (question_id, line_id, role) DO UPDATE SET status = 'confirmed', method = 'human', reviewed_by = EXCLUDED.reviewed_by, reviewed_at = now(),
          question_type = coalesce(EXCLUDED.question_type, book_links.question_type)${b.scope ? ', scope = EXCLUDED.scope' : ''}`,
      [book, questionId, lineId, b.role, b.scope ?? 'sentence', b.questionType ?? null, b.by]);
    });
    return c.json({ items: await linksOfQuestion(db.query, book, questionId) });
  }));

  app.post('/v1/books/:slug/links/place', (c) => run(c, 'author', async (book) => {
    const b = await parse(c, placeSchema);
    if (!b.proposals.length) return c.json({ placed: 0 });
    const placed = await db.begin(async (q) => {
      await lockQuestion(q, b.questionId);
      // still in the pool: no live link and no person's decision, in any book
      const [busy] = await q(`SELECT 1 FROM book_links k WHERE k.question_id = $1 AND (k.status <> 'rejected' OR ${HUMAN}) LIMIT 1`, [b.questionId]);
      if (busy) return 0;
      const have = new Set((await q<{ id: string }>(`SELECT line_id AS id FROM book_links WHERE question_id = $1`, [b.questionId])).map((r) => r.id));
      // FOR SHARE: a sync that retires one of these lines waits for this transaction (and then turns the new suggestions down), and one
      // that already retired it is waited for, so no suggestion lands on a line that is gone
      const live = new Set((await q<{ id: string }>(`SELECT id FROM book_lines WHERE book = $1 AND retired_at IS NULL AND id = ANY($2::uuid[]) FOR SHARE`, [book, b.proposals.map((p) => p.lineId)])).map((r) => r.id));
      const once = new Set<string>(); // one row per line, whatever the roles asked for
      let n = 0;
      for (const p of b.proposals) {
        if (!live.has(p.lineId) || have.has(p.lineId) || once.has(p.lineId)) continue;
        once.add(p.lineId);
        n += (await q(`INSERT INTO book_links (book, question_id, line_id, role, scope, score, method, status, rationale, question_type)
          VALUES ($1, $2, $3, $4, $5, $6, 'auto', 'suggested', $7, $8) ON CONFLICT DO NOTHING RETURNING id`,
        [book, b.questionId, p.lineId, p.role, p.scope ?? 'sentence', p.score ?? null, p.rationale ?? null, b.questionType ?? null])).length;
      }
      return n;
    });
    return c.json({ placed });
  }));

  app.post('/v1/books/:slug/import', (c) => run(c, 'author', async (book) => {
    const b = await parse(c, importSchema);
    // a restore keeps each link's original reviewer (§10.7); staff:/system: reviewers only from an act-for key or an administrator
    const caller = c.get('caller') as Caller | null | undefined;
    if (!caller?.actFor && !caller?.admin && b.links.some((l) => ACTOR_LIKE.test(l.reviewedBy ?? ''))) throw notActing();
    await db.begin(async (q) => {
      // an id that is another book's is refused, not skipped: the answer must not count records it did not write
      const elsewhere = async (table: 'book_lines' | 'book_links', ids: string[]) =>
        ids.length ? (await q<{ id: string }>(`SELECT id FROM ${table} WHERE id = ANY($1::uuid[]) AND book <> $2 LIMIT 1`, [ids, book]))[0]?.id : undefined;
      const lineClash = await elsewhere('book_lines', b.lines.map((l) => l.id));
      if (lineClash) throw new HighlightError(409, 'conflict', `line ${lineClash} belongs to another book`);
      const linkClash = await elsewhere('book_links', b.links.map((l) => l.id));
      if (linkClash) throw new HighlightError(409, 'conflict', `link ${linkClash} belongs to another book`);
      for (const part of chunks(b.lines)) {
        await q(`INSERT INTO book_lines (id, book, key, page_id, page_no, idx, block, kind, text, text_hash, chapter_no, chapter_title, section, rects, retired_at)
          SELECT x.id, $1, x.key, x."pageId", x."pageNo", x.idx, x.block, x.kind, x.text, x."textHash", x."chapterNo", x."chapterTitle", x.section, coalesce(x.rects, '[]'), x."retiredAt"
          FROM jsonb_to_recordset($2::text::jsonb) AS ${LINE_RECORDSET}
          ON CONFLICT (id) DO UPDATE SET key = EXCLUDED.key, page_id = EXCLUDED.page_id, page_no = EXCLUDED.page_no, idx = EXCLUDED.idx, block = EXCLUDED.block, kind = EXCLUDED.kind,
            text = EXCLUDED.text, text_hash = EXCLUDED.text_hash, chapter_no = EXCLUDED.chapter_no, chapter_title = EXCLUDED.chapter_title, section = EXCLUDED.section,
            rects = EXCLUDED.rects, retired_at = EXCLUDED.retired_at, updated_at = now()
          WHERE book_lines.book = $1`, [book, JSON.stringify(part)]);
      }
      for (const part of chunks(b.links)) {
        const bad = await q<{ id: string }>(`SELECT x."lineId" AS id FROM jsonb_to_recordset($2::text::jsonb) AS x("lineId" uuid)
          WHERE NOT EXISTS (SELECT 1 FROM book_lines l WHERE l.id = x."lineId" AND l.book = $1) LIMIT 1`, [book, JSON.stringify(part)]);
        if (bad.length) throw notFound(`line ${bad[0]!.id} is not in this book`);
        await q(`INSERT INTO book_links (id, book, question_id, line_id, role, scope, method, status, score, rationale, question_type, reviewed_by, reviewed_at, created_at)
          SELECT x.id, $1, x."questionId", x."lineId", x.role, x.scope, x.method, x.status, x.score, x.rationale, x."questionType", x."reviewedBy", x."reviewedAt", coalesce(x."createdAt", now())
          FROM jsonb_to_recordset($2::text::jsonb) AS x(id uuid, "questionId" uuid, "lineId" uuid, role text, scope text, method text, status text, score real, rationale text,
            "questionType" text, "reviewedBy" text, "reviewedAt" timestamptz, "createdAt" timestamptz)
          ON CONFLICT (id) DO UPDATE SET question_id = EXCLUDED.question_id, line_id = EXCLUDED.line_id, role = EXCLUDED.role, scope = EXCLUDED.scope, method = EXCLUDED.method,
            status = EXCLUDED.status, score = EXCLUDED.score, rationale = EXCLUDED.rationale, question_type = EXCLUDED.question_type, reviewed_by = EXCLUDED.reviewed_by,
            reviewed_at = EXCLUDED.reviewed_at, created_at = EXCLUDED.created_at
          WHERE book_links.book = $1`, [book, JSON.stringify(part)]);
      }
    });
    return c.json({ lines: b.lines.length, links: b.links.length });
  }));
}

/** A question's live links on live lines of the book, in book order (what `GET links?question=` and `PUT questions/…/lines` answer). */
function linksOfQuestion(q: Query, book: string, questionId: string) {
  return q(`SELECT ${LINK_COLS} ${LINKS_FROM} WHERE k.book = $1 AND k.question_id = $2 AND k.status <> 'rejected' AND l.retired_at IS NULL ORDER BY l.page_no, l.idx, k.role`, [book, questionId]);
}
