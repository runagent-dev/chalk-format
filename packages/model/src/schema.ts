import { z } from 'zod';

/**
 * The single source of truth for the `.chalk` document model.
 *
 * Types are INFERRED from these Zod schemas (see the `z.infer` exports),
 * so there is exactly one definition per shape. Producers (the editor,
 * importers, the CLI) and consumers (the renderer, the codec) all import
 * these inferred types, and encode/decode validate against these same
 * schemas — that is what keeps every part in sync when the format grows.
 *
 * Rules that keep the guarantee (enforced in review + tests):
 *   - decode always `parseLesson` (never `as`);
 *   - encode `validateLessonModel` before writing;
 *   - any schema change bumps CHALK_FORMAT_VERSION and adds a migration
 *     (see migrate.ts) with a versioned-fixtures test.
 *
 * This is Phase 1: the schema captures the *current* model unchanged.
 * Richer items (image/shape/vector/embed), layered pages, and external
 * asset references arrive in later phases behind migrations.
 */

/** Bumped whenever the on-disk model changes; drives migration. */
export const CHALK_FORMAT_VERSION = 9;

/** Placement size for image/embed objects — `'full'` (default, absent)
 *  draws at the object's stored `width`/`height`; `'icon'` draws as a
 *  small fixed-size marker instead (see `MEDIA_ICON_SIZE` in
 *  object-transform.ts), so a teacher can drop a compact clickable badge
 *  anywhere without it fighting for space with page content. */
export const mediaDisplayModeSchema = z.enum(['full', 'icon']);

const objectBase = {
  id: z.string(),
  x: z.number(),
  y: z.number(),
};

export const rectObjectSchema = z.object({
  ...objectBase,
  type: z.literal('rect'),
  width: z.number(),
  height: z.number(),
  fill: z.string(),
  stroke: z.string(),
  strokeWidth: z.number(),
});

export const inkObjectSchema = z.object({
  ...objectBase,
  type: z.literal('ink'),
  points: z.array(z.number()),
  color: z.string(),
  size: z.number(),
});

export const textObjectSchema = z.object({
  ...objectBase,
  type: z.literal('text'),
  text: z.string(),
  fontSize: z.number(),
  fill: z.string(),
});

// --- Rich item types (schema v3) ---

export const imageObjectSchema = z.object({
  ...objectBase,
  type: z.literal('image'),
  assetId: z.string(),
  width: z.number(),
  height: z.number(),
  displayMode: mediaDisplayModeSchema.optional(),
});

export const ellipseObjectSchema = z.object({
  ...objectBase,
  type: z.literal('ellipse'),
  width: z.number(),
  height: z.number(),
  fill: z.string(),
  stroke: z.string(),
  strokeWidth: z.number(),
});

export const lineObjectSchema = z.object({
  ...objectBase,
  type: z.literal('line'),
  x2: z.number(),
  y2: z.number(),
  stroke: z.string(),
  strokeWidth: z.number(),
});

export const arrowObjectSchema = z.object({
  ...objectBase,
  type: z.literal('arrow'),
  x2: z.number(),
  y2: z.number(),
  stroke: z.string(),
  strokeWidth: z.number(),
});

export const vectorObjectSchema = z.object({
  ...objectBase,
  type: z.literal('vector'),
  /** SVG path data in page units, drawn offset by (x, y) (from structured import). */
  path: z.string(),
  fill: z.string().optional(),
  stroke: z.string().optional(),
  strokeWidth: z.number().optional(),
});

/** A content-addressed id: a c1 key (spec 1.2 §3, schema v9) or `sha256:` + 64 lowercase hex digits. The only
 *  ids a lab entry may use (hosts verify the bytes). */
const sha256AssetIdSchema = z.string().regex(/^(?:sha256:[0-9a-f]{64}|c1:[a-z2-7]{25}[aeimquy4])$/);

/** A namespaced plugin id: `chalk.*` is reserved for this spec, others use reverse DNS (spec 1.1 §2.2). */
export const PLUGIN_ID_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
/** The plugin id of labs (spec 1.1 §2). */
export const LAB_PLUGIN_ID = 'chalk.lab';
/** Largest `lab.params`, serialised (spec 1.1 §2). */
export const LAB_PARAMS_MAX_BYTES = 16 * 1024;

