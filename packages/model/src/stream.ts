import { z } from 'zod';
import { assetMetaSchema, renditionSchema, storeDescriptorSchema } from './stores.js';
import { textRunSchema } from './schema.js';

/**
 * Streamed books (spec 1.4): the index a reader loads first, and the search file. The pages themselves are the
 * page JSON of spec 1.0 §3.2.
 */

export const STREAM_VERSION = 1;

/** A path inside a streamed book: relative, no `..`, no scheme, no leading slash (spec 1.4 §2). */
export const streamPathSchema = z.string().min(1).max(500).refine(
  (p) => !p.startsWith('/') && !/^[a-z][a-z0-9+.-]*:/i.test(p) && !p.split('/').includes('..') && !p.includes('\\'),
  { message: 'paths in a streamed book are relative, without .. or a scheme' },
);

export const streamPageSchema = z.looseObject({
  id: z.string(),
  file: streamPathSchema,
  title: z.string().optional(),
  label: z.string().max(40).optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  bytes: z.number().int().nonnegative().optional(),
  assetBytes: z.number().int().nonnegative().optional(),
  thumb: z.string().optional(),
  assets: z.array(z.string()).optional(),
});

export const streamAssetSchema = z.looseObject({
  id: z.string(),
  type: z.string(),
  size: z.number().int().nonnegative().optional(),
  meta: assetMetaSchema.optional(),
  renditions: z.array(renditionSchema).optional(),
  /** Present: the file is in this streamed book. Absent: external (spec 1.2 stores). */
  path: streamPathSchema.optional(),
});

export const streamIndexSchema = z.looseObject({
  format: z.literal('chalk.streamed'),
  streamVersion: z.number().int().min(1).max(STREAM_VERSION),
  formatVersion: z.number().int().min(1),
  id: z.string(),
  title: z.string(),
  locale: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  coverAssetId: z.string().optional(),
  pages: z.array(streamPageSchema).min(1),
  snipPages: z.array(streamPageSchema).optional(),
  assets: z.array(streamAssetSchema),
  text: z.looseObject({ file: streamPathSchema, bytes: z.number().int().nonnegative().optional() }).optional(),
  assetSources: z.array(storeDescriptorSchema).optional(),
});

export const streamTextSchema = z.looseObject({
  v: z.literal(1),
  pages: z.record(z.string(), z.array(textRunSchema)),
});

export type StreamPage = z.infer<typeof streamPageSchema>;
export type StreamAsset = z.infer<typeof streamAssetSchema>;
export type StreamIndex = z.infer<typeof streamIndexSchema>;
export type StreamText = z.infer<typeof streamTextSchema>;
