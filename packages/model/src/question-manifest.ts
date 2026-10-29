import { z } from 'zod';
import { contentKeySchema, inLanguage, localizedTextSchema } from './lab-manifest.js';

/**
 * Question manifests (spec 1.6): what a store keeps about a question, so a book, a reader or an authoring tool can find it, show it and
 * check an answer without the question being copied into every book that uses it. A book refers to a question by the key of its
 * manifest; the store holds the question.
 *
 * Text is Markdown with inline LaTeX (`$…$`), as questions are written, in one language or one per language. A picture in the text is
 * `![alt](c1:…)`, the content key of an asset the manifest lists in `assets`.
 */

export const QUESTION_MANIFEST_TYPE = 'application/vnd.chalk.question+json';

/** The kinds of question this version knows. A manifest may carry another kind: readers show what they can of it (spec 1.6 §3). */
export const QUESTION_KINDS = ['mcq', 'mcq_multi', 'short_answer', 'numeric', 'cq'] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

/** An answer: the final answer, or a worked solution, as text; for a number, its value and unit as well. */
export const questionAnswerSchema = z.looseObject({
  text: localizedTextSchema.optional(),
  /** `final`: only the answer. `full`: a worked solution. */
  detail: z.enum(['final', 'full']).optional(),
  value: z.union([z.number(), z.string()]).optional(),
  unit: z.string().max(40).optional(),
});

/** One choice of a multiple-choice question. */
export const questionOptionSchema = z.looseObject({
  label: z.string().min(1).max(8),
  text: localizedTextSchema,
  correct: z.boolean().optional(),
});

/** One part of a creative question (ক, খ, গ, ঘ), with its own marks and answer. */
export const questionPartSchema = z.looseObject({
  label: z.string().min(1).max(8),
  stem: localizedTextSchema,
  marks: z.number().nonnegative().optional(),
  /** The thinking the part asks for: `knowledge`, `comprehension`, `application`, `higher_order`. */
  level: z.string().max(40).optional(),
  answer: questionAnswerSchema.optional(),
});

/** Where the question was printed, for people (and so that the same question is not published twice). */
export const questionSourceSchema = z.looseObject({
  book: z.string().max(300).optional(),
  edition: z.string().max(100).optional(),
  /** The number the book gave it. */
  number: z.string().max(40).optional(),
  page: z.number().int().positive().optional(),
});

export const questionManifestSchema = z.looseObject({
  format: z.literal('chalk.question'),
  manifestVersion: z.literal(1),
  /** Names the question for good. A corrected question is a new `version`, not a new `id`. */
  id: z.string().min(1).max(200),
  version: z.string().min(1).max(64),
  kind: z.string().min(1).max(40),
  /** A short name to type, such as `NG26-2-M118`. Not required to be unique: the `id` is. */
  code: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).optional(),
  stem: localizedTextSchema,
  /** A passage or situation the question is about (a creative question's scenario, a shared passage). */
  context: localizedTextSchema.optional(),
  options: z.array(questionOptionSchema).optional(),
  parts: z.array(questionPartSchema).optional(),
  answer: questionAnswerSchema.optional(),
  marks: z.number().nonnegative().optional(),
  difficulty: z.number().int().min(1).max(5).optional(),
  /** The thinking the question asks for, as for a part. */
  level: z.string().max(40).optional(),
  subject: z.string().optional(),
  classes: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  source: questionSourceSchema.optional(),
  /** The content keys of the pictures the text uses. */
  assets: z.array(contentKeySchema).optional(),
  license: z.string().optional(),
  authors: z.array(z.string()).optional(),
});

export type QuestionManifest = z.infer<typeof questionManifestSchema>;
export type QuestionAnswer = z.infer<typeof questionAnswerSchema>;
export type QuestionOption = z.infer<typeof questionOptionSchema>;
export type QuestionPart = z.infer<typeof questionPartSchema>;

const KEY_IN_TEXT = /c1:[a-z2-7]{25}[aeimquy4]|sha256:[0-9a-f]{64}/g;

/** Every piece of text a manifest holds, in every language. */
function texts(m: QuestionManifest): string[] {
  const out: string[] = [];
  const add = (t: z.infer<typeof localizedTextSchema> | undefined) => {
    if (t === undefined) return;
    if (typeof t === 'string') out.push(t);
    else out.push(...Object.values(t));
  };
  const answer = (a: QuestionAnswer | undefined) => add(a?.text);
  add(m.stem);
  add(m.context);
  for (const o of m.options ?? []) add(o.text);
  for (const p of m.parts ?? []) { add(p.stem); answer(p.answer); }
  answer(m.answer);
  return out;
}

/** The content keys the text of the question points at (its pictures). */
export function questionAssetKeys(m: QuestionManifest): string[] {
  return [...new Set(texts(m).flatMap((t) => t.match(KEY_IN_TEXT) ?? []))];
}

const dup = (labels: string[]): string[] => labels.filter((l, i) => labels.indexOf(l) !== i);

/**
 * Problems with a question beyond its shape (empty: all good). A kind this version does not know is not a problem: it is shown as far as
 * it can be. A picture the text uses must be listed in `assets`, so a store can check that it has it.
 */
export function checkQuestion(m: QuestionManifest): string[] {
  const problems: string[] = [];
  const options = m.options ?? [], parts = m.parts ?? [];
  const correct = options.filter((o) => o.correct).length;
  if (m.kind === 'mcq') {
    if (options.length < 2) problems.push('mcq: at least two options');
    else if (correct !== 1) problems.push(`mcq: exactly one correct option (found ${correct})`);
  }
  if (m.kind === 'mcq_multi') {
    if (options.length < 2) problems.push('mcq_multi: at least two options');
    else if (correct < 1) problems.push('mcq_multi: at least one correct option');
  }
  if (m.kind === 'cq' && parts.length < 1) problems.push('cq: at least one part');
  if (m.kind !== 'mcq' && m.kind !== 'mcq_multi' && options.length) problems.push(`${m.kind}: options are for multiple choice`);
  if (m.kind !== 'cq' && parts.length) problems.push(`${m.kind}: parts are for a creative question`);
  for (const l of dup(options.map((o) => o.label))) problems.push(`option ${l}: used twice`);
  for (const l of dup(parts.map((p) => p.label))) problems.push(`part ${l}: used twice`);
  const listed = new Set(m.assets ?? []);
  for (const k of questionAssetKeys(m)) if (!listed.has(k)) problems.push(`${k}: used in the text but not in assets`);
  return problems;
}

/** The text of the stem in a language: that language, else English, else the first there is. */
export const questionStem = (m: QuestionManifest, locale: string): string => inLanguage(m.stem, locale);

/**
 * The tags a store lists a question under, so a tool can find questions without opening each manifest: its kind (`kind:question`,
 * `question-kind:mcq`), its code, subject and classes, and the manifest's own tags.
 */
export function questionRegistryTags(m: QuestionManifest): string[] {
  return [
    ...new Set([
      'kind:question',
      `question-kind:${m.kind}`,
      ...(m.code ? [`code:${m.code}`] : []),
      ...(m.subject ? [`subject:${m.subject}`] : []),
      ...(m.classes ?? []).map((c) => `class:${c}`),
      ...(m.tags ?? []),
    ]),
  ];
}