/**
 * An interactive lab (schema v8, spec 1.1): one self-contained HTML file run
 * in a sandbox, talking to the reader only through the Host API. Loose: fields
 * a later version adds survive a round trip through this one (spec 1.1 §2.2).
 */
export const labSchema = z.looseObject({
  /** Stable identity of the lab, reverse-DNS style; the same lab in many books has one id. */
  id: z.string().min(1).max(200),
  /** The lab's own version; saved state is keyed by id + major version. */
  version: z.string().min(1).max(64),
  /** Human-readable name: the frame's accessible name and the fallback card's label. */
  title: z.string(),
  /** The lab's HTML file (content-addressed). */
  entry: sha256AssetIdSchema,
  /** Other assets of the book the lab may load through the Host API (`asset.get`). */
  assets: z.array(sha256AssetIdSchema).optional(),
  /** JSON configuration handed to the lab at start (one lab file, many configurations).
   *  At most 16 KiB serialised: a byte limit JSON Schema cannot express, so readers check it (spec 1.1 §2). */
  params: z
    .record(z.string(), z.unknown())
    .refine((p) => new TextEncoder().encode(JSON.stringify(p)).length <= LAB_PARAMS_MAX_BYTES, {
      message: `lab.params is larger than ${LAB_PARAMS_MAX_BYTES} bytes`,
    })
    .optional(),
  /** Host API capabilities the lab asks for (`state`, `progress`, `assets`); unknown names are ignored. */
  capabilities: z.array(z.string()).optional(),
});

/**
 * A reference to external media placed on the page (video, 3D model,
 * audio, or plugin widget). The bytes live elsewhere — resolved by
 * assetId (content-addressed, via AssetService) or a url — so the
 * document stays small. `poster` is an optional inline thumbnail asset.
 *
 * Loose (schema v8): fields this version does not know, such as a plugin's own
 * configuration, are kept, so writers preserve them (spec 1.1 §2.2).
 */
export const embedObjectSchema = z.looseObject({
  ...objectBase,
  type: z.literal('embed'),
  embed: z.enum(['video', 'model3d', 'audio', 'plugin']),
  width: z.number(),
  height: z.number(),
  assetId: z.string().optional(),
  url: z.string().optional(),
  poster: z.string().optional(),
  displayMode: mediaDisplayModeSchema.optional(),
  /** What runs an `embed: 'plugin'` object (schema v8). A reader without that plugin draws the
   *  poster card instead and keeps the object (spec 1.1 §2.2). */
  plugin: z.string().regex(PLUGIN_ID_PATTERN).optional(),
  /** The lab descriptor, present exactly when `plugin` is `chalk.lab` (schema v8). */
  lab: labSchema.optional(),
}).superRefine((o, ctx) => {
  if (o.plugin !== undefined && o.embed !== 'plugin') {
    ctx.addIssue({ code: 'custom', path: ['plugin'], message: "'plugin' is only allowed on embed: 'plugin'" });
  }
  if ((o.plugin === LAB_PLUGIN_ID) !== (o.lab !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['lab'], message: `'lab' is required with plugin '${LAB_PLUGIN_ID}' and allowed only there` });
  }
});

/**
 * A small, fixed-size clickable marker on a page, pointing at a satellite
 * page (in `lesson.snipPages`) that holds a frozen, fully-composited
 * capture of some page region as its background, plus whatever the
 * teacher has annotated on top of it. Carries no asset id of its own —
 * the capture lives on the satellite page, reached only via `snipPageId`.
 * Not resizable (schema v6): see `SNIP_ICON_SIZE` in object-transform.ts.
 */
export const snipObjectSchema = z.object({
  ...objectBase,
  type: z.literal('snip'),
  snipPageId: z.string(),
});

export const lessonObjectSchema = z.discriminatedUnion('type', [
  rectObjectSchema,
  inkObjectSchema,
  textObjectSchema,
  imageObjectSchema,
  ellipseObjectSchema,
  lineObjectSchema,
  arrowObjectSchema,
  vectorObjectSchema,
  embedObjectSchema,
  snipObjectSchema,
]);

