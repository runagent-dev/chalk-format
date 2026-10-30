import { z } from 'zod';
import { assetKeyAndSha256, assetMetaSchema, storeDescriptorSchema } from '@chalk-format/model';
import { fetchWithToken, type TokenSource } from './auth/token.js';

/**
 * The registry API, version 1 (spec/1.2/registry-api.md): request and response shapes, and a small typed
 * client for authoring tools. Students' devices never use this; they resolve through stores.
 */

const key = z.string().regex(/^c1:[a-z2-7]{25}[aeimquy4]$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const assetRecordSchema = z.looseObject({
  key, sha256, type: z.string(), size: z.number().int().nonnegative(),
  meta: assetMetaSchema.optional(),
  title: z.string().nullish(), filename: z.string().nullish(), tags: z.array(z.string()).optional(),
  subject: z.string().nullish(), license: z.string().nullish(),
  poster: key.nullish(), renditions: z.array(key).optional(),
  status: z.enum(['pending', 'available', 'withdrawn']),
  uploadedBy: z.string().nullish(), createdAt: z.string(),
  locations: z.array(z.looseObject({ store: z.string(), path: z.string() })).optional(),
});

export const checkRequestSchema = z.object({ keys: z.array(key).min(1).max(1000) });
export const checkResponseSchema = z.object({ present: z.array(key), missing: z.array(key) });

export const uploadRequestSchema = z.object({
  key, sha256, type: z.string(), size: z.number().int().nonnegative(), filename: z.string().optional(),
});
export const uploadResponseSchema = z.union([
  z.looseObject({
    upload: z.looseObject({ url: z.string(), method: z.literal('PUT'), headers: z.record(z.string(), z.string()).optional(), expiresAt: z.string() }),
    store: z.string(),
  }),
  z.looseObject({ exists: z.literal(true), asset: assetRecordSchema }),
]);

export const registerRequestSchema = z.object({
  key, sha256, type: z.string(), size: z.number().int().nonnegative(),
  meta: assetMetaSchema.optional(), title: z.string().optional(), tags: z.array(z.string()).optional(),
  subject: z.string().optional(), license: z.string().optional(), filename: z.string().optional(),
  poster: key.optional(), renditions: z.array(key).optional(),
});
/**
 * Adopting a file in place (registry-api §3.1): an object already in the library's own bucket, under a prefix the
 * library allows; the registry reads it once to verify it and serves it from there. `path` is relative to the
 * bucket: no leading `/`, no empty, `.` or `..` segment, no backslash or control character.
 */
export const adoptPathSchema = z.string().min(1).max(1024)
  .refine((p) => !p.startsWith('/') && !p.includes('\\') && ![...p].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f) && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..'), 'not a path inside the bucket');
export const adoptRequestSchema = registerRequestSchema.omit({ renditions: true }).extend({ path: adoptPathSchema });

export const searchQuerySchema = z.object({
  q: z.string().optional(), type: z.array(z.string()).optional(), subject: z.string().optional(), tag: z.array(z.string()).optional(),
  book: z.string().optional(), mine: z.boolean().optional(),
  minDuration: z.number().optional(), maxDuration: z.number().optional(), minWidth: z.number().optional(),
  limit: z.number().int().min(1).max(100).optional(), cursor: z.string().optional(),
});
export const pageOf = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), next: z.string().optional() });
export const searchResponseSchema = pageOf(assetRecordSchema);
export const storesResponseSchema = z.object({ items: z.array(storeDescriptorSchema) });
export const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

export type AssetRecord = z.infer<typeof assetRecordSchema>;
export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type RegisterRequest = z.infer<typeof registerRequestSchema>;
export type AdoptRequest = z.infer<typeof adoptRequestSchema>;

export class RegistryError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = 'RegistryError'; }
}

/**
 * A client for authoring tools. `add(file)` does the whole of registry-api §3: hash once, ask, upload only
 * what is missing, register.
 */
export function createRegistryClient(base: string, o: {
  /** A token (API key), or a function giving the current one (a sign-in: `libraryAuth(...).token`); a function is asked again once after a 401. */
  token?: TokenSource | undefined;
  fetch?: typeof fetch;
} = {}) {
  const f = o.fetch ?? globalThis.fetch.bind(globalThis);
  const root = base.endsWith('/') ? base : base + '/';
  async function call<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers as Record<string, string> | undefined) };
    const r = await fetchWithToken(f, o.token, root + path, { ...init, headers });
    const body = r.status === 204 ? null : await r.json().catch(() => null);
    if (!r.ok) { const e = errorSchema.safeParse(body); throw new RegistryError(r.status, e.success ? e.data.error.code : 'failed', e.success ? e.data.error.message : `HTTP ${r.status}`); }
    return schema.parse(body);
  }
  const post = <T>(path: string, schema: z.ZodType<T>, body: unknown) => call(path, schema, { method: 'POST', body: JSON.stringify(body) });
  return {
    check: (keys: string[]) => post('v1/assets/check', checkResponseSchema, checkRequestSchema.parse({ keys })),
    get: (k: string) => call(`v1/assets/${encodeURIComponent(k)}`, assetRecordSchema),
    batch: (keys: string[]) => post('v1/assets/batch', pageOf(assetRecordSchema), { keys }),
    search(q: SearchQuery) {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(searchQuerySchema.parse(q))) {
        if (v === undefined) continue;
        if (Array.isArray(v)) v.forEach((x) => p.append(k, String(x))); else p.set(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
      }
      return call(`v1/search?${p}`, searchResponseSchema);
    },
    stores: () => call('v1/stores', storesResponseSchema),
    /** Adopt a file already in the library's bucket at `path` (registry-api §3.1): verified by the library, never copied. */
    adopt: (req: AdoptRequest) => post('v1/assets/adopt', assetRecordSchema, adoptRequestSchema.parse(req)),
    setBookAssets: (bookId: string, keys: string[]) => call(`v1/books/${encodeURIComponent(bookId)}/assets`, z.unknown(), { method: 'PUT', body: JSON.stringify({ keys }) }),
    /** Hash, check, upload if missing, register: the record of the asset (new or existing). */
    async add(bytes: Uint8Array, info: { type: string; filename?: string } & Omit<RegisterRequest, 'key' | 'sha256' | 'size' | 'type'>): Promise<AssetRecord> {
      const { key: k, sha256: h } = await assetKeyAndSha256(bytes);   // the only hashing: once, on the author's machine
      const u = await post('v1/uploads', uploadResponseSchema, uploadRequestSchema.parse({ key: k, sha256: h, type: info.type, size: bytes.byteLength, ...(info.filename ? { filename: info.filename } : {}) }));
      if ('exists' in u) return u.asset as AssetRecord;
      const put = await f(u.upload.url, { method: 'PUT', headers: u.upload.headers ?? {}, body: bytes as unknown as BodyInit });
      if (!put.ok) throw new RegistryError(put.status, 'failed', `upload failed: HTTP ${put.status}`);
      return post('v1/assets', assetRecordSchema, registerRequestSchema.parse({ ...info, key: k, sha256: h, size: bytes.byteLength }));
    },
  };
}
export type RegistryClient = ReturnType<typeof createRegistryClient>;
