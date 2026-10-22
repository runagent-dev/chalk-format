import { assetKey, type AssetMeta, type StoreDescriptor } from '@chalk-format/model';
import { matchesType } from './urls.js';

/**
 * Libraries: what authors connect to (spec 1.2 calls the online kind a registry). A library keeps an index of
 * media by key (title, type, size, poster, tags) and can hand out the bytes. Some can take new media (`put`);
 * some can tell readers where to fetch from on any device (`delivery`). The reader and the editor see only this
 * interface, whatever is underneath: this device, a folder, or a library server over R2/S3.
 */

/** One item in a library, as a gallery shows it. */
export type LibraryItem = {
  key: string;
  type: string;
  size: number;
  title?: string;
  filename?: string;
  tags?: string[];
  subject?: string;
  meta?: AssetMeta;
  /** A picture for the gallery (a video's poster, a model's render): another item's key. */
  poster?: string;
  createdAt?: string;
};

export type LibraryQuery = {
  /** Words to look for in titles, file names and tags (any script; case and Unicode form do not matter). */
  q?: string;
  /** Media type patterns: `video/*`, `model/gltf-binary`. */
  types?: string[];
  limit?: number;
  /** From the previous page's `next`. */
  cursor?: string;
};
export type LibraryPage = { items: LibraryItem[]; next?: string };

/** A new item for a library: its bytes and what to know it by. */
export type NewItem = {
  bytes: Uint8Array;
  type: string;
  filename?: string;
  title?: string;
  tags?: string[];
  subject?: string;
  meta?: AssetMeta;
  poster?: string;
};

export type LibraryStatus = 'ok' | 'offline' | 'sign-in' | 'no-permission';

/** How to connect a library again (after a reload, or on another visit): what a host saves. Never put in a book. */
export type LibraryConnection =
  | { kind: 'device' }
  | { kind: 'folder'; handle: FileSystemDirectoryHandle }
  | { kind: 'registry'; url: string; name?: string; token?: string };

export interface Library {
  /** Stable across sessions on this device (the id a host saves the connection under). */
  readonly id: string;
  /** What people see: "This device", "PathshalaX library", a folder's name. */
  readonly name: string;
  readonly kind: string;
  /** Whether `put` will work (writable, and allowed for this user). */
  readonly writable: boolean;
  search(q: LibraryQuery): Promise<LibraryPage>;
  /** One item's facts, or null. */
  item(key: string): Promise<LibraryItem | null>;
  /** The bytes, or null if this library does not have them. */
  get(key: string): Promise<{ bytes: Uint8Array; type: string } | null>;
  /** A URL to draw or stream the item from (no download first), or null. */
  url(key: string): Promise<string | null>;
  /** Which of these keys the library has. */
  has(keys: readonly string[]): Promise<Set<string>>;
  /** Add an item; the same bytes give the same key, so adding twice adds once. */
  put?(item: NewItem): Promise<LibraryItem>;
  /** Where readers on any device can fetch this library's items (spec 1.2 store), if anywhere. */
  delivery?(): Promise<StoreDescriptor | null>;
  status?(): Promise<LibraryStatus>;
  /** Ask the user again for access (a folder after a reload); needs a click or a tap to call it from. */
  connect?(): Promise<void>;
  /** How to connect it again, for hosts that keep the list. */
  readonly connection?: LibraryConnection;
  dispose?(): void;
}

/** Lower case, NFC, ASCII and Bengali digits alike: what search compares. */
export function fold(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(/[০-৯]/g, (d) => String('০১২৩৪৫৬৭৮৯'.indexOf(d)));
}

/** Search in memory (device and folder libraries): every word must match title, file name, tags or subject. */
export function searchItems(all: readonly LibraryItem[], q: LibraryQuery): LibraryPage {
  const words = fold(q.q ?? '').split(/\s+/).filter(Boolean);
  const hits = all.filter((it) => {
    if (q.types?.length && !matchesType(q.types, it.type)) return false;
    if (!words.length) return true;
    const text = fold([it.title, it.filename, it.subject, ...(it.tags ?? [])].filter(Boolean).join(' '));
    return words.every((w) => text.includes(w));
  });
  // newest first
  hits.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  const start = Number(q.cursor ?? 0) || 0, limit = q.limit ?? 60;
  const page = hits.slice(start, start + limit);
  return start + limit < hits.length ? { items: page, next: String(start + limit) } : { items: page };
}

/** An item's facts from its bytes and what the author said about it. */
export async function itemFor(n: NewItem): Promise<LibraryItem> {
  return {
    key: await assetKey(n.bytes), type: n.type, size: n.bytes.byteLength,
    ...(n.title ? { title: n.title } : {}), ...(n.filename ? { filename: n.filename } : {}),
    ...(n.tags?.length ? { tags: n.tags } : {}), ...(n.subject ? { subject: n.subject } : {}),
    ...(n.meta ? { meta: n.meta } : {}), ...(n.poster ? { poster: n.poster } : {}),
    createdAt: new Date().toISOString(),
  };
}

/**
 * Reading through libraries: the first that has an item, in the order given. A URL where a library can give one
 * (it streams, and caches like any web file), else its bytes. What no library has is "not found" (null).
 */
export function libraryResolver(libraries: () => readonly Library[]) {
  return async (key: string): Promise<string | Blob | null> => {
    for (const lib of libraries()) {
      try {
        const u = await lib.url(key);
        if (u) return u;
        const b = await lib.get(key);
        if (b) return new Blob([b.bytes as BlobPart], { type: b.type });
      } catch {
        // an unreachable library is passed over; the next one may have it
      }
    }
    return null;
  };
}