export const pageBackgroundSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('blank') }),
  z.object({ type: z.literal('color'), color: z.string() }),
  z.object({
    type: z.literal('pdf_page'),
    assetId: z.string(),
    pageNumber: z.number(),
    renderedImageAssetId: z.string().optional(),
    /** A small (~240px) always-inlined preview, separate from the full-res
     *  `renderedImageAssetId` — which is resolved lazily and may not be
     *  locally resident. Lets the page panel show an instant thumbnail
     *  without ever needing the full-res image. */
    thumbnailAssetId: z.string().optional(),
  }),
  // schema v6: a frozen raster capture (region-snip) as a page background.
  z.object({ type: z.literal('image'), assetId: z.string() }),
]);

/**
 * A positioned run of extracted text (schema v2). Populated by document
 * importers (e.g. PDF) so a page is searchable/accessible even when its
 * visual content is a raster background. Coordinates are in page units,
 * the same space as objects and the background, so the text overlays the
 * raster exactly.
 */
export const textRunSchema = z.object({
  text: z.string(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  fontSize: z.number(),
});

export const lessonPageSchema = z.object({
  id: z.string(),
  title: z.string(),
  background: pageBackgroundSchema,
  objects: z.array(lessonObjectSchema),
  width: z.number().optional(),
  height: z.number().optional(),
  textLayer: z.array(textRunSchema).optional(),
});

export const lessonSchema = z.object({
  id: z.string(),
  title: z.string(),
  locale: z.string(),
  pages: z.array(lessonPageSchema),
  /** Satellite pages backing region-snip objects (schema v6). Ordinary
   *  `LessonPage`s, reusing the full page rendering/hit-test/tool
   *  machinery, but NOT part of page navigation/count — never rendered,
   *  turned, or thumbnailed as a normal page; only ever opened via a
   *  `snip` object's modal. */
  snipPages: z.array(lessonPageSchema).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** An explicit cover image, overriding the default "use page 1" fallback.
   *  Not tied to any one page — a property of the book itself, so a
   *  publisher can supply a full-resolution custom cover distinct from the
   *  literal first page's content. */
  coverAssetId: z.string().optional(),
});

export type RectObject = z.infer<typeof rectObjectSchema>;
export type InkObject = z.infer<typeof inkObjectSchema>;
export type TextObject = z.infer<typeof textObjectSchema>;
export type ImageObject = z.infer<typeof imageObjectSchema>;
export type EllipseObject = z.infer<typeof ellipseObjectSchema>;
export type LineObject = z.infer<typeof lineObjectSchema>;
export type ArrowObject = z.infer<typeof arrowObjectSchema>;
export type VectorObject = z.infer<typeof vectorObjectSchema>;
export type EmbedObject = z.infer<typeof embedObjectSchema>;
export type EmbedKind = EmbedObject['embed'];
export type Lab = z.infer<typeof labSchema>;
/** An embed that is a lab: `embed: 'plugin'`, `plugin: 'chalk.lab'`, with its descriptor. */
export type LabObject = EmbedObject & { embed: 'plugin'; plugin: typeof LAB_PLUGIN_ID; lab: Lab };
export const isLabObject = (o: LessonObject): o is LabObject => o.type === 'embed' && o.plugin === LAB_PLUGIN_ID && o.lab !== undefined;
export type SnipObject = z.infer<typeof snipObjectSchema>;
export type MediaDisplayMode = z.infer<typeof mediaDisplayModeSchema>;
export type LessonObject = z.infer<typeof lessonObjectSchema>;
export type PageBackground = z.infer<typeof pageBackgroundSchema>;
export type TextRun = z.infer<typeof textRunSchema>;
export type LessonPage = z.infer<typeof lessonPageSchema>;
export type Lesson = z.infer<typeof lessonSchema>;

/** Parse+validate an unknown value into a Lesson; throws on mismatch. */
export function parseLesson(data: unknown): Lesson {
  return lessonSchema.parse(data);
}

/** Non-throwing parse — returns Zod's SafeParse result. */
export function safeParseLesson(data: unknown) {
  return lessonSchema.safeParse(data);
}

export type LessonValidation = { ok: true } | { ok: false; issues: string[] };

/** Validate a lesson model, returning human-readable issue paths. */
export function validateLessonModel(data: unknown): LessonValidation {
  const result = lessonSchema.safeParse(data);
  if (result.success) return { ok: true };
  return {
    ok: false,
    issues: result.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    ),
  };
}
