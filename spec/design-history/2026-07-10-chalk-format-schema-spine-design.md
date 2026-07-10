# .chalk Format — Schema-First Model & Package Spine

**Date:** 2026-07-10
**Status:** Approved. This spec covers the full multi-phase design; the
first PR implements **Phase 1** only.

## Goal

Make `.chalk` a schema-first document format so that a single schema is
the source of truth for the model, the encoder (writers/importers), the
decoder (reader), the validator, and the renderer. Any future change to
the format propagates to every producer and consumer — the in-app
editor, the in-app PDF importer, a standalone converter CLI, and future
DOCX/PPTX importers — without silent drift.

## Why (analysis summary)

- "Small **and** high quality" requires preserving document structure,
  not a better image codec alone — a rasterized page is both bigger and
  lower quality than structured text+vectors. So `.chalk` is a
  structured document/lesson model that importers compile into, not
  "a zipped PDF".
- No off-the-shelf format fits (tldraw/Excalidraw are canvas-native but
  not import-oriented; OOXML/PDF are document-native but not
  board/annotation-oriented). Custom model, standard primitives inside
  it (SVG paths, perfect-freehand, glTF, WebP/AVIF, ZIP+manifest).

## The single-source-of-truth mechanism

One Zod schema in `@chalkbook/core`:

- `z.infer<typeof Schema>` → the TypeScript types every consumer imports.
- `Schema.parse(data)` → runtime validation the decoder uses.
- The content model is a **discriminated union**; consumers `switch` on
  it exhaustively (with `never` checks), so adding a variant breaks
  every consumer's build until handled — compile-time propagation.

### The three guarantees (and what enforces each)

1. **Structural** (shapes, item types, fields) — enforced automatically:
   - compiler: exhaustive union + shared types across the monorepo
     typecheck graph (all producers/consumers fail CI together);
   - runtime: `encode` validates before writing, `decode` validates
     before rendering — same schema both sides, so any file `encode`
     accepts, `decode` accepts.
2. **Version** (old files still open) — enforced by a **CI test**, not
   the compiler: a migration registry keyed by `formatVersion`, plus a
   versioned-fixtures test that decodes a golden `.chalk` per past
   version and asserts a clean upgrade.
3. **Behavioral** (Node rasterizer vs browser rasterizer produce the
   same pixels) — enforced by using the **same engine** (PDF.js) both
   sides + a golden/visual test. Not a schema concern.

### The rules (acceptance criteria / lint + CI)

1. Decode **always** `schema.parse` — never `as`.
2. Encode **validates** before writing.
3. Any schema change bumps `formatVersion` and adds a migration; the
   versioned-fixtures test enforces old files still open.
4. One schema, imported everywhere — no local redeclarations, no
   boundary casts.
5. All producers/consumers stay in the CI typecheck graph.
6. Same rasterization engine across shells; golden test for fidelity.
7. The schema is exportable as JSON Schema (the interop contract for any
   future non-TypeScript producer).

## Package layout (evolve `core` + `format`, don't fork)

```
@chalkbook/core        SOURCE OF TRUTH: Zod schema → types, validation,
                       migrations, the item union, coordinate model.
@chalkbook/format      CODEC: model ↔ .chalk bytes (ZIP), asset packing,
                       fat/thin bundles. Delegates all model validation
                       to core's schema.
@chalkbook/canvas-konva RENDERER: implements ItemRenderer over the item
                       union (browser/Konva).
@chalkbook/importers/* ENCODERS: PDF/DOCX/PPTX → model, via an injected
   (+ tools/content-cli) Rasterizer. Target the same model the editor edits.
@chalkbook/pdf-engine  becomes the browser Rasterizer; a Node Rasterizer
                       (@napi-rs/canvas) is the CLI's impl.
```

The shared spine everyone keys off, all in `core`: the **item union**, a
**`Rasterizer`** interface (page → image), and an **`ItemRenderer`**
interface (item → visual node).

## The target document model (Phases 2–5 grow into this)

