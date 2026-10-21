import { unpackLesson, type AssetBundle, type UnpackInput } from '@chalk-format/container';
import type { Lesson } from '@chalk-format/model';

/** Where a book comes from: its bytes, a File/Blob, or a URL to fetch. */
export type BookSource = UnpackInput | string | URL;

/** Fetch an asset the book does not carry (thin bundles, spec 1.0 §3.5): a URL, a Blob, or null. */
export type AssetResolver = (assetId: string) => string | Blob | null | Promise<string | Blob | null>;

/** An open book: the lesson and a way to reach every asset it uses. */
export type Book = {
  lesson: Lesson;
  /** Asset ids the package declares but does not carry (thin bundle), before any resolver ran. */
  missingAssetIds: string[];
  /** A URL to draw the asset with (a `blob:` URL for carried bytes), or null if it is not available. */
  assetUrl(assetId: string): Promise<string | null>;
  /** The asset's bytes and type, for consumers that need bytes (labs, 3D). */
  assetBytes(assetId: string): Promise<{ type: string; bytes: ArrayBuffer } | null>;
  /** Already-resolved URL, or undefined while still unknown (lets renders avoid a flash). */
  peekUrl(assetId: string): string | null | undefined;
  /** Free the blob: URLs. The book is unusable afterwards. */
  dispose(): void;
};

export async function openBook(source: BookSource, o: { resolveAsset?: AssetResolver } = {}): Promise<Book> {
  let input: UnpackInput;
  if (typeof source === 'string' || source instanceof URL) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`could not fetch the book (${res.status})`);
    input = new Uint8Array(await res.arrayBuffer());
  } else input = source;
  const { lesson, assets, missingAssetIds } = await unpackLesson(input);
  return bookFrom(lesson, assets, missingAssetIds, o.resolveAsset);
}

/** A Book over an already-unpacked lesson (an app that holds the lesson in memory). */
export function bookFrom(lesson: Lesson, assets: AssetBundle, missingAssetIds: string[] = [], resolveAsset?: AssetResolver): Book {
  const urls = new Map<string, Promise<string | null>>();
  const settled = new Map<string, string | null>();
  const owned: string[] = [];
  const buffers = new Map<string, ArrayBuffer>();
  let disposed = false;

  const blobUrl = (blob: Blob) => { const u = URL.createObjectURL(blob); owned.push(u); return u; };
  async function resolve(id: string): Promise<string | null> {
    const carried = assets.get(id);
    if (carried) return blobUrl(new Blob([carried.bytes as BlobPart], { type: carried.type }));
    if (!resolveAsset) return null;
    const r = await resolveAsset(id);
    if (r == null) return null;
    return typeof r === 'string' ? r : blobUrl(r);
  }
  return {
    lesson,
    missingAssetIds,
    assetUrl(id) {
      if (disposed) return Promise.resolve(null);
      let u = urls.get(id);
      if (!u) {
        u = resolve(id).catch(() => null).then((v) => { settled.set(id, v); return v; });
        urls.set(id, u);
      }
      return u;
    },
    peekUrl: (id) => settled.get(id),
    async assetBytes(id) {
      const carried = assets.get(id);
      if (carried) {
        // one buffer per asset, handed out every time (the lab host copies before transferring, and hashes once)
        let b = buffers.get(id);
        if (!b) { b = carried.bytes.slice().buffer as ArrayBuffer; buffers.set(id, b); }
        return { type: carried.type, bytes: b };
      }
      const url = await this.assetUrl(id);
      if (!url) return null;
      const res = await fetch(url);
      if (!res.ok) return null;
      return { type: res.headers.get('content-type') ?? 'application/octet-stream', bytes: await res.arrayBuffer() };
    },
    dispose() { disposed = true; owned.forEach((u) => URL.revokeObjectURL(u)); owned.length = 0; urls.clear(); settled.clear(); buffers.clear(); },
  };
}
