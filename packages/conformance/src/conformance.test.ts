import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { assembleStreamed, parseStreamIndex, unpackLesson, unpackOverlay, validateLessonPackage } from '@chalk-format/container';

const ROOT = new URL('../../../conformance/', import.meta.url);
type Case = { file: string; kind: 'lesson' | 'overlay'; valid: boolean; covers: string };
const cases = JSON.parse(readFileSync(new URL('cases.json', ROOT), 'utf8')) as Case[];
const bytes = (file: string) => new Uint8Array(readFileSync(new URL(file, ROOT)));

// The JSON Schemas are what non-TypeScript readers use, so every valid fixture must pass them
// independently of the Zod model — that is what keeps schema/ honest.
const schema = (name: string) => JSON.parse(readFileSync(new URL(`../../../schema/${name}`, import.meta.url), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
const validLesson = ajv.compile(schema('lesson.schema.json'));
const validOverlay = ajv.compile(schema('overlay.schema.json'));

describe('conformance corpus', () => {
  it('has both valid and invalid cases', () => {
    expect(cases.some((c) => c.valid)).toBe(true);
    expect(cases.some((c) => !c.valid)).toBe(true);
  });

  for (const c of cases.filter((x) => x.valid && x.kind === 'lesson')) {
    it(`accepts ${c.file} — ${c.covers}`, async () => {
      expect((await validateLessonPackage(bytes(c.file))).issues).toEqual([]);
      const { lesson } = await unpackLesson(bytes(c.file));
      const ok = validLesson(JSON.parse(JSON.stringify(lesson)));
      expect(validLesson.errors ?? []).toEqual([]);
      expect(ok).toBe(true);
    });
  }

  for (const c of cases.filter((x) => x.valid && x.kind === 'overlay')) {
    it(`accepts ${c.file} — ${c.covers}`, async () => {
      const { overlay } = await unpackOverlay(bytes(c.file));
      expect(validOverlay(JSON.parse(JSON.stringify(overlay)))).toBe(true);
    });
  }

  for (const c of cases.filter((x) => !x.valid)) {
    it(`rejects ${c.file} — ${c.covers}`, async () => {
      const result = await validateLessonPackage(bytes(c.file));
      expect(result.ok).toBe(false);
      // A reader may open a package with missing asset bytes in degraded form, but must say so.
      const opened = await unpackLesson(bytes(c.file)).catch(() => null);
      if (opened) expect(opened.missingAssetIds.length).toBeGreaterThan(0);
    });
  }
});

describe('JSON Schema rejects what the model rejects', () => {
  const validPage = ajv.compile(schema('page.schema.json'));
  const base = { id: 'p', title: 'p', background: { type: 'blank' }, objects: [] as unknown[] };
  it('accepts a minimal page', () => expect(validPage(base)).toBe(true));
  it('rejects an unknown object type', () =>
    expect(validPage({ ...base, objects: [{ id: 'q', type: 'quiz', x: 0, y: 0 }] })).toBe(false));
  it('rejects an object missing a required field', () =>
    expect(validPage({ ...base, objects: [{ id: 'r', type: 'rect', x: 0, y: 0 }] })).toBe(false));
  it('rejects an unknown background type', () =>
    expect(validPage({ ...base, background: { type: 'video' } })).toBe(false));
});

// ---- 1.2: keys and stores ----
describe('asset keys (spec 1.2 §3)', () => {
  // an implementation independent of @chalk-format/model: node's crypto and a plain base32
  const b32 = (b: Uint8Array) => { let bits = ''; for (const x of b) bits += x.toString(2).padStart(8, '0'); bits = bits.padEnd(Math.ceil(bits.length / 5) * 5, '0');
    return bits.match(/.{5}/g)!.map((c) => 'abcdefghijklmnopqrstuvwxyz234567'[parseInt(c, 2)]).join(''); };
  const V = JSON.parse(readFileSync(new URL('keys.json', ROOT), 'utf8')) as { vectors: { base64: string; sha256: string; key: string; name: string }[] };
  for (const v of V.vectors) it(`vector: ${v.name}`, () => {
    const d = createHash('sha256').update(Buffer.from(v.base64, 'base64')).digest();
    expect(d.toString('hex')).toBe(v.sha256);
    expect('c1:' + b32(d.subarray(0, 16))).toBe(v.key);
  });
});

describe('store examples (spec 1.2 §5)', () => {
  const store = ajv.compile(schema('store.schema.json')), shard = ajv.compile(schema('index-shard.schema.json'));
  for (const f of readdirSync(new URL('stores/', ROOT))) it(`${f} is valid`, () => {
    const doc = JSON.parse(readFileSync(new URL(`stores/${f}`, ROOT), 'utf8'));
    const v = f.startsWith('index-') ? shard : store;
    expect(v(doc), JSON.stringify(v.errors)).toBe(true);
  });
  it('rejects a derived store without a template, and a base without a trailing slash', () => {
    expect(store({ id: 'x', kind: 'derived' })).toBe(false);
    expect(store({ id: 'x', kind: 'api', base: 'https://x.example' })).toBe(false);
  });
  it('reads a thin book\'s facts and suggested stores', async () => {
    const r = await unpackLesson(bytes('valid/thin-sources.chalk'));
    expect(r.assetSources.map((d) => d.id)).toEqual(['publisher-cdn', 'publisher-archive']);
    const video = [...r.assetInfo.entries()].find(([, i]) => i.renditions?.length);
    expect(video?.[1]).toMatchObject({ size: 18_400_211, meta: { width: 1280, duration: 94.5 } });
    expect(r.missingAssetIds).toEqual([video![0]]);
  });
});

// ---- 1.4: streamed books ----
describe('a streamed book (spec 1.4 §8)', () => {
  const dir = new URL('streamed/presentation/', ROOT);
  const read = async (p: string) => new Uint8Array(readFileSync(new URL(p, dir)));
  it('has an index valid against schema/stream-index.schema.json', () => {
    const v = ajv.compile(schema('stream-index.schema.json'));
    const index = JSON.parse(readFileSync(new URL('book.json', dir), 'utf8'));
    expect(v(index), JSON.stringify(v.errors)).toBe(true);
    expect(v({ ...index, pages: [{ id: 'x', file: '../x.json' }] })).toBe(false);
  });
  it('is the same book as valid/presentation.chalk', async () => {
    const a = await unpackLesson(bytes('valid/presentation.chalk'));
    const b = await assembleStreamed(read);
    expect(b.lesson).toEqual(a.lesson);
    expect([...b.assets.keys()].sort()).toEqual([...a.assets.keys()].sort());
  });
  it('has a search file valid against schema/stream-text.schema.json', () => {
    const index = parseStreamIndex(JSON.parse(readFileSync(new URL('book.json', dir), 'utf8')));
    if (!index.text) return;
    const v = ajv.compile(schema('stream-text.schema.json'));
    expect(v(JSON.parse(readFileSync(new URL(index.text.file, dir), 'utf8'))), JSON.stringify(v.errors)).toBe(true);
  });
});
