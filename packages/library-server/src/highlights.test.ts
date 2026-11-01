import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLibraryApp, diskStorage, openDb, planLines, tokenCallers, type Db } from './index.js';

const BASE = 'http://library.test';
const BOOK = 'physics-9-10-bn';
const Q1 = '11111111-1111-4111-8111-111111111111';
const Q2 = '22222222-2222-4222-8222-222222222222';

type Line = { key: string; pageId: string; pageNo: number; idx: number; block: number; kind: string; text: string; textHash: string; chapterNo: number; chapterTitle: string; section: null; rects: { x: number; y: number; w: number; fs: number }[] };
const line = (pageNo: number, idx: number, block = 0, text = `line ${pageNo}.${idx}`): Line => ({
  key: `p${pageNo}/${idx}/0`, pageId: `p${pageNo}`, pageNo, idx, block, kind: 'body', text, textHash: `h${pageNo}.${idx}`, chapterNo: 1, chapterTitle: 'Physical quantities', section: null,
  rects: [{ x: 100, y: 100 + idx * 30, w: 500, fs: 18 }],
});

describe('book highlights (registry-api §11)', () => {
  let db: Db, app: ReturnType<typeof createLibraryApp>;
  const call = async (method: string, path: string, body?: unknown, token = 'author-t') => {
    const res = await app.fetch(new Request(`${BASE}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- answers of many shapes, checked by the assertions
    const answer = (await res.json()) as any;
    return { status: res.status, body: answer };
  };
  const b = (p: string) => `/v1/books/${BOOK}${p}`;
  const ids = async () => Object.fromEntries(((await call('GET', b('/lines/all?retired=1'))).body.items as { id: string; key: string }[]).map((l) => [l.key, l.id]));

  beforeAll(async () => { db = await openDb('pglite:'); }, 60_000);
  afterAll(async () => { await db.close(); });
  beforeEach(async () => {
    await db.query('DELETE FROM book_links'); await db.query('DELETE FROM book_lines');
    app = createLibraryApp({ db, storage: diskStorage(mkdtempSync(join(tmpdir(), 'chalk-hl-')), { uploadBase: BASE }), publicUrl: `${BASE}/files/`, callers: tokenCallers('author:author-t'), publicRead: false });
    await call('POST', b('/lines/sync'), { lines: [line(6, 0), line(6, 1), line(6, 2, 1), line(7, 0)] });
  });

  it('reads need a token on a private library, writes need author', async () => {
    expect((await call('GET', b('/lines?pages=6'), undefined, '')).status).toBe(401);
    expect((await call('POST', b('/lines/sync'), { lines: [] }, '')).status).toBe(401);
    expect((await call('GET', '/v1/books/-bad/lines?pages=6')).status).toBe(400);
  });

  it('sync adds, changes, retires and revives lines by key; a re-run changes nothing', async () => {
    const again = await call('POST', b('/lines/sync'), { lines: [line(6, 0), line(6, 1), line(6, 2, 1), line(7, 0)] });
    expect(again.body).toEqual({ added: 0, changed: 0, retired: 0, revived: 0, linksRetired: 0 });
    const moved = { ...line(6, 1), idx: 5 };
    const r = await call('POST', b('/lines/sync'), { lines: [line(6, 0), moved, line(8, 0)] });
    expect(r.body).toMatchObject({ added: 1, changed: 1, retired: 2, revived: 0 });
    const back = await call('POST', b('/lines/sync'), { lines: [line(6, 0), moved, line(8, 0), line(7, 0)] });
    expect(back.body).toMatchObject({ added: 0, revived: 1, retired: 0 });
  });

  it('planLines matches the dashboard\'s plan: no change, a moved line, a missing one', () => {
    const stored = [{ id: 'a', key: 'p6/0/0', retiredAt: null, pageNo: 6, idx: 0, block: 0, kind: 'body', chapterNo: 1, chapterTitle: 'Physical quantities', section: null, rects: line(6, 0).rects }];
    expect(planLines(stored, [line(6, 0)])).toMatchObject({ write: [], retire: [] });
    expect(planLines(stored, [])).toMatchObject({ retire: ['p6/0/0'] });
  });

  it('a person tags a line: confirmed and theirs; the page shows counts by kind; a reader may ask for linked lines only', async () => {
    const L = await ids();
    const add = await call('POST', b('/links'), { questionId: Q1, lineId: L['p6/0/0'], questionType: 'mcq', by: 'rafi' });
    expect(add.status).toBe(201);
    expect(add.body).toMatchObject({ questionId: Q1, method: 'human', status: 'confirmed', reviewedBy: 'rafi', questionType: 'mcq', line: { key: 'p6/0/0', pageNo: 6 } });
    const page = (await call('GET', b('/lines?pages=6,7'))).body.pages;
    expect(page['6']).toHaveLength(3);
    expect(page['6'][0]).toMatchObject({ id: L['p6/0/0'], links: 1, suggested: 0, typeCounts: { mcq: { confirmed: 1, suggested: 0 } } });
    expect(page['6'][0].textHash).toBeUndefined();
    expect((await call('GET', b('/lines?pages=6&linked=1'))).body.pages['6']).toHaveLength(1);
    expect((await call('GET', b('/pages/counts'))).body.counts).toEqual({ '6': 1 });
    expect((await call('GET', b('/chapters'))).body.items).toEqual([{ no: 1, title: 'Physical quantities' }]);
  });

  it('taking a link off keeps it as a rejected row the readers never see', async () => {
    const L = await ids();
    const add = await call('POST', b('/links'), { questionId: Q1, lineId: L['p6/0/0'], by: 'rafi' });
    expect((await call('DELETE', b(`/links/${add.body.id}`), { by: 'rafi' })).body).toEqual({ removed: 1 });
    expect((await call('GET', b(`/links?line=${L['p6/0/0']}`))).body.items).toEqual([]);
    expect((await call('GET', b('/lines?pages=6'))).body.pages['6'][0].links).toBe(0);
    const all = (await call('GET', b('/links/all?rejected=1'))).body.items;
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ status: 'rejected', method: 'human' });
    // the matcher may not place a question a person took a tag off
    expect((await call('POST', b('/links/place'), { questionId: Q1, proposals: [{ lineId: L['p6/1/0'], role: 'answers_from' }] })).body).toEqual({ placed: 0 });
  });

  it('the matcher places a question only while it is in the pool; one row per line; retired lines skipped', async () => {
    const L = await ids();
    const place = await call('POST', b('/links/place'), { questionId: Q2, questionType: 'cq', proposals: [
      { lineId: L['p6/0/0'], role: 'answers_from', score: 0.9, rationale: 'same words' }, { lineId: L['p6/0/0'], role: 'tests_concept' }, { lineId: L['p6/1/0'], role: 'answers_from', score: 0.5 }] });
    expect(place.body).toEqual({ placed: 2 });
    expect((await call('POST', b('/links/place'), { questionId: Q2, proposals: [{ lineId: L['p7/0/0'], role: 'answers_from' }] })).body).toEqual({ placed: 0 });
    const q = (await call('POST', '/v1/highlights/questions', { questionIds: [Q1, Q2] })).body.items;
    expect(q).toEqual({ [Q1]: { live: 0, human: false, any: false }, [Q2]: { live: 2, human: false, any: true } });
    expect((await call('GET', '/v1/highlights/tagged')).body.questionIds).toEqual([Q2]);
    // confirmed first, then by score
    const on = (await call('GET', b(`/links?line=${L['p6/0/0']}&paragraph=1`))).body.items;
    expect(on.map((l: { line: { key: string } }) => l.line.key)).toEqual(['p6/0/0', 'p6/1/0'].slice(0, on.length));
  });

  it('a re-index retires the matcher\'s links on lines that went, and keeps a person\'s (listed as orphaned)', async () => {
    const L = await ids();
    await call('POST', b('/links/place'), { questionId: Q2, proposals: [{ lineId: L['p7/0/0'], role: 'answers_from' }] });
    await call('POST', b('/links'), { questionId: Q1, lineId: L['p7/0/0'], by: 'rafi' });
    const r = await call('POST', b('/lines/sync'), { lines: [line(6, 0), line(6, 1), line(6, 2, 1)] });
    expect(r.body).toMatchObject({ retired: 1, linksRetired: 1 });
    const orphaned = (await call('GET', b('/links/orphaned'))).body.items;
    expect(orphaned).toHaveLength(1);
    expect(orphaned[0]).toMatchObject({ questionId: Q1, line: { key: 'p7/0/0' } });
    expect(orphaned[0].line.retiredAt).not.toBeNull();
    expect((await call('POST', b('/links'), { questionId: Q1, lineId: L['p7/0/0'], by: 'rafi' })).status).toBe(409);
  });

  it('moving a link onto a pair the question already has merges into it', async () => {
    const L = await ids();
    const a = await call('POST', b('/links'), { questionId: Q1, lineId: L['p6/0/0'], by: 'rafi' });
    const other = await call('POST', b('/links'), { questionId: Q1, lineId: L['p6/1/0'], by: 'rafi' });
    const moved = await call('PATCH', b(`/links/${a.body.id}`), { lineId: L['p6/1/0'], by: 'mim' });
    expect(moved.body).toMatchObject({ id: other.body.id, status: 'confirmed', reviewedBy: 'mim' });
    expect((await call('GET', b('/links/all?rejected=1'))).body.items).toHaveLength(1);
    const role = await call('PATCH', b(`/links/${other.body.id}`), { role: 'formula_source', by: 'mim' });
    expect(role.body).toMatchObject({ role: 'formula_source', method: 'human' });
    expect((await call('PATCH', b('/links/33333333-3333-4333-8333-333333333333'), { by: 'mim' })).status).toBe(404);
  });

  it('moves and takes off every link of a line (or its paragraph)', async () => {
    const L = await ids();
    await call('POST', b('/links/place'), { questionId: Q2, proposals: [{ lineId: L['p6/0/0'], role: 'answers_from' }] });
    await call('POST', b('/links'), { questionId: Q1, lineId: L['p6/0/0'], by: 'rafi' });
    await call('POST', b('/links'), { questionId: Q1, lineId: L['p6/2/0'], by: 'rafi' });
    expect((await call('POST', b(`/lines/${L['p6/0/0']}/links/move`), { to: L['p6/2/0'], by: 'mim' })).body).toEqual({ moved: 1 });
    const at = (await call('GET', b(`/links?line=${L['p6/2/0']}`))).body.items;
    expect(at.map((l: { questionId: string }) => l.questionId).sort()).toEqual([Q1, Q2]);
    // p6/0 and p6/1 are one paragraph (block 0); p6/2 is another
    expect((await call('POST', b(`/lines/${L['p6/1/0']}/links/remove`), { paragraph: true, by: 'mim' })).body).toEqual({ removed: 0 });
    expect((await call('POST', b(`/lines/${L['p6/2/0']}/links/remove`), { by: 'mim' })).body).toEqual({ removed: 2 });
  });

  it('a question\'s highlight grows, shrinks and moves; a line taken off is remembered', async () => {
    const L = await ids();
    await call('POST', b('/links/place'), { questionId: Q1, proposals: [{ lineId: L['p6/0/0'], role: 'answers_from' }, { lineId: L['p6/1/0'], role: 'answers_from' }] });
    const r = await call('PUT', b(`/questions/${Q1}/lines`), { role: 'answers_from', add: [L['p6/2/0']], remove: [L['p6/0/0'], L['p7/0/0']], questionType: 'mcq', by: 'rafi' });
    expect(r.status).toBe(200);
    expect(r.body.items.map((l: { line: { key: string } }) => l.line.key)).toEqual(['p6/1/0', 'p6/2/0']);
    expect(r.body.items.every((l: { method: string; status: string }) => l.method === 'human' && l.status === 'confirmed')).toBe(true);
    const rejected = (await call('GET', b('/links/all?rejected=1'))).body.items.filter((l: { status: string }) => l.status === 'rejected');
    expect(rejected.map((l: { line: { key: string } }) => l.line.key).sort()).toEqual(['p6/0/0', 'p7/0/0']);
    expect((await call('GET', b(`/links?question=${Q1}`))).body.items).toHaveLength(2);
    expect((await call('PUT', b(`/questions/${Q1}/lines`), { role: 'answers_from', add: [], remove: [], by: 'rafi' })).status).toBe(400);
    expect((await call('PUT', b(`/questions/${Q1}/lines`), { role: 'answers_from', add: [L['p6/0/0']], remove: [L['p6/0/0']], by: 'rafi' })).status).toBe(400);
  });

  it('review lists links in book order with a total', async () => {
    const L = await ids();
    await call('POST', b('/links/place'), { questionId: Q2, proposals: [{ lineId: L['p7/0/0'], role: 'answers_from' }, { lineId: L['p6/0/0'], role: 'answers_from' }] });
    const r = (await call('GET', b('/links?status=suggested&limit=1'))).body;
    expect(r.total).toBe(2);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].line.key).toBe('p6/0/0');
  });

  it('import copies lines and links with their ids', async () => {
    const lineId = '44444444-4444-4444-8444-444444444444', linkId = '55555555-5555-4555-8555-555555555555';
    const r = await call('POST', '/v1/books/other-book/import', {
      lines: [{ ...line(3, 0), id: lineId, retiredAt: null }],
      links: [{ id: linkId, questionId: Q1, lineId, role: 'answers_from', scope: 'sentence', method: 'auto', status: 'suggested', score: 0.7, rationale: 'x', questionType: 'mcq', reviewedBy: null, reviewedAt: null, createdAt: '2026-10-30T00:00:00Z' }],
    });
    expect(r.body).toEqual({ lines: 1, links: 1 });
    const got = (await call('GET', `/v1/books/other-book/links?line=${lineId}`)).body.items;
    expect(got[0]).toMatchObject({ id: linkId, score: 0.7, questionType: 'mcq' });
    expect((await call('POST', '/v1/books/other-book/import', { lines: [], links: [{ id: linkId, questionId: Q1, lineId: '66666666-6666-4666-8666-666666666666', role: 'answers_from', scope: 'sentence', method: 'auto', status: 'suggested' }] })).status).toBe(404);
  });
});
