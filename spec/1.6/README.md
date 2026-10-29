# Chalk 1.6: Question manifests

Status: draft · `formatVersion` 11 (no model change) · builds on [1.2](../1.2/README.md) (keys, stores) and [1.5](../1.5/README.md) §4 (manifests)

One addition: a **question manifest**, what a store keeps about a question, so that a book, a reader or an editor can
find a question, show it and check an answer **without the question being copied into every book that uses it**.
The book holds a reference; the store holds the question. It is the same split as for labs and 3D models.

## 1. Why

Questions are written and corrected apart from books: a question bank is made once, reviewed, and then used beside a
textbook page, in a worksheet, in a test. Copying each question into each book means a correction reaches no book
already made, and the same question lives in many places. A question in a store, named by a key, is one copy that every
book points at, with versions (a corrected question is a new manifest), search, and the same delivery as every other
item in a store (spec 1.2, the registry API).

## 2. The manifest

Stored and delivered with the media type `application/vnd.chalk.question+json`:

```json
{
  "format": "chalk.question", "manifestVersion": 1,
  "id": "org.pathshalax.physics.motion.scalar-quantity", "version": "1.0.0",
  "kind": "mcq", "code": "EX-2-M1",
  "stem": { "bn": "নিচের কোনটি স্কেলার রাশি?", "en": "Which of these is a scalar quantity?" },
  "options": [
    { "label": "ক", "text": { "bn": "সরণ", "en": "Displacement" } },
    { "label": "খ", "text": { "bn": "দূরত্ব", "en": "Distance" }, "correct": true },
    { "label": "গ", "text": { "bn": "বেগ", "en": "Velocity" } },
    { "label": "ঘ", "text": { "bn": "ত্বরণ", "en": "Acceleration" } }
  ],
  "answer": { "detail": "final", "text": { "bn": "দূরত্বের কেবল মান আছে, দিক নেই।", "en": "Distance has magnitude only, no direction." } },
  "marks": 1, "difficulty": 1, "level": "knowledge",
  "subject": "physics", "classes": ["9", "10"], "tags": ["motion", "scalar and vector"],
  "source": { "book": "Example", "number": "1" },
  "license": "CC-BY-4.0", "authors": ["PathshalaX"]
}
```

| Field | | Meaning |
|---|---|---|
| `format`, `manifestVersion` | required | `"chalk.question"`, `1` |
| `id` | required | Names the question for good. A corrected question keeps its `id` and gets a new `version` |
| `version` | required | For people and tools. The manifest's own key (spec 1.2) fixes the exact bytes: a new version is a new manifest with a new key, and a book that refers to the old key keeps the old question |
| `kind` | required | What sort of question this is (§3) |
| `code` | | A short name to type, such as `NG26-2-M118`: letters, digits, `.`, `_` and `-`, at most 64. Not required to be unique; the `id` is |
| `stem` | required | The question, as text (§4): a string, or one per language (`bn`, `en`, …) |
| `context` | | A passage or situation the question is about (a creative question's scenario, a passage several questions share) |
| `options` | | The choices of a multiple-choice question: `label`, `text`, and `correct: true` on the right one(s) |
| `parts` | | The parts of a creative question (ক, খ, গ, ঘ): `label`, `stem`, and optionally `marks`, `level` and `answer` |
| `answer` | | `text` (the answer, or a worked solution), `detail` (`final` or `full`), and for a number `value` and `unit` |
| `marks`, `difficulty`, `level` | | Marks (a number ≥ 0), difficulty 1 to 5, and the thinking asked for: `knowledge`, `comprehension`, `application`, `higher_order` |
| `subject`, `classes`, `tags`, `license`, `authors` | | For finding questions in a store |
| `source` | | Where it was printed, for people: `book`, `edition`, `number`, `page` |
| `assets` | | The content keys of the pictures the text uses (§4) |

Like the lab manifest, a manifest is an open object: writers keep fields they do not know.

## 3. Kinds

| `kind` | Has | Rules |
|---|---|---|
| `mcq` | `options` | Two or more options, **exactly one** `correct` |
| `mcq_multi` | `options` | Two or more options, **at least one** `correct` |
| `short_answer` | | `answer` is the model answer |
| `numeric` | | `answer.value` (and `unit`) is the number; `answer.text` may show the working |
| `cq` | `parts` | At least one part. Marks and answers belong to the parts |

Other rules: `options` belong to the multiple-choice kinds and `parts` to `cq`; an option's `label`, and a part's
`label`, appear once.

**A reader or tool MUST NOT reject a manifest because its `kind` is one it does not know.** It shows what it can (the
`context` and `stem`, and `answer` if it has one) and leaves the rest. A new kind is a new value of `kind`, not a new
version of the format.

## 4. Text and pictures

Text is **Markdown with inline LaTeX** (`$…$`), the way questions are written: a worked solution keeps its steps on
their own lines, and a formula stays a formula. It is never flattened to plain text.

A picture in the text is `![alt](key)` with the content key of the asset (spec 1.2). Every key used in the text MUST be
listed in `assets`, so a store can check that it holds each of them. As for any asset, a reader MUST check the bytes it
gets against the key before showing them.

## 5. Finding questions

A store lists a question under these tags (registry API, `tag`), so a tool finds questions without opening each manifest:

| Tag | |
|---|---|
| `kind:question` | Every question. With the media type, this is how to list them |
| `question-kind:<kind>` | `question-kind:mcq`, `question-kind:cq`, … |
| `code:<code>` | A question by its code. **Look a code up by this tag**: free-text search splits `EX-2-M1` into words and finds every question whose title has one of them |
| `subject:<subject>`, `class:<class>` | As in the manifest |

The manifest's own `tags` are listed as they are. The item's title SHOULD be the `code`, else the `id`.

## 6. What this version does not say

- **How a book points at a question.** Today a tool holds the question's manifest key (a list kept beside the book, or
  in a database). A reference inside the book itself (an object type, or an index of lines to questions) is for a later
  minor version. Nothing here changes `formatVersion`.
- **How an answer is checked or scored.** A manifest says what the right answer is; a reader decides how to ask.

## 7. Conformance

- `schema/question-manifest.schema.json`.
- `examples/questions/`: a multiple-choice, a numeric and a creative question, valid against the schema.
- A library server accepts the media type, and finds questions by the tags of §5.
