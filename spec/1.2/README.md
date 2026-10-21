# Chalk 1.2: Asset stores

**Status:** Draft. Extends [Chalk 1.0 Core](../1.0/README.md) and [Chalk 1.1](../1.1/README.md); everything
there still applies. Model `formatVersion` 9. A file valid under 1.1 is valid under 1.2 unchanged.

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

Companion documents:
- [registry-api.md](registry-api.md): the HTTP API authoring tools use to upload, find and register assets.
- [registry.sql](registry.sql): a reference database schema for a registry (informative).

## 1. Why

A book's media does not have to travel inside the book. Video, sound, 3D models and page images are most of a
book's weight, and the same file (a screw gauge model, a pendulum video) appears in many books. In 1.0 a
*thin* book could leave assets out (`inline: false`) but did not say where to fetch them from.

1.2 defines that missing layer:

- **Assets have short keys** (§3), computed once when the book is made. A book refers to media only by key.
- **Stores** (§5) turn a key into the asset's bytes: a bucket where the path *is* the key, a server with an
  index, or an API. There can be many, per media type, in priority order.
- **Readers** (§6) find an asset with no database and no searching: a cache lookup, then one request to the
  first store that should have it. This has to be fast and light on a cheap phone.
- **A registry** ([registry-api.md](registry-api.md)) is where authoring tools upload media, check what already
  exists, search the library, and record which books use what. Only authoring tools talk to it; students'
  devices never do.

## 2. Terms

| Term | Meaning |
|---|---|
| **Asset** | A file a book uses: an image, a rendered page, a PDF, a video, audio, a model, a lab entry. |
| **Key** | The asset's identifier, derived from its bytes (§3). The same bytes always have the same key. |
| **Store** | Something that returns an asset's bytes given its key (§5). Described by a store descriptor. |
| **Location** | Where one store keeps one asset (a path in a bucket). |
| **Registry** | The authoring-side database of assets, their facts and locations, behind an HTTP API. |
| **Resolver** | The reader's part that turns a key into bytes, using its cache and the stores (§6). |
| **Rendition** | One version of a media item: the 360p and 720p files of the same video (§4.3). |

## 3. Asset keys

### 3.1 Format

A **c1 key** is `c1:` followed by the first 128 bits (16 bytes) of the SHA-256 digest of the asset's bytes,
written in base32 (RFC 4648 alphabet, lower case, no padding): 26 characters.

```
key = "c1:" + lowercase(base32(sha256(bytes)[0:16]))      e.g.  c1:jf3zbfd5izthmdhdr46ab2csy4
```

- 128 bits make 25.6 base32 characters, so the 26th character carries the last 3 bits followed by two zero
  bits. A key is valid only in this canonical form: `^c1:[a-z2-7]{25}[aeimquy4]$`.
- Keys are case-sensitive. A writer MUST NOT produce, and a reader MUST reject, a key in any other case or
  length.
- The **hash part** `h` is the 26 characters after `c1:`; `h0` is its first two characters, `h1` the next two
  (used for paths and index shards, §5).

### 3.2 Test vectors

| Bytes | sha256 | c1 key |
|---|---|---|
| empty | `e3b0c442…7852b855` | `c1:4oymiquy7qobjgx36tejs35zeq` |
| `abc` (ASCII) | `ba7816bf…f20015ad` | `c1:xj4bnp4pahh6uqkbidpf3lrcem` |
| `বিজ্ঞান` (UTF-8) | `80310060…e45639c3` | `c1:qayqayetmef5e5nr5gqwedtnwi` |
| the 1×1 PNG of the conformance corpus | `49779094…719e1581` | `c1:jf3zbfd5izthmdhdr46ab2csy4` |

The full digests are in [`conformance/keys.json`](../../conformance/keys.json); implementations MUST
reproduce them.

### 3.3 Keys and 1.0 ids

- 1.0 content-addressed ids (`sha256:` + 64 hex digits) stay valid everywhere a key is allowed.
- **Every sha256 id has a c1 key, computed without the bytes:** take the first 32 hex digits, decode them to
  16 bytes and encode as above. This is the asset's **resolution key**: stores (§5) are organised by c1 keys
  only, so books with either form of id resolve through the same stores.
