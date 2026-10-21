# Chalk 1.4: Streamed books

Status: draft · no model change (`formatVersion` stays 10) · builds on [1.0](../1.0/README.md), [1.2](../1.2/README.md)

A `.chalk` file holds the whole book, and a reader that downloads it must wait for all of it: fine for a lesson,
not for a 300-page textbook (40–60 MB) on a phone. A **streamed book** is the same book laid out as separate
files, so a reader can show the book at once from a small index and fetch only the pages around the one being
read.

Everything is a static file, so a CDN can cache it for every reader: a page one student opened is near the next
student already. The reader decides what to fetch (the pages around where the student is), not the server.

## 1. Terms

- **Streamed book:** a directory (on a bucket, a CDN, a school server) holding the files below.
- **Index:** `book.json`, the only file a reader needs before it can show the book.
- **Window:** the pages a reader keeps loaded around the current one (§5).

## 2. Layout

```
book.json                   the index (§3)
pages/<name>.json           one file per page: the page JSON of spec 1.0 §3.2
snips/<name>.json           one file per snip page
text.json                   optional: the searchable text of every page (§4)
assets/<storage key>        the book's own assets, by the storage key of spec 1.0 §3.5
```

- File names are the writer's choice and are listed in the index; readers MUST NOT guess them.
- Paths are relative to the index's URL. They MUST NOT be absolute, contain `..`, or start with `/`; readers
  refuse an index that has such a path.
- **Writers SHOULD name page, snip and text files by their content** (e.g. `pages/12-3f9a1c0e.json`) and assets
  are content-addressed already, so every file except the index can be cached for ever
  (`Cache-Control: public, max-age=31536000, immutable`). The index is revalidated (`no-cache` with an ETag, or
  a short `max-age`): it is how a reader learns that the book changed.

## 3. The index (`book.json`)

```json
{
  "format": "chalk.streamed", "streamVersion": 1, "formatVersion": 10,
  "id": "physics-9", "title": "পদার্থবিজ্ঞান", "locale": "bn",
  "createdAt": "2026-10-21T00:00:00Z", "updatedAt": "2026-10-21T00:00:00Z",
  "pages": [
    { "id": "p12", "file": "pages/12-3f9a1c0e.json", "title": "সরল দোলক", "label": "১২",
      "width": 1200, "height": 1699, "bytes": 2210, "thumb": "c1:…", "assets": ["c1:…", "c1:…"], "assetBytes": 81234 }
  ],
  "snipPages": [],
  "assets": [
    { "id": "c1:…", "type": "image/webp", "size": 76012, "path": "assets/c1_…" },
    { "id": "c1:…", "type": "video/mp4", "size": 18400211, "meta": { "duration": 94.5 } }
  ],
  "text": { "file": "text-8c1e44aa.json", "bytes": 48211 },
  "assetSources": []
}
```

| Field | | Meaning |
|---|---|---|
| `format`, `streamVersion` | required | `"chalk.streamed"`, `1`. A reader refuses a larger `streamVersion` it does not know |
| `formatVersion` | required | The model version of the page files (migrated as usual, spec 1.0 §6) |
| `id`, `title`, `locale`, `createdAt`, `updatedAt`, `coverAssetId` | | As in the lesson (spec 1.0 §3.1) |
| `pages[]` | required | In reading order. `id`, `file` required; `title` as in the page |
| `pages[].label` | | The page's printed number or name, for display ("১২", "iv"). Absent: its position, 1-based |
| `pages[].width`, `height` | | As in the page; absent means 1600 × 900. Lets a reader lay out every page before loading any |
| `pages[].bytes`, `assetBytes` | | Size of the page file, and of the assets it needs to be drawn (background and objects, not media a tap starts). For progress and for deciding how far ahead to load |
| `pages[].thumb` | | An asset id: a small picture of the page (a PDF page's `thumbnailAssetId`, or one the writer made) |
| `pages[].assets` | | The asset ids the page uses |
| `snipPages[]` | | Same shape, for snip pages |
| `assets[]` | | Every asset the book uses: `id`, `type`, optional `size`, `meta`, `renditions` (spec 1.2 §4). `path` present: the file is in this streamed book. Absent: external, found through stores (spec 1.2) |
| `text` | | The search file (§4) |
| `assetSources` | | Suggested stores (spec 1.2 §4.4), for external assets |

A reader turns the index into a lesson whose pages are **placeholders** (the right size, the thumbnail if any)
until their files arrive.

## 4. Searching without every page (`text.json`)

```json
{ "v": 1, "pages": { "p12": [ { "text": "সরল দোলক", "x": 120, "y": 88, "width": 300, "fontSize": 32 } ] } }
```

Per page id, the page's text layer and the text of its text objects, as text runs (spec 1.0 §3.2). A reader
loads it on the first search and searches every page with it; hits on pages not loaded yet are shown when those
pages arrive.

## 5. What a reader does (normative where it says MUST)

1. Fetch the index. Show the book: page count, labels, sizes, thumbnails (fetched as they come into view).
2. Load the **current page first**, then outward: next, previous, next but one, … up to the window, which the host
   sets (reference reader: 5 each way). A page is drawn once its file and background are in.
3. A jump (search hit, page number, thumbnail) loads the new page first: requests not started for pages outside
   the new window are dropped.
4. At most 6 requests at once (one HTTP/2 connection carries them).
5. Keep what was loaded (memory, and the device cache where the host allows) so going back is instant.
6. Page files MUST be validated like pages of a `.chalk` (spec 1.0); a page that fails is shown as missing, the
   rest of the book stays usable.
7. Assets: book-local ones from their `path`; content-addressed ones through host stores first (spec 1.2 §6),
   then the book's own copy, so books share media.

## 6. Converting

A `.chalk` file and a streamed book hold the same book: unpacking a `.chalk` into a streamed book and packing it
back gives the same lesson and the same assets. Authoring tools save `.chalk`; publishing turns it into a streamed
book (reference: `chalk-stream publish book.chalk out/`). An overlay (student notes, spec 1.0 §4) refers to the
book by id and version and applies to either form.

## 7. Inside a `.chalk` (byte ranges)

A `.chalk` MAY carry the same index as `stream.json`, its paths naming entries of the ZIP. A reader that can make
HTTP range requests can then read a `.chalk` at a URL like a streamed book: the end of the file (the ZIP's
central directory) tells where each entry is, and each page or asset is one range request. Assets are stored
uncompressed (spec 1.0 §3.5), so a range is the file itself. This needs no publishing step; a directory is still
better for caching (each file is cached alone). The reference reader reads directories first; ranges are next.

## 8. Conformance

- `schema/stream-index.schema.json`, `schema/stream-text.schema.json`.
- `conformance/streamed/`: the conformance book `valid/presentation.chalk` as a streamed book. Readers MUST open
  it; `packages/container` checks that publishing and packing back is lossless.
- Refused: an index with `..` or an absolute path, a `streamVersion` above 1, a page `file` not listed.
