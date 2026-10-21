# Chalk registry API, version 1

**Status:** Draft, part of [Chalk 1.2](README.md). The HTTP API between authoring tools and a **registry**:
the database of a library's assets (their keys, facts and locations) and the stores behind it. Students'
devices do not use it; they resolve assets through stores (1.2 §6). Request and response shapes are in
[`schema/registry.schema.json`](../../schema/registry.schema.json); a reference database is in
[registry.sql](registry.sql).

## 1. Conventions

- Base URL: the registry's, e.g. `https://store.example.org/`. Paths below are relative to it.
- JSON bodies, UTF-8. Times are ISO 8601 UTC.
- **Auth:** `Authorization: Bearer <token>`. How tokens are issued is up to the deployment. Reading the public
  library MAY be open; everything else needs a token.
- **Errors:** an HTTP status and `{ "error": { "code": "…", "message": "…" } }`. Codes: `invalid`,
  `unauthorized`, `forbidden`, `not_found`, `conflict`, `too_large`, `unsupported_type`, `verification_failed`,
  `gone`.
- **Pagination:** list endpoints return `{ items, next }`; pass `next` back as `cursor`. `next` absent means
  the end.

## 2. The asset record

What the registry knows about one asset:

```json
{
  "key": "c1:jf3zbfd5izthmdhdr46ab2csy4",
  "sha256": "497790947d4666760ce38f3c00e852c71fdb66cae849bae8e9ede352719e1581",
  "type": "model/gltf-binary", "size": 1556468,
  "meta": { "width": null, "height": null, "duration": null },
  "title": "Screw gauge · স্ক্রু গজ", "filename": "screw-gauge.glb",
  "tags": ["physics", "measurement"], "subject": "physics", "license": "CC BY 4.0",
  "poster": "c1:…", "renditions": ["c1:…"],
  "status": "available",
  "uploadedBy": "user-123", "createdAt": "2026-10-21T09:00:00Z",
  "locations": [{ "store": "media-r2", "path": "c1/jf/3z/jf3zbfd5izthmdhdr46ab2csy4" }]
}
```

`status` is `pending` (upload started, not yet verified), `available`, or `withdrawn` (§8). `locations` is
returned to authorised callers only.

## 3. Adding an asset

The author's tool hashes the file once, then:

1. **`POST v1/assets/check`** `{ "keys": ["c1:…", …] }` (up to 1,000)
   → `{ "present": ["c1:…"], "missing": ["c1:…"] }`.
   Present assets need no upload: the tool reuses them (the same file is stored once, whatever book it is in).
2. **`POST v1/uploads`** `{ "key", "sha256", "type", "size", "filename"? }`
   → `{ "upload": { "url", "method": "PUT", "headers": { … }, "expiresAt" }, "store": "media-r2" }`,
   or `{ "exists": true, "asset": { … } }` if it is already there.
   The URL is normally a pre-signed URL of the store's bucket at the standard layout (1.2 §5.2), so the bytes
   go from the author's machine to the bucket directly. The registry MUST check that `key` is the c1 key of
   `sha256` and MAY refuse types or sizes it does not accept (`unsupported_type`, `too_large`).
3. The tool uploads the bytes to `upload.url` with `upload.method` and `upload.headers`.
4. **`POST v1/assets`** `{ "key", "sha256", "type", "size", "meta"?, "title"?, "tags"?, "subject"?, "license"?,
   "filename"?, "poster"?, "renditions"? }` → the asset record, `status: "available"`.
   Before it answers, the registry MUST confirm the object exists at the location with the declared size, and
   MUST verify its SHA-256 (from the store, or a checksum the store computed on upload). On a mismatch it
   deletes the object and answers `verification_failed`.

Registering the same key again with the same `sha256` is not an error: it updates the descriptive fields
(title, tags, …) for callers allowed to, and returns the record.

## 4. Reading

- **`GET v1/assets/{key}`** → the asset record, or `not_found`.
- **`POST v1/assets/batch`** `{ "keys": […] }` (up to 1,000) → `{ "items": [record, …] }` (unknown keys are
  left out). For an authoring tool opening a book.

## 5. Searching the library

**`GET v1/search`** with query parameters:

| Parameter | Meaning |
|---|---|
| `q` | Text, matched against title, file name and tags, in any script. Registries SHOULD match parts of words and tolerate spelling variants (reference: trigram similarity), since there is no general-purpose Bengali stemmer. |
| `type` | A type pattern: `video/*`, `image/png`. Repeatable. |
| `subject`, `tag` | Exact match. `tag` is repeatable (all must match). |
| `book` | Only assets used by this book (§6). |
| `mine` | `1`: only the caller's uploads. |
| `minDuration`, `maxDuration`, `minWidth` | Numeric filters on `meta`. |
| `limit` | Up to 100 (default 30). |
| `cursor` | From the previous page's `next`. |

→ `{ "items": [record, …], "next"? }`, best matches first when `q` is given, newest first otherwise. Each
record carries its `poster` key so the tool can show thumbnails through the stores.

## 6. Which books use what

- **`PUT v1/books/{bookId}/assets`** `{ "keys": […] }` replaces the set of assets the book uses. Authoring tools
  call it when a book is saved or published.
- **`GET v1/assets/{key}/books`** → `{ "items": [{ "bookId", "updatedAt" }], "next"? }`.

A registry MAY delete the bytes of assets that no book has used for a period it chooses, unless they are
pinned. It MUST NOT delete an asset any book uses.

## 7. Stores for readers

**`GET v1/stores`** → `{ "items": [store descriptor, …] }`: the descriptors (1.2 §5.1) readers should use for
this registry's assets, in order. Apps fetch this when they start and pass it to their reader as its host
stores. It is public and cacheable.

## 8. Withdrawing an asset

**`POST v1/assets/{key}/withdraw`** `{ "reason" }` (privileged) sets `status: "withdrawn"`. From then on the
registry's API store answers `410 Gone` for the key, and stores it controls SHOULD delete the bytes. The
record is kept, so the same key cannot be uploaded again by mistake (`gone`).

## 9. Versioning

This is version 1 (`v1/` in every path). Later versions add endpoints and fields; clients MUST ignore fields
they do not know.
