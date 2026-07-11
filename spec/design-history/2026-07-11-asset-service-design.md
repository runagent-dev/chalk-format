# AssetService — content-addressed cache + cloud (design)

**Date:** 2026-07-11
**Status:** Design. A minimal read slice ships in PR #21; the rest is
tracked as an issue (needs the backend).

## The model

Every asset's identity is its content hash (`sha256:…`). The document
stores only the hash; the bytes live keyed by that hash. A reference is
therefore a **promise** — "bytes with this hash exist" — that any source
can satisfy, and the client verifies for free (hash the bytes, compare).
Source-independence + free verification is what makes the cache/cloud
ladder work.

## The resolution ladder — `AssetService.get(hash)`

One call the whole app uses; it never branches on local-vs-remote:

1. **In-memory** (decoded this session) → return. µs.
2. **On-device persistent cache** (IndexedDB metadata + OPFS blobs) →
   read. ms. No staleness check needed — a matching hash is correct
   forever.
3. **Cloud** → `GET <base>/assets/<hash>`, **verify the hash**, write to
   the persistent cache, return. One network round-trip; instant
   thereafter.

First view streams (slow once); every later view is local. Pinning a
lesson = pre-fetch all its hashes into the cache → fully offline.

## Interface (extends the sketch in plan §8A.4)

```ts
interface AssetService {
  get(id): Promise<Blob>;             // ladder above
  has(id): Promise<boolean>;
  prefetch(ids): Promise<void>;       // batch, resumable
  pin(lessonId): Promise<void>;       // fetch + protect all lesson assets
  unpin(lessonId): Promise<void>;
  usage(): Promise<{ used; quota }>;
  evictLRU(targetBytes): Promise<void>;
}
```

`referencedAssetIds(lesson)` (already in `@chalkbook/core`) feeds
`pin`/`prefetch`. `assetStorageKey(id)` (already in `@chalkbook/format`)
is the one path scheme shared by packer, uploader, and resolver.

## Bundles: fat vs thin

- **Fat** `.chalk` (today): assets inlined — self-contained, portable.
- **Thin** `.chalk`: references only; the manifest lists asset ids
  without bytes (`unpackLesson` already returns `missingAssetIds`), and
  `AssetService.get` resolves them. Export offers a fat/thin choice.

## Upload — "with validations"

Uploading user bytes to a **shared** store is not neutral:

- **Guards:** size/MIME limits, malware scan.
- **Rights (the hard one):** dedup + hosting = redistribution. Every
  upload carries provenance + license; every fetch is entitlement-
  checked. CC/public-domain → served without auth, cacheable forever;
  school-purchased / publisher-paid → gated per user/org, server issues
  bytes or a short-lived signed URL only after the check. Content
  addressing answers "right bytes"; entitlement answers "allowed to have
  them" — both are needed.
- **Scope:** the same hash can exist public / org / private; visibility
  is the entitlement check, not the address. A teacher's private photo
  must not dedup into a public pool.

## What ships now (PR #21) — the read slice

- `resolveAssetUrl(id, localUrl)`: local blob URL, else deterministic
  public cloud URL `<VITE_CONTENT_BASE_URL>/assets/<hash>`. Wired into
  the renderer. Public content only; browser HTTP cache is the (coarse)
  persistent tier; no hash verification yet (we trust our own bucket
  over HTTPS).
- `content-cli push-assets <book.chalk>`: uploads a lesson's assets
  content-addressed (local dir or `--remote` S3) to populate the bucket.

## What's tracked as the issue (needs the backend)

- OPFS/IndexedDB **persistent cache** + **hash verification** on fetch.
- Browser-side **upload** (with the validations above) — needs a server.
- **Entitlement / auth / scopes** (public/org/private, signed URLs).
- **Pin / offline** pre-warm + storage-usage panel + resumable prefetch.
- **Fat↔thin** export toggle; **posters/placeholders** while streaming.
- **Garbage collection**: reap cloud blobs referenced by no lesson;
  client-cache LRU eviction under quota.
- Swap `resolveAssetUrl` for the full `AssetService.get` ladder behind
  the same call sites.

## What the maintainer provides (S3-compatible storage)

Same shape as `tools/content-cli/.env` — endpoint, region, bucket,
access key id, secret, and a **public read** base URL (bucket public-read
or a CDN / r2.dev domain). Set `VITE_CONTENT_BASE_URL` (web) to that
public base. Then `push-assets --remote` populates `assets/<hash>` and
the app resolves references from the cloud.
