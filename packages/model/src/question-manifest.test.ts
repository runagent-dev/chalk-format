import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  QUESTION_MANIFEST_TYPE, checkQuestion, questionAssetKeys, questionManifestSchema, questionRegistryTags, questionStem, type QuestionManifest,
} from './question-manifest.js';

const dir = new URL('../../../examples/questions/', import.meta.url);
const examples = readdirSync(dir).filter((f) => f.endsWith('.question.json'));
const load = (f: string) => questionManifestSchema.parse(JSON.parse(readFileSync(new URL(f, dir), 'utf8')));
const KEY = 'c1:aaaaaaaaaaaaaaaaaaaaaaaaay';
const base = (over: Record<string, unknown> = {}): QuestionManifest => questionManifestSchema.parse({ format: 'chalk.question', manifestVersion: 1, id: 'q', version: '1', kind: 'short_answer', stem: 'Q?', ...over });
const mcq = (correct: number[], labels = ['a', 'b', 'c']) => base({ kind: 'mcq', options: labels.map((label, i) => ({ label, text: label, ...(correct.includes(i) ? { correct: true } : {}) })) });

describe('question manifests (spec 1.7)', () => {
  it('has its own media type', () => {
    expect(QUESTION_MANIFEST_TYPE).toBe('application/vnd.chalk.question+json');
  });

  it('accepts the examples, and they pass the structural checks', () => {
    expect(examples.length).toBeGreaterThanOrEqual(3);
    for (const f of examples) expect(checkQuestion(load(f)), f).toEqual([]);
  });

  it('refuses what is not a question manifest', () => {
    for (const bad of [{ format: 'chalk.lab' }, { manifestVersion: 2 }, { stem: undefined }, { id: '' }, { kind: '' }, { code: 'has space' }, { difficulty: 6 }, { assets: ['not-a-key'] }, { classes: 'ten' }]) {
      expect(questionManifestSchema.safeParse({ format: 'chalk.question', manifestVersion: 1, id: 'q', version: '1', kind: 'mcq', stem: 'Q', ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('keeps fields it does not know (writers may add more)', () => {
    const m = questionManifestSchema.parse({ format: 'chalk.question', manifestVersion: 1, id: 'q', version: '1', kind: 'mcq', stem: 'Q', 'x-future': { a: 1 } });
    expect((m as Record<string, unknown>)['x-future']).toEqual({ a: 1 });
  });

  it('reads text in one language or many', () => {
    expect(questionStem(base({ stem: 'Hello' }), 'bn')).toBe('Hello');
    expect(questionStem(base({ stem: { bn: 'হ্যালো', en: 'Hello' } }), 'bn')).toBe('হ্যালো');
    expect(questionStem(base({ stem: { en: 'Hello' } }), 'bn')).toBe('Hello');
  });

  describe('provenance (§2.1)', () => {
    const board = { kind: 'board_exam', code: 'DHA', name: 'ঢাকা বোর্ড', year: 2023 };
    const school = { kind: 'institution_exam', code: 'VNSC', name: { bn: 'ভিকারুননিসা নূন স্কুল এন্ড কলেজ, ঢাকা', en: 'Viqarunnisa Noon School & College, Dhaka' }, year: null };
    it('accepts board and school papers, a year or null, a name in one language or many', () => {
      const m = base({ provenance: [board, school] });
      expect(m.provenance).toEqual([board, school]);
      expect(checkQuestion(m)).toEqual([]);
      expect(questionManifestSchema.safeParse({ ...m, provenance: [{ kind: 'board_exam', code: 'RAJ', name: 'রাজশাহী বোর্ড' }] }).success).toBe(true); // no year: not known
    });
    it('accepts a kind it does not know (readers show its code)', () => {
      expect(questionManifestSchema.safeParse({ ...base(), provenance: [{ ...board, kind: 'olympiad' }] }).success).toBe(true);
    });
    it('refuses a code that is not 2 to 8 capitals and digits, a missing name, a year that is not a whole number', () => {
      for (const bad of [{ code: 'D' }, { code: 'dha' }, { code: 'TOOLONGXX' }, { code: 'ঢা' }, { code: 'DH-A' }, { name: undefined }, { year: 2023.5 }, { year: '2023' }, { kind: 'Board' }]) {
        expect(questionManifestSchema.safeParse({ ...base(), provenance: [{ ...board, ...bad }] }).success, JSON.stringify(bad)).toBe(false);
      }
    });
    it('keeps fields of an entry it does not know', () => {
      const m = base({ provenance: [{ ...board, paper: '1st' }] });
      expect((m.provenance![0] as Record<string, unknown>).paper).toBe('1st');
    });
    it('says when the same paper is listed twice', () => {
      expect(checkQuestion(base({ provenance: [board, board] }))).toEqual(['provenance board_exam DHA 2023: the same paper twice']);
      expect(checkQuestion(base({ provenance: [board, { ...board, year: 2022 }] }))).toEqual([]);
    });
  });

  describe('checkQuestion', () => {
    it('a multiple-choice question has two or more options and at most one marked correct', () => {
      expect(checkQuestion(mcq([1]))).toEqual([]);
      expect(checkQuestion(mcq([]))).toEqual([]); // the key is not known: allowed
      expect(checkQuestion(mcq([0, 1]))).toEqual(['mcq: at most one correct option (found 2)']);
      expect(checkQuestion(base({ kind: 'mcq', options: [{ label: 'a', text: 'x', correct: true }] }))).toEqual(['mcq: at least two options']);
    });
    it('a many-answers question needs two or more options, any number marked', () => {
      const m = (c: number[]) => ({ ...mcq(c), kind: 'mcq_multi' }) as QuestionManifest;
      expect(checkQuestion(m([0, 2]))).toEqual([]);
      expect(checkQuestion(m([]))).toEqual([]);
      expect(checkQuestion({ ...m([0]), options: [{ label: 'a', text: 'x' }] } as QuestionManifest)).toEqual(['mcq_multi: at least two options']);
    });
    it('a creative question has parts, and only it does', () => {
      expect(checkQuestion(base({ kind: 'cq' }))).toEqual(['cq: at least one part']);
      expect(checkQuestion(base({ kind: 'cq', parts: [{ label: 'ক', stem: 'x' }, { label: 'খ', stem: 'y' }] }))).toEqual([]);
      expect(checkQuestion(base({ kind: 'short_answer', parts: [{ label: 'ক', stem: 'x' }] }))).toEqual(['short_answer: parts are for a creative question']);
    });
    it('options belong to multiple choice only', () => {
      expect(checkQuestion(base({ kind: 'numeric', options: [{ label: 'a', text: 'x' }] }))).toEqual(['numeric: options are for multiple choice']);
    });
    it('labels are not used twice', () => {
      expect(checkQuestion(mcq([0], ['a', 'a', 'b']))).toEqual(['option a: used twice']);
      expect(checkQuestion(base({ kind: 'cq', parts: [{ label: 'ক', stem: 'x' }, { label: 'ক', stem: 'y' }] }))).toEqual(['part ক: used twice']);
    });
    it('a kind it does not know is not a problem', () => {
      expect(checkQuestion(base({ kind: 'essay-2030' }))).toEqual([]);
    });
    it('a picture used in the text must be listed in assets', () => {
      expect(checkQuestion(base({ stem: `Look: ![fig](${KEY})` }))).toEqual([`${KEY}: used in the text but not in assets`]);
      expect(checkQuestion(base({ stem: `Look: ![fig](${KEY})`, assets: [KEY] }))).toEqual([]);
      // in an option, a part, an answer, any language
      const deep = base({ kind: 'cq', stem: 'S', parts: [{ label: 'ক', stem: { en: 'x', bn: `![](${KEY})` } }] });
      expect(checkQuestion(deep)).toEqual([`${KEY}: used in the text but not in assets`]);
    });
  });

  it('lists the pictures a question uses, once each', () => {
    const k2 = 'c1:bbbbbbbbbbbbbbbbbbbbbbbbby';
    expect(questionAssetKeys(base({ stem: `![](${KEY}) and ![](${KEY})`, answer: { text: `![](${k2})` } })).sort()).toEqual([KEY, k2].sort());
    expect(questionAssetKeys(base())).toEqual([]);
  });

  it('names the tags a store lists a question under', () => {
    const m = load('scalar.question.json');
    expect(questionRegistryTags(m)).toEqual(['kind:question', 'question-kind:mcq', 'code:EX-2-M1', 'subject:physics', 'class:9', 'class:10', 'motion', 'scalar and vector']);
    expect(questionRegistryTags(base())).toEqual(['kind:question', 'question-kind:short_answer']);
  });
});