- Writers SHOULD use c1 keys for new books. Ids that are neither (1.0 allowed any string for inline assets)
  are not content-addressed: they can only travel inside the book and never resolve through a store.

### 3.4 Why 128 bits

- **Uniqueness.** The chance that any two of *n* different files share a key is about n² / 2¹²⁹: about
  10⁻¹⁵ for a trillion files. Accidental collisions are not a practical concern.
- **Integrity.** A reader that checks downloaded bytes against the key (§6.4) cannot be given a different
  file: finding other bytes with a given 128-bit prefix (a second preimage) takes about 2¹²⁸ work.
- **The limit.** Someone with very large computing power (about 2⁶⁴ hash computations) could prepare *two*
  files sharing a key and later swap one for the other in a store they control. Registries keep the full
  SHA-256 (registry-api.md §3) and check it on upload; a deployment that must rule this out uses sha256 ids
  for its own books.
- **Compute once.** Keys are made when an asset is added to a library or a book. A student's device never
  computes a key to find an asset; it only looks keys up. It hashes bytes only to verify them (§6.4).

## 4. The book (formatVersion 9)

### 4.1 Asset ids

Wherever 1.0 or 1.1 takes a content-addressed asset id (`assetId`, `poster`, `renderedImageAssetId`,
`thumbnailAssetId`, `coverAssetId`, `lab.entry`, `lab.assets`), a c1 key is allowed. A book MAY mix both
forms. Path escaping in the package is unchanged (1.0 §3.5): `c1:abc…` is stored at `assets/c1_abc…`.

### 4.2 Asset facts in the manifest

Entries of `manifest.assets` (1.0 §3.1) gain optional fields, so a reader can lay out pages, show download
sizes and choose renditions before fetching anything:

| Field | Type | Meaning |
|---|---|---|
| `size` | integer | Bytes. Writers SHOULD give it for every asset, and MUST for external ones. |
| `meta` | object | `width`, `height` (pixels), `duration` (seconds), `pages` (a PDF). All optional. |
| `renditions` | array | Other versions of the same media item (§4.3). |

```json
{ "id": "c1:p5x…", "type": "video/mp4", "path": "assets/c1_p5x…", "inline": false, "size": 18400211,
  "meta": { "width": 1280, "height": 720, "duration": 94.5 },
  "renditions": [
    { "id": "c1:r2a…", "type": "video/mp4", "size": 6100022, "meta": { "width": 640, "height": 360 } },
    { "id": "c1:k7q…", "type": "video/webm", "size": 5200400, "meta": { "width": 640, "height": 360 } }
  ] }
```

### 4.3 Renditions

Objects refer to the entry's own `id` (the **primary**). `renditions` lists alternatives a reader MAY use
instead: smaller video for a phone on mobile data, a WebM where MP4 cannot play, a smaller image for a
thumbnail. A rendition gives its key, `type`, and optionally `size` and `meta`. Whether the book carries it is
answered as for any asset: a rendition the book carries has its own entry in `manifest.assets` (with `path`
and `inline`); one without an entry is external and found through the stores (§6).

A reader SHOULD choose by: types it can decode, then the smallest one at least as large as it will be drawn
(the box size times the device pixel ratio), then smaller sizes when the user saves data (`Save-Data`, a slow
connection). With no fitting rendition it uses the primary.

### 4.4 Suggested stores

`manifest.assetSources` (optional): store descriptors (§5.1) the book's publisher suggests. They are the
last place a reader looks (§6.1), after its own cache and the stores its host configured. They MUST have
`auth: "none"`: a book carries no credentials.

### 4.5 Bundles

1.0's `bundling: "fat" | "thin"` stays. A thin book's external assets (`inline: false`) are found through §6.
Only content-addressed assets may be external (1.0 §3.5); c1 keys are content-addressed. A writer MAY carry a
book's small assets inline and leave large media to stores.

## 5. Stores

