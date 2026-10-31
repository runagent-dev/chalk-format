// A corrected question reaches readers without the links item or the book being published again (spec 1.8 §3.4, "Current version by id").
// Publishes a tiny book whose links item names a question by `questionId`, opens it with the loader, publishes a NEW version of the
// question (same `question:<uuid>` tag, `state:current`; the old one `state:superseded`) and shows that `resolveQuestions` / `loadQuestion`
// now give the new version while the book item and the links item are the same keys as before.
//
//   npx tsx tools/question-current-e2e.ts <library-url> <write-token> [--read-token <t>]
//
// Writes into the library: use a test library, never a production one.
import { assetKeyAndSha256, QUESTION_MANIFEST_TYPE } from '../packages/model/src/index.ts';
import {
  LIBRARY_BOOK_TYPE, LIBRARY_LINKS_TYPE, LIBRARY_PAGE_TYPE, bookTags, createRegistryClient, libraryBookSchema, loadBookLinks, loadQuestion, openLibraryBook, resolveQuestions, withBookState,
} from '../packages/store/src/index.ts';

const args = process.argv.slice(2);
const opt = (n: string) => { const i = args.indexOf(n); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
const READ_TOKEN = opt('--read-token');
const [LIBRARY, WRITE_TOKEN] = args;
if (!LIBRARY || !WRITE_TOKEN) { console.error('usage: question-current-e2e.ts <library-url> <write-token> [--read-token <t>]'); process.exit(2); }
let failed = false;
const check = (name: string, ok: boolean, detail = '') => { if (!ok) failed = true; console.log(ok ? 'ok  ' : 'FAIL', name, detail); };

const w = createRegistryClient(LIBRARY, { token: WRITE_TOKEN });
const enc = (x: unknown) => new TextEncoder().encode(JSON.stringify(x));
const run = Math.random().toString(36).slice(2, 8), slug = `qcur-${run}`, qid = crypto.randomUUID();
const register = async (bytes: Uint8Array, type: string, tags: string[], title: string) => {
  const { key, sha256 } = await assetKeyAndSha256(bytes);
  const rec = await w.add(bytes, { type, tags, title });
  // `add` of bytes the library has does not register: register again to set the tags
  await fetch(new URL('v1/assets', LIBRARY), { method: 'POST', headers: { Authorization: `Bearer ${WRITE_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ key, sha256, type, size: bytes.byteLength, tags, title }) });
  return { ...rec, key, sha256, size: bytes.byteLength, type, tags, title };
};
const question = (stem: string) => ({ format: 'chalk.question', manifestVersion: 1, id: `q-${run}`, version: '1', kind: 'short_answer', stem });

// ---- publish: one question, a page, a links item that names the question by id, the book item ----
const q1 = await register(enc(question(`first version ${run}`)), QUESTION_MANIFEST_TYPE, ['origin:chalkbook', 'kind:question', `question:${qid}`, 'state:current'], 'question v1');
const t = (kind: 'book' | 'page' | 'links') => bookTags({ slug, revision: 1, kind, state: 'current' });
const page = await register(enc({ id: 'p1', title: 'One', width: 800, height: 600, objects: [] }), LIBRARY_PAGE_TYPE, t('page'), 'page');
const links = await register(enc({
  format: 'chalk-links', version: 1, book: slug, bookRevision: 1,
  sentences: [{ id: 's1', page: 1, pageId: 'p1', rects: [], text: 'a sentence' }],
  links: [{ sentence: 's1', question: q1.key, questionId: qid, role: 'answers_from' }],
}), LIBRARY_LINKS_TYPE, t('links'), 'links');
// a book names no store that needs a token (1.2 §4.4): the same delivery store without its `auth`
const { auth: _auth, ...store } = (await w.stores()).items[0]!;
const book = await register(enc(libraryBookSchema.parse({
  format: 'chalk.streamed', streamVersion: 1, formatVersion: 11, id: slug, title: 'Question current e2e', locale: 'en', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  pages: [{ id: 'p1', key: page.key }], assets: [], links: links.key, assetSources: [store],
})), LIBRARY_BOOK_TYPE, t('book'), 'book');

const open = () => openLibraryBook({ library: LIBRARY, slug, ...(READ_TOKEN ? { token: READ_TOKEN } : {}) });
const b1 = await open();
await loadBookLinks(b1);
check('the book opens; links item found by tag', b1.key === book.key && b1.links === links.key);
const before = await resolveQuestions(b1, [qid]);
check('before: the first version', before.resolved.get(qid)?.key === q1.key && before.resolved.get(qid)?.manifest.stem === `first version ${run}`, before.resolved.get(qid)?.source);

// ---- a NEW version of the question; the links item and the book are not touched ----
await new Promise((r) => setTimeout(r, 20));
const q2 = await register(enc(question(`second version ${run}`)), QUESTION_MANIFEST_TYPE, ['origin:chalkbook', 'kind:question', `question:${qid}`, 'state:current'], 'question v2');
await register(enc(question(`first version ${run}`)), QUESTION_MANIFEST_TYPE, withBookState(q1.tags, 'superseded'), 'question v1');
check('the question has a new key', q2.key !== q1.key);

const b2 = await open();
const links2 = await loadBookLinks(b2);
check('the book item and the links item are the same keys as before', b2.key === book.key && b2.links === links.key && links2!.links[0]!.question === q1.key);
const after = await resolveQuestions(b2, [qid]);
const got = after.resolved.get(qid);
check('after: resolveQuestions returns the NEW version', got?.key === q2.key && got.manifest.stem === `second version ${run}` && got.source === 'current', `${got?.key} ${got?.source}`);
check('loadQuestion by the link\'s old key returns the new version', (await loadQuestion(b2, q1.key)).stem === `second version ${run}`);
// the opened book b1 still resolves by asking again (the answer is not cached: a correction shows at once)
check('an already opened book sees it too', (await resolveQuestions(b1, [qid])).resolved.get(qid)?.key === q2.key);
process.exit(failed ? 1 : 0);
