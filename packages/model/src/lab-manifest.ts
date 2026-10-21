import { z } from 'zod';
import { LAB_PLUGIN_ID, labLibrarySchema, type LessonObject } from './schema.js';

/**
 * Lab manifests (spec 1.5 §4): what a store keeps about a lab so a book designer can find it, place it and set
 * it up without reading its code. `params` is a small JSON Schema; authoring tools build a settings form from it.
 */

export const LAB_MANIFEST_TYPE = 'application/vnd.chalk.lab+json';

/** A string, or one per language (`{ bn, en }`). */
const localized = z.union([z.string(), z.record(z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]+)*$/), z.string())]);
const key = z.string().regex(/^(?:sha256:[0-9a-f]{64}|c1:[a-z2-7]{25}[aeimquy4])$/);

/** One setting a designer may change (a property of `params`). */
export const labParamSchema = z.looseObject({
  type: z.enum(['number', 'integer', 'boolean', 'string']),
  title: localized.optional(),
  description: localized.optional(),
  default: z.union([z.number(), z.boolean(), z.string()]).optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  multipleOf: z.number().positive().optional(),
  enum: z.array(z.union([z.number(), z.string()])).min(1).optional(),
  'x-chalk-unit': z.string().max(20).optional(),
});

export const labManifestSchema = z.looseObject({
  format: z.literal('chalk.lab'),
  manifestVersion: z.literal(1),
  id: z.string().min(1).max(200),
  version: z.string().min(1).max(64),
  title: localized,
  description: localized.optional(),
  subject: z.string().optional(),
  classes: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  entry: key,
  poster: key.optional(),
  assets: z.array(key).optional(),
  libraries: z.array(labLibrarySchema).optional(),
  capabilities: z.array(z.string()).optional(),
  size: z.looseObject({
    width: z.number().positive(), height: z.number().positive(),
    minWidth: z.number().positive().optional(), minHeight: z.number().positive().optional(),
  }).optional(),
  params: z.looseObject({ type: z.literal('object'), properties: z.record(z.string(), labParamSchema) }).optional(),
  presets: z.array(z.looseObject({ id: z.string(), title: localized, params: z.record(z.string(), z.unknown()) })).optional(),
  license: z.string().optional(),
  authors: z.array(z.string()).optional(),
});

export type LabManifest = z.infer<typeof labManifestSchema>;
export type LabParam = z.infer<typeof labParamSchema>;
export type Localized = z.infer<typeof localized>;

/** A localized text in a language: that language, else English, else the first there is. */
export function inLanguage(text: Localized | undefined, locale: string): string {
  if (text === undefined) return '';
  if (typeof text === 'string') return text;
  return text[locale] ?? text.en ?? Object.values(text)[0] ?? '';
}

/** Problems with a designer's settings against the manifest's `params` (empty: all good). */
export function checkLabParams(manifest: LabManifest, params: Record<string, unknown>): string[] {
  const props = manifest.params?.properties ?? {};
  const problems: string[] = [];
  for (const [name, v] of Object.entries(params)) {
    const p = props[name];
    if (!p) { problems.push(`${name}: not a setting of this lab`); continue; }
    if (p.enum && !p.enum.includes(v as never)) { problems.push(`${name}: one of ${p.enum.join(', ')}`); continue; }
    if (p.type === 'boolean' && typeof v !== 'boolean') problems.push(`${name}: true or false`);
    if (p.type === 'string' && typeof v !== 'string') problems.push(`${name}: text`);
    if (p.type === 'number' || p.type === 'integer') {
      if (typeof v !== 'number' || !Number.isFinite(v)) { problems.push(`${name}: a number`); continue; }
      if (p.type === 'integer' && !Number.isInteger(v)) problems.push(`${name}: a whole number`);
      if (p.minimum !== undefined && v < p.minimum) problems.push(`${name}: at least ${p.minimum}`);
      if (p.maximum !== undefined && v > p.maximum) problems.push(`${name}: at most ${p.maximum}`);
      // multiples, allowing for floating point (0.75 is a multiple of 0.25)
      if (p.multipleOf !== undefined && Math.abs(v / p.multipleOf - Math.round(v / p.multipleOf)) > 1e-9) problems.push(`${name}: a multiple of ${p.multipleOf}`);
    }
  }
  return problems;
}

/** The settings a lab starts with: the schema's defaults, then a preset, then the designer's own (spec 1.5 §4). */
export function labParams(manifest: LabManifest, preset?: string, own: Record<string, unknown> = {}): Record<string, unknown> {
  const defaults = Object.fromEntries(Object.entries(manifest.params?.properties ?? {}).filter(([, p]) => p.default !== undefined).map(([k, p]) => [k, p.default]));
  const fromPreset = preset ? manifest.presets?.find((p) => p.id === preset)?.params ?? {} : {};
  return { ...defaults, ...fromPreset, ...own };
}

/** A lab placed on a page from its manifest (spec 1.5 §4). */
export function labObjectFromManifest(manifest: LabManifest, o: { id: string; x: number; y: number; locale: string; preset?: string; params?: Record<string, unknown>; width?: number }): LessonObject {
  const size = manifest.size ?? { width: 960, height: 540 };
  const width = o.width ?? size.width, height = Math.round((size.height * width) / size.width);
  const params = labParams(manifest, o.preset, o.params);
  const problems = checkLabParams(manifest, params);
  if (problems.length) throw new Error(`lab ${manifest.id}: ${problems.join('; ')}`);
  return {
    id: o.id, type: 'embed', embed: 'plugin', plugin: LAB_PLUGIN_ID, x: o.x, y: o.y, width, height,
    ...(manifest.poster ? { poster: manifest.poster } : {}),
    lab: {
      id: manifest.id, version: manifest.version, title: inLanguage(manifest.title, o.locale), entry: manifest.entry,
      ...(manifest.assets?.length ? { assets: manifest.assets } : {}),
      ...(manifest.libraries?.length ? { libraries: manifest.libraries } : {}),
      ...(manifest.capabilities?.length ? { capabilities: manifest.capabilities } : {}),
      ...(Object.keys(params).length ? { params } : {}),
    },
  } as LessonObject;
}