### 5.1 Store descriptors

A store is described by a JSON object (schema: [`schema/store.schema.json`](../../schema/store.schema.json)):

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | A name for the store, unique among the stores a reader uses. |
| `kind` | `"derived"` \| `"indexed"` \| `"api"` | yes | How keys become URLs (§5.2–5.4). |
| `template` | string | `derived` | URL template (§5.2). |
| `base` | string | `indexed`, `api` | Base URL, ending in `/`. |
| `media` | array of type patterns | no | What it serves: `"video/mp4"`, `"video/*"`, `"*/*"`. Absent means everything. |
| `priority` | integer | no | Lower is tried first. Absent means 100. Ties keep list order. |
| `verify` | `"always"` \| `"first"` \| `"none"` | no | Byte checking for this store (§6.4). Absent means `"first"`. |
| `auth` | `"none"` \| `"bearer"` | no | `bearer`: the host supplies a token (never the book). Absent means `"none"`. |

Readers MUST ignore descriptor fields they do not know, and MUST skip a descriptor whose `kind` they do not
know.

### 5.2 Derived stores

The URL is computed from the key: no index, no lookup. `template` contains placeholders:

| Placeholder | Becomes |
|---|---|
| `{key}` | the whole key, `c1:jf3z…` (as `c1%3Ajf3z…` where a URL needs it encoded) |
| `{h}` | the hash part, 26 characters |
| `{h0}`, `{h1}` | its characters 1–2 and 3–4 |

The **standard layout**, which registries SHOULD use for new uploads, is `{base}c1/{h0}/{h1}/{h}`:
`https://media.example.org/c1/jf/3z/jf3zbfd5izthmdhdr46ab2csy4`. The two directory levels keep any one
directory small in file-based stores.

### 5.3 Indexed stores

For assets already sitting at arbitrary paths (an existing bucket, a school server). The store publishes a
**sharded index**: for each `h0` (1,024 possible), a file `{base}index/{h0}.json`
(schema: [`schema/index-shard.schema.json`](../../schema/index-shard.schema.json)):

```json
{ "v": 1, "entries": { "jf3zbfd5izthmdhdr46ab2csy4": { "p": "physics/class9/gauge.glb", "s": 1556468, "t": "model/gltf-binary" } } }
```

- `p` is the asset's path relative to `base`, or an absolute URL. `s` (size) and `t` (type) are optional.
- A missing shard (HTTP 404) means the store has no assets in it.
- A reader fetches one shard only when it first needs a key in it, and caches it. The 1,024-way split keeps
  each shard small (a store of a million assets has about a thousand entries per shard, under 100 KB).
- Stores SHOULD serve shards with an `ETag` and a short cache lifetime, and assets with a long one.

### 5.4 API stores

`GET {base}v1/a/{key}` answers with the bytes (200), a redirect to them (302, 303, 307), `404` (not here) or
`410` (taken down, registry-api.md §8). It is how a registry with private buckets serves readers: the
redirect goes to a short-lived signed URL. With `auth: "bearer"` the reader sends
`Authorization: Bearer <token>` from its host.

### 5.5 Requirements for all stores

- **Immutable:** the bytes at a key never change. Stores SHOULD send
  `Cache-Control: public, max-age=31536000, immutable` for public assets.
- **Range requests:** stores SHOULD support `Range` for audio and video.
- **CORS:** a store used from browsers MUST answer `GET` with `Access-Control-Allow-Origin` (`*` for public
  stores) and expose `Content-Length`, `Content-Range` and `ETag`.
- **Type:** stores SHOULD send the right `Content-Type`; readers use the manifest's `type` regardless.

## 6. Resolution (readers)

### 6.1 Where a reader looks, in order

1. **The book itself**, when the asset is inline: no network.
2. **The device's cache**, by resolution key (§3.3).
3. **The host's stores**: descriptors the app or school configures (a classroom server first, then the cloud).
4. **The book's suggested stores** (`assetSources`, §4.4).

Within 3 and 4: stores whose `media` matches the asset's type (from the manifest), by `priority`, then in
the order given. Host stores always come before book stores, whatever their priorities.

