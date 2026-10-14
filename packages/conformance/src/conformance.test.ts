import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { unpackLesson, unpackOverlay, validateLessonPackage } from '@chalk-format/container';

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
