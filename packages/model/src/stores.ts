import { z } from 'zod';
import { C1_KEY_PATTERN } from './keys.js';

/**
 * Asset stores (spec 1.2): what a book says about its assets beyond their bytes (facts, renditions), and the
 * descriptors of the stores that hold them. Loose objects throughout: later versions add fields, and readers
 * ignore what they do not know (spec 1.2 §5.1).
 */

/** A media type pattern: `video/mp4`, `video/*`, `*\/*`. */
const typePattern = z.string().regex(/^(\*|[a-z0-9][a-z0-9.+-]*)\/(\*|[a-z0-9][a-z0-9.+-]*)$/);

/** Facts a reader can use before fetching anything (spec 1.2 §4.2). */
export const assetMetaSchema = z.looseObject({
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  /** Seconds. */
  duration: z.number().nonnegative().optional(),
  pages: z.number().int().positive().optional(),
});

/** Another version of the same media item (spec 1.2 §4.3). */
export const renditionSchema = z.looseObject({
  id: z.string(),
  type: z.string(),
  size: z.number().int().nonnegative().optional(),
  meta: assetMetaSchema.optional(),
});

/** What a manifest asset entry adds in 1.2: size, meta, renditions. */
export const assetInfoSchema = z.looseObject({
  size: z.number().int().nonnegative().optional(),
  meta: assetMetaSchema.optional(),
  renditions: z.array(renditionSchema).optional(),
});

/** A store descriptor (spec 1.2 §5.1). */
export const storeDescriptorSchema = z.looseObject({
  id: z.string().min(1).max(100),
  kind: z.string(),   // derived | indexed | api; a reader skips kinds it does not know
  template: z.string().optional(),
  base: z.string().optional(),
  media: z.array(typePattern).optional(),
  priority: z.number().int().optional(),
  verify: z.enum(['always', 'first', 'none']).optional(),
  auth: z.enum(['none', 'bearer']).optional(),
}).superRefine((d, ctx) => {
  if (d.kind === 'derived' && !d.template) ctx.addIssue({ code: 'custom', path: ['template'], message: 'a derived store needs a template' });
  if ((d.kind === 'indexed' || d.kind === 'api') && !d.base) ctx.addIssue({ code: 'custom', path: ['base'], message: `an ${d.kind} store needs a base URL` });
  if (d.base && !d.base.endsWith('/')) ctx.addIssue({ code: 'custom', path: ['base'], message: 'base must end with /' });
});

/** One shard of an indexed store: hash part → where it is (spec 1.2 §5.3). */
export const indexShardSchema = z.looseObject({
  v: z.literal(1),
  entries: z.record(
    z.string().regex(/^[a-z2-7]{25}[aeimquy4]$/),
    z.looseObject({ p: z.string().min(1), s: z.number().int().nonnegative().optional(), t: z.string().optional() }),
  ),
});

export type AssetMeta = z.infer<typeof assetMetaSchema>;
export type Rendition = z.infer<typeof renditionSchema>;
export type AssetInfo = z.infer<typeof assetInfoSchema>;
export type StoreDescriptor = z.infer<typeof storeDescriptorSchema>;
export type IndexShard = z.infer<typeof indexShardSchema>;

/** Is `key` a canonical c1 key? (re-exported for schema users) */
export const isStoreKey = (key: string) => C1_KEY_PATTERN.test(key);