### 6.2 Doing it cheaply

A reader:

- MUST build the list of eligible stores per media type **once per book**, not per asset.
- MUST try stores **one after another**, never asking two stores for the same asset at once, and moves to
  the next store only on `404`, `410`, a network error or a 5xx. After a network error or 5xx it SHOULD skip
  that store for a while (reference: 60 seconds).
- SHOULD limit concurrent asset downloads (reference: 4) and fetch assets for pages near the one shown first.
- SHOULD keep index shards in memory only while needed and in its cache afterwards.
- MUST NOT compute keys to find assets; hashing is only for verification (§6.4).

So finding an asset is a cache lookup and, when it is not cached, one request (two for an indexed store
whose shard is not cached yet).

### 6.3 When nothing has it

The asset is **unavailable**: the reader shows the object's poster, or a neutral card, and says the media
is not available (offline, or not found). It MUST NOT fail to open the book. Readers SHOULD offer to retry.

### 6.4 Verifying bytes

A reader checks bytes by hashing them with SHA-256 and comparing the first 16 bytes with the key (all 32
bytes for a sha256 id). When:

| Asset | Rule |
|---|---|
| Lab entries (`text/html`) | MUST be verified before running, from any source (1.1 §3.3). |
| From a store with `verify: "always"` | MUST be verified on every download. |
| From a store with `verify: "first"` (default) | MUST be verified once, before it goes into the device cache; cached bytes are trusted. |
| From a store with `verify: "none"` | MAY be used unverified (a store the host fully trusts, such as its own CDN). |
| Streamed audio and video | MAY play while downloading; verified when complete, before caching. |

Bytes that fail verification MUST be discarded and the next store tried; the reader SHOULD report the
store. Hashing is done once per asset per device, with the platform's native SHA-256 (tens of milliseconds
for 10 MB on a phone).

### 6.5 The device cache

- Keyed by resolution key; entries never go stale (§5.5), so no revalidation.
- Readers SHOULD let the user download a book or chapter for offline use (all its assets, with the total from
  `size`, §4.2) and SHOULD evict least-recently-used media first when storage runs short, never assets of a
  book the user downloaded.

## 7. Security and privacy

- **Books carry no secrets.** No tokens, no signed URLs in `assetSources`; signed URLs come from an API store
  at request time and expire.
- **Untrusted stores are safe** for any asset a reader verifies (§6.4): a classroom server, a USB drive or a
  peer can serve media without being trusted.
- **Privacy.** Fetching assets reveals what a student reads to every store asked. Readers SHOULD prefer
  stores the host configured and SHOULD NOT send identifying data in asset requests; stores SHOULD keep
  request logs only as long as they need them.
- **Takedown.** A registry can withdraw an asset (registry-api.md §8): its stores then answer `410`, and readers
  treat it as unavailable. Copies already in device caches are not recalled.

## 8. Compatibility

- 1.0 and 1.1 readers ignore the new manifest fields (1.0 §3.1). They open a 1.2 book whose assets are inline
  regardless of id form, since ids other than lab entries are plain strings to them.
- A **lab entry or lab asset with a c1 key** is not valid for a 1.1 reader (1.1 requires `sha256:` there).
  Writers that must support 1.1 readers use sha256 ids for labs.
- A 1.1 reader cannot fetch a thin book's external assets (it has no stores); it shows them as missing, as
  1.0 allows for thin bundles.
- Migration from `formatVersion` 8 to 9 is the identity.

## 9. Conformance

- **Keys:** an implementation reproduces every vector in `conformance/keys.json` and accepts or rejects every
  string in its `valid` and `invalid` lists.
- **Readers** accept `conformance/valid/c1-keys.chalk` and `valid/thin-sources.chalk`, reject the
  `invalid/c1-*` cases, and resolve external assets through §6 (the reference resolver's tests in
  `packages/store` are the executable form).
- **Stores** follow §5.5; their descriptors and index shards validate against the JSON Schemas.
- **Registries** implement registry-api.md.
