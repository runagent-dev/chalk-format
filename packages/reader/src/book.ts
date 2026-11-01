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
  /**
   * A URL drawn for an asset failed to load (`failed`), or resolving it failed (`failed` null): the book forgets that answer, and what
   * told it where the asset is, and resolves it once more. Another element that failed on the same URL gets the same new answer (it is
   * resolved once). The URL from the new answer on is what `assetUrl` and `peekUrl` give. A failed URL that is not the book's current one
   * any more gets the current one; an asset whose answer was "not available" (not a failure) is not asked again. Optional: a book without
   * it keeps its first answers.
   */
  renewUrl?(assetId: string, failed: string | null): Promise<string | null>;
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

  // ids whose resolution failed (the resolver threw): `renewUrl(id, null)` asks again only for these
  const errored = new Set<string>();
  const blobUrl = (blob: Blob) => { const u = URL.createObjectURL(blob); owned.push(u); return u; };
  async function resolve(id: string): Promise<string | null> {
    const carried = assets.get(id);
    if (carried) return blobUrl(new Blob([carried.bytes as BlobPart], { type: carried.type }));
    if (!resolveAsset) return null;
    const r = await resolveAsset(id);
    if (r == null) return null;
    return typeof r === 'string' ? r : blobUrl(r);
  }
  const assetUrl = (id: string): Promise<string | null> => {
    if (disposed) return Promise.resolve(null);
    const kept = urls.get(id);
    if (kept) return kept;
    errored.delete(id);
    const u: Promise<string | null> = resolve(id).then((v) => ({ v, e: false }), () => ({ v: null, e: true })).then(({ v, e }) => {
      // an answer renewed while this one was on its way is not overwritten by it
      if (urls.get(id) === u) { settled.set(id, v); if (e) errored.add(id); }
      return v;
    });
    urls.set(id, u);
    return u;
  };
  const renewUrl = (id: string, failed: string | null): Promise<string | null> => {
    // carried bytes (a blob: URL of this page) and a book with no resolver have nothing to renew
    if (disposed || assets.has(id) || !resolveAsset) return assetUrl(id);
    if (stale(urls, settled, errored, id, failed)) { urls.delete(id); settled.delete(id); }
    return assetUrl(id);
  };
  return {
    lesson,
    missingAssetIds,
    assetUrl,
    peekUrl: (id) => settled.get(id),
    renewUrl,
    async assetBytes(id) {
      const carried = assets.get(id);
      if (carried) {
        // one buffer per asset, handed out every time (the lab host copies before transferring, and hashes once)
        let b = buffers.get(id);
        if (!b) { b = carried.bytes.slice().buffer as ArrayBuffer; buffers.set(id, b); }
        return { type: carried.type, bytes: b };
      }
      let url = await assetUrl(id);
      if (!url) return null;
      let res = await fetch(url).catch(() => null);
      // the URL failed (it expired, the file moved): renewed once
      if (!res?.ok) { const again = await renewUrl(id, url); if (again && again !== url) { url = again; res = await fetch(url).catch(() => null); } }
      if (!res?.ok) return null;
      return { type: res.headers.get('content-type') ?? 'application/octet-stream', bytes: await res.arrayBuffer() };
    },
    dispose() { disposed = true; owned.forEach((u) => URL.revokeObjectURL(u)); owned.length = 0; urls.clear(); settled.clear(); buffers.clear(); },
  };
}

/**
 * Whether a cached answer for `id` is the one that failed, so it is to be resolved again: a URL still being resolved (another element
 * renewed it already) or a different current URL is not; nor is "not available" (null) unless its resolution failed.
 */
export function stale(urls: ReadonlyMap<string, Promise<string | null>>, settled: ReadonlyMap<string, string | null>, errored: ReadonlySet<string>, id: string, failed: string | null): boolean {
  if (!urls.has(id)) return true;
  if (!settled.has(id)) return false;
  const now = settled.get(id);
  return failed === null ? now === null && errored.has(id) : now === failed;
}
