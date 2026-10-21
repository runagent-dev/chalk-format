import { resolutionKey, type StoreDescriptor } from '@chalk-format/model';

/** The 26-character hash part of a c1 key. */
export const hashPart = (key: string) => key.slice(3);
/** The index shard a key belongs to: the hash part's first two characters (spec 1.2 §5.3). */
export const shardOf = (key: string) => key.slice(3, 5);

/** The standard bucket layout (spec 1.2 §5.2): c1/{h0}/{h1}/{h}. Registries put new uploads here. */
export const STANDARD_LAYOUT = 'c1/{h0}/{h1}/{h}';
export function standardPath(key: string): string { return fill(STANDARD_LAYOUT, key); }

function fill(template: string, key: string): string {
  const h = hashPart(key);
  return template
    .replaceAll('{key}', encodeURIComponent(key))
    .replaceAll('{h}', h).replaceAll('{h0}', h.slice(0, 2)).replaceAll('{h1}', h.slice(2, 4));
}

/** The URL of an asset in a derived store; the key must be a resolution key (c1). */
export function derivedUrl(store: StoreDescriptor, key: string): string {
  if (!store.template) throw new Error(`store ${store.id} has no template`);
  return fill(store.template, key);
}

/** The URL of an index shard of an indexed store. */
export const shardUrl = (store: StoreDescriptor, key: string) => `${store.base}index/${shardOf(key)}.json`;

/** The resolve endpoint of an API store (spec 1.2 §5.4). */
export const apiUrl = (store: StoreDescriptor, key: string) => `${store.base}v1/a/${encodeURIComponent(key)}`;

/** Does a type match a store's `media` patterns? Absent patterns match everything. */
export function matchesType(patterns: readonly string[] | undefined, type: string): boolean {
  if (!patterns || patterns.length === 0) return true;
  const [t, s] = type.toLowerCase().split(';')[0]!.trim().split('/');
  return patterns.some((p) => { const [pt, ps] = p.split('/'); return (pt === '*' || pt === t) && (ps === '*' || ps === s); });
}

/** A content-addressed id as the stores know it, or null (ids that only live inside a book). */
export const storeKey = (id: string) => resolutionKey(id);