```ts
ChalkDocument {
  formatVersion: number
  metadata { id, title, locale, author?, license?, createdAt, updatedAt }
  assets: AssetEntry[]
  pages: Page[]
}
Page {
  id
  size: { width, height }                    // logical coordinate space — the anchor
  background: Background
  items: Item[]                              // z-ordered, tagged content|annotation
  textLayer?: TextRun[]                      // extracted searchable text
}
Background = blank | color | { raster, assetId, fit }   // WebP/AVIF page image
Item = { id, layer: content|annotation, z, transform } & ItemData
Transform { x, y, scaleX, scaleY, rotation }            // page units
ItemData =
  | text   (structured runs)   | vector (svg path)
  | shape  (rect|ellipse|line|arrow) | ink (perfect-freehand)
  | image  (assetId)           | embed (video|model3d|audio|plugin, ref+poster)
  | group
AssetEntry {
  id: "sha256:…", mime, size,
  storage: "inline" | "external",           // external → AssetService (video/3D)
  poster?, provenance?
}
```

**Coordinate fidelity:** everything is stored in page-coordinate units
(never screen pixels). Import maps source→page units; the renderer maps
page→screen with one transform; drawing inverse-maps the pointer. So an
annotation at page (x,y) sits exactly over content at page (x,y) at any
zoom/size/export/re-import.

**Assets:** content-addressed (sha256) → free dedup + integrity +
set-diff sync. Small/essential inline; video/3D external references with
a poster. Fat bundle (portable) and thin bundle (references) both
round-trip.

## Compression (encode concern, Phase 2+)

Encoder owns image policy: page rasters → WebP now / AVIF later, per-page
quality (text/diagram near-lossless, photo lossy) — the ~5–10× win.
Already-compressed assets stored (no re-DEFLATE); JSON DEFLATE'd.
Structured extraction is the later 10–30× endgame.

## Phased implementation

- **Phase 1 — schema spine (this PR):** put the *current* model behind a
  Zod schema in `core` (single source of truth, types inferred from it);
  add `formatVersion` + a migration harness (no-op at v1); make `format`
  encode/decode/validate delegate to the schema (decode parses instead
  of casting; encode validates; validator uses the schema for model
  shape). Add the versioned-fixtures test. **No behavior change** —
  every existing test stays green.
- **Phase 2 — compression + layering:** raster background → WebP; add
  the PDF `textLayer`.
- **Phase 3 — rich items:** add image, shape (ellipse/line/arrow),
  vector, embed to the schema; renderer + editor + hit-test handle them.
- **Phase 4 — importer interface + PDF→chalk CLI:** shared PDF→model
  staging with an injected Rasterizer (browser + Node); ship the
  converter CLI. DOCX/PPTX importers target the same model later.
- **Phase 5 — structured extraction:** text/vectors for born-digital
  sources; drop raster where confident.
- **Phase 6 — external assets via AssetService:** thin bundles, OPFS,
  video/3D references; converges with the offline plan (§8A).

## Phase 1 scope & acceptance

In `@chalkbook/core`:
- `schema.ts`: Zod schemas for the current model (object union
  rect|text|ink, background blank|color|pdf_page, page, lesson). Types
  **inferred** from the schema and re-exported so the public type
  surface (`Lesson`, `LessonPage`, `LessonObject`, `PageBackground`,
  etc.) is unchanged.
- `parseLesson` / `safeParseLesson` / `validateLessonModel` helpers.
- `CHALK_FORMAT_VERSION = 1`; `migrate.ts` with a registry keyed by
  version and `migrateToLatest(data, fromVersion)` (no migrations yet).

In `@chalkbook/format`:
- manifest gains `formatVersion: number` (existing files without it are
  treated as v1 — backward compatible).
- `unpackLesson`: read `formatVersion` → `migrateToLatest` → build the
  raw lesson → `parseLesson` (replaces `JSON.parse(...) as LessonPage`).
- `packLesson`: `validateLessonModel` before writing; write
  `formatVersion`.
- `validateLessonPackage`: delegate model-shape checks to the schema
  (container checks stay in format).

Acceptance:
- Existing core/format/web/tools suites stay green (no behavior change).
- New tests: schema accepts valid / rejects malformed models; decode
  rejects a tampered page; migration harness upgrades a v1 fixture;
  encode refuses an invalid model.
- Full `turbo typecheck test lint build` green across the monorepo —
  proving the shared-types linkage holds for every consumer.

## Out of scope (Phase 1)

Rich item types, WebP, importers, CLI, structured extraction, external
assets, JSON-Schema export tooling — all later phases.
