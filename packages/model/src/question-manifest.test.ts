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

describe('question manifests (spec 1.6)', () => {
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

  describe('checkQuestion', () => {
    it('a multiple-choice question has two or more options and exactly one correct', () => {
      expect(checkQuestion(mcq([1]))).toEqual([]);
      expect(checkQuestion(mcq([]))).toEqual(['mcq: exactly one correct option (found 0)']);
      expect(checkQuestion(mcq([0, 1]))).toEqual(['mcq: exactly one correct option (found 2)']);
      expect(checkQuestion(base({ kind: 'mcq', options: [{ label: 'a', text: 'x', correct: true }] }))).toEqual(['mcq: at least two options']);
    });
    it('a many-answers question needs at least one correct option', () => {
      const m = (c: number[]) => ({ ...mcq(c), kind: 'mcq_multi' }) as QuestionManifest;
      expect(checkQuestion(m([0, 2]))).toEqual([]);
      expect(checkQuestion(m([]))).toEqual(['mcq_multi: at least one correct option']);
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
