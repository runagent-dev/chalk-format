import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkLibrary, createLibraryApp, diskStorage, openDb, scanStorage, tokenCallers, type Db } from './index.js';

// a whole library in this process: PGlite for Postgres, a temporary folder for the bucket, and a fetch that
// sends http://library.test/… to the app (uploads, the API and the delivery store all go through it)
const BASE = 'http://library.test';
let db: Db, dir: string, app: ReturnType<typeof createLibraryApp>;
const fetchApp = (async (input: RequestInfo | URL, init?: RequestInit) => app.fetch(new Request(input, init))) as typeof fetch;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'chalk-library-'));
  db = await openDb('pglite:');
  app = createLibraryApp({ db, storage: diskStorage(dir, { uploadBase: BASE }), publicUrl: `${BASE}/files/`, callers: tokenCallers('teacher:t-1,admin!:a-1') });
});
afterAll(async () => { await db.close(); rmSync(dir, { recursive: true, force: true }); });

describe('the reference library (disk + PGlite)', () => {
  it('passes the conformance checks of the registry API', async () => {
    const results = await checkLibrary(BASE, { token: 't-1', adminToken: 'a-1', fetch: fetchApp });
    const failed = results.filter((r) => !r.ok);
    expect(failed, JSON.stringify(failed, null, 1)).toEqual([]);
    expect(results.length).toBeGreaterThanOrEqual(15);
  });

  it('delivers files cacheable for ever, with ranges for video, never as a web page', async () => {
    const { registryLibrary } = await import('@chalk-format/store');
    const lib = registryLibrary({ url: BASE, token: 't-1', fetch: fetchApp });
    const item = await lib.put!({ bytes: new TextEncoder().encode('<!doctype html><p>a lab</p>'), type: 'text/html', title: 'lab' });
    const url = (await lib.url(item.key))!;
    const r = await fetchApp(url);
    expect(r.headers.get('cache-control')).toContain('immutable');
    expect(r.headers.get('content-type')).toBe('application/octet-stream');
    expect(r.headers.get('content-security-policy')).toBe('sandbox');
    const part = await fetchApp(url, { headers: { Range: 'bytes=2-8' } });
    expect(part.status).toBe(206);
    expect(await part.text()).toBe('doctype');
  });

  it('refuses types it does not take, and sizes over the limit', async () => {
    const post = (b: object) => fetchApp(`${BASE}/v1/uploads`, { method: 'POST', headers: { Authorization: 'Bearer t-1', 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    const { assetKeyAndSha256 } = await import('@chalk-format/model');
    const k = await assetKeyAndSha256(new TextEncoder().encode('x'));
    expect((await post({ ...k, type: 'application/x-msdownload', size: 1 })).status).toBe(415);
    expect((await post({ ...k, type: 'video/mp4', size: 10 * 1024 * 1024 * 1024 })).status).toBe(413);
  });

  it('keeps question manifests: found by their tags, their type and their code, and delivered as they were published', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { createRegistryClient } = await import('@chalk-format/store');
    const { QUESTION_MANIFEST_TYPE, questionManifestSchema, questionRegistryTags } = await import('@chalk-format/model');
    const examples = new URL('../../../examples/questions/', import.meta.url);
    const client = createRegistryClient(BASE, { token: 't-1', fetch: fetchApp });
    const published: Record<string, string> = {};
    for (const f of readdirSync(examples).filter((x) => x.endsWith('.question.json'))) {
      const bytes = new Uint8Array(readFileSync(new URL(f, examples)));
      const m = questionManifestSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
      const rec = await client.add(bytes, { type: QUESTION_MANIFEST_TYPE, filename: f, title: m.code ?? m.id, tags: questionRegistryTags(m), ...(m.subject ? { subject: m.subject } : {}) });
      published[m.kind] = rec.key;
    }
    const keys = async (q: Parameters<typeof client.search>[0]) => (await client.search(q)).items.map((i) => i.key).sort();
    expect(await keys({ type: [QUESTION_MANIFEST_TYPE] })).toEqual(Object.values(published).sort());
    expect(await keys({ tag: ['kind:question'] })).toEqual(Object.values(published).sort());
    expect(await keys({ tag: ['question-kind:cq'] })).toEqual([published.cq]);
    expect(await keys({ tag: ['kind:question', 'question-kind:numeric'] })).toEqual([published.numeric]);
    // a code is looked up by its tag (free text splits EX-2-M1 into words, and would find all three)
    expect(await keys({ tag: ['code:EX-2-M1'] })).toEqual([published.mcq]);
    expect(await keys({ tag: ['code:EX-9-X9'] })).toEqual([]);
    // what comes back is what went in, and it is not served as a web page
    const { registryLibrary } = await import('@chalk-format/store');
    const url = (await registryLibrary({ url: BASE, token: 't-1', fetch: fetchApp }).url(published.mcq!))!;
    const got = await fetchApp(url);
    expect(questionManifestSchema.parse(await got.json()).code).toBe('EX-2-M1');
    expect(got.headers.get('content-security-policy')).toBe('sandbox');
  });

  it('a private library: reading needs a token too', async () => {
    const priv = createLibraryApp({ db, storage: diskStorage(dir, { uploadBase: BASE }), publicUrl: `${BASE}/files/`, callers: tokenCallers('teacher:t-1'), publicRead: false });
    expect((await priv.fetch(new Request(`${BASE}/v1/search?q=x`))).status).toBe(401);
    expect((await priv.fetch(new Request(`${BASE}/v1/search?q=x`, { headers: { Authorization: 'Bearer t-1' } }))).status).toBe(200);
    // readers' list of stores stays public: books must be readable
    expect((await priv.fetch(new Request(`${BASE}/v1/stores`))).status).toBe(200);
  });

  it('scans a bucket that already has media: adopted once, found by its file name', async () => {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'old', 'class9'), { recursive: true });
    writeFileSync(join(dir, 'old', 'class9', 'free-fall.mp4'), 'pretend video');
    writeFileSync(join(dir, 'old', 'notes.txt'), 'not media');
    const store = diskStorage(dir, { uploadBase: BASE });
    expect(await scanStorage(db, store, { prefix: 'old/' })).toEqual({ found: 1, added: 1 });
    expect(await scanStorage(db, store, { prefix: 'old/' })).toEqual({ found: 1, added: 0 });
    const r = await (await fetchApp(`${BASE}/v1/search?q=free%20fall`)).json() as { items: { filename: string; type: string }[] };
    expect(r.items[0]).toMatchObject({ filename: 'free-fall.mp4', type: 'video/mp4' });
  });
});
