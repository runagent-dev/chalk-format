# Chalk 1.0 Core

**Status:** Draft. Describes the format exactly as produced and read by the reference implementation at
`formatVersion` 7. Every file that conforms to this document stays valid in all later 1.x versions.

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## 1. Overview

A `.chalk` file is a ZIP archive holding an interactive book: an ordered list of pages, each with a
background and positioned objects on top, plus the binary assets they reference. Assets can travel inside
the file ("fat") or be referenced by content hash and fetched from elsewhere ("thin").

There are two package kinds:

- **Lesson package**: a complete book (`manifest.json` + `pages/` + optional `snip-pages/` + `assets/`).
- **Overlay package**: a user's changes over a read-only lesson (`manifest.json` + `overlay.json` + `assets/`).

The normative data model is the JSON Schema in [`/schema`](../../schema), generated from
`packages/model/src/schema.ts`. Where this text and the schema disagree, the schema wins.

## 2. Container

- The file MUST be a ZIP archive. Extension `.chalk`. Media type (proposed): `application/vnd.chalk+zip`.
- `manifest.json` MUST be at the root.
- All paths are relative to the archive root, use `/`, and MUST NOT contain `..`.
- Writers SHOULD compress JSON entries (DEFLATE) and SHOULD store asset entries uncompressed (STORE),
  since images, PDFs, audio and video are already compressed.

### 2.1 Reader safety limits

Readers MUST treat packages as untrusted input. They MUST reject a package that:

- has more ZIP entries than their limit (reference: 10,000);
- inflates to more total bytes than their limit (reference: 512 MiB) while reading the manifest, pages
  and declared assets;
- references any path containing `..`.

## 3. Lesson package

```
book.chalk
├── manifest.json
├── pages/page-1.json … page-N.json
├── snip-pages/snip-1.json …          (optional)
└── assets/<escaped asset id>         (fat bundles; absent for externalized assets)
```

### 3.1 `manifest.json`

| Field | Type | Required | Meaning |
|---|---|---|---|
| `format` | `"chalkbook.lesson"` | yes | Identifies the format. Readers MUST reject any other value. |
| `version` | string | yes | Display version of the writer's format support (e.g. `"0.1.0"`). Informational. |
| `formatVersion` | integer | yes for new files | Model version; drives migration (§6). Absent means `1`. |
| `kind` | `"lesson"` | no | Absent means `"lesson"`. Overlays use `"overlay"` (§4). |
| `id` | string | yes | Book id. |
| `title` | string | yes | Book title. |
| `locale` | string | yes | BCP 47 language tag of the content, e.g. `"bn"`, `"en"`. |
| `coverAssetId` | string | no | Explicit cover image. Absent: use page 1. |
| `pages` | array of `{ id, file, thumbnail? }` | yes | Page order. `file` points to the page JSON. |
| `snipPages` | array of `{ id, file }` | no | Satellite pages for `snip` objects (§3.4). Absent means none. |
| `assets` | array of `{ id, type, path, inline? }` | yes | Every asset the package declares (§3.5). |
| `bundling` | `"fat"` \| `"thin"` | no | Absent means `"fat"`. |
| `metadata` | `{ createdAt, updatedAt, author?, license? }` | yes | ISO 8601 timestamps; rights info only when known. |

Readers MUST ignore manifest fields they do not recognise.

### 3.2 Pages (`pages/page-N.json`)

```json
{ "id": "page_1", "title": "Page 1", "width": 1200, "height": 1698,
  "background": { "type": "pdf_page", "assetId": "sha256:…", "pageNumber": 1,
                  "renderedImageAssetId": "sha256:…", "thumbnailAssetId": "sha256:…" },
  "objects": [ … ],
  "textLayer": [ { "text": "…", "x": 10, "y": 20, "width": 300, "fontSize": 14 } ] }
```

- **Coordinates** are page units. `width`/`height` are optional; absent means 1600 × 900. Objects,
  backgrounds and the text layer all share this space, so annotations stay aligned at any display size.
- **Objects are drawn in array order**: later objects on top.
- **`textLayer`** (optional) is positioned plain text extracted from the source (e.g. a PDF), used for search,
  selection and accessibility. It is not drawn.

### 3.3 Backgrounds

| `type` | Fields | Rendering |
|---|---|---|
| `blank` | | Plain page |
| `color` | `color` (CSS colour) | Solid fill |
| `pdf_page` | `assetId` (the PDF), `pageNumber` (1-based), `renderedImageAssetId?`, `thumbnailAssetId?` | Draw `renderedImageAssetId` scaled to the page. Readers that can render PDF MAY render `assetId` directly. `thumbnailAssetId` is a small (~240 px) preview for page strips. |
| `image` | `assetId` | Draw the image scaled to the page |

### 3.4 Objects

Every object has `id` (unique within its page), `type`, `x`, `y`.

| `type` | Additional fields |
|---|---|
| `rect` | `width`, `height`, `fill`, `stroke`, `strokeWidth` |
| `ellipse` | `width`, `height`, `fill`, `stroke`, `strokeWidth` (bounding box at `x`,`y`) |
| `ink` | `points` (flat `[x1,y1,x2,y2,…]`, **offsets from `x`,`y`**), `color`, `size` (stroke diameter). Reference rendering: a smoothed, filled outline with simulated pressure (perfect-freehand). |
| `text` | `text`, `fontSize`, `fill`. `x`,`y` is the top-left of the text; the font family is chosen by the reader in 1.0 (it MUST support Bengali and Latin script). |
| `line`, `arrow` | `x2`, `y2`, `stroke`, `strokeWidth`. Drawn from `x`,`y` to `x2`,`y2` (absolute page units); `arrow` has a head at `x2`,`y2` of length and width `max(8, 3 × strokeWidth)`. |
| `vector` | `path` (SVG path data, **offset by `x`,`y`**), `fill?`, `stroke?`, `strokeWidth?` |
| `image` | `assetId`, `width`, `height`, `displayMode?` |
| `embed` | `embed` (`video` \| `model3d` \| `audio` \| `plugin`), `width`, `height`, `assetId?`, `url?`, `poster?`, `displayMode?` |
| `snip` | `snipPageId` (a page in `snipPages`) |

- `displayMode` is `full` (default: draw at `width` × `height`) or `icon` (draw a 56 × 56 marker at `x`,`y`).
- An `embed` refers to media by `assetId` (content-addressed) or by `url`. `poster` is an optional image
  asset shown before playback.
- A `snip` is a 56 × 56 marker that opens its satellite page. Satellite pages are ordinary pages but are not
  part of page navigation or page count.

### 3.5 Assets

- **Content-addressed ids** have the form `sha256:` followed by 64 lowercase hex digits: the SHA-256 of the
  asset's bytes. Readers MAY verify bytes against the id. Two identical files always share one id.
- An asset's ZIP path is `assets/` plus its id with `:`, `/` and `\` replaced by `_` and `..` replaced by `_`
  (e.g. `assets/sha256_ab12…`). Writers MUST NOT produce two ids that escape to the same path.
- `inline` absent or `true`: the bytes MUST be in the ZIP at `path`; a missing file is damage.
- `inline: false`: the bytes are deliberately external (thin bundle). Readers fetch them by id from an asset
  service and MUST NOT treat their absence as damage.
- Only content-addressed assets may be external: other ids cannot be re-fetched, so writers MUST inline them.
- Readers sniff the actual bytes rather than trusting `type`. The 1.0 media set is: PNG, JPEG, WebP, GIF,
  AVIF images; MP4 and WebM video; MP3, M4A and Ogg audio; binary glTF (`.glb`) models; PDF.

## 4. Overlay package

An overlay records one user's changes to a read-only lesson without copying it.

```
notes.chalk
├── manifest.json     { format, version, formatVersion, kind: "overlay", base: { id, version, hash? },
│                       assets, bundling?, metadata }
├── overlay.json      the delta (schema: overlay.schema.json)
└── assets/…          only assets the overlay itself introduces
```

`overlay.json` holds, per base page id: `cleared`, `removedObjectIds`, `upsertedObjects`, `objectOrder`,
and replaced `background`/`title`/`width`/`height`; plus `newPages`, an optional `pageOrder` and
`titleOverride`. Applying it (`compose`) to the base yields the edited book; for any edited book,
`compose(base, diff(base, edited))` equals `edited`.

## 5. Conformance

- A **reader** conforms if it accepts every package in `conformance/valid`, rejects every package in
  `conformance/invalid` (or, for missing asset bytes, opens it but reports the missing assets), and renders
  every object and background type in §3.
- A **writer** conforms if everything it produces is accepted by the reference reader and validates against
  the JSON Schema.

## 6. Versioning and compatibility

- `formatVersion` is an integer that increases whenever the model changes. Readers MUST migrate older
  documents to their own version before validating (reference: `migrateToLatest`). All changes from 1 to 7
  were additive, so these migrations are identities.
- Changes within 1.x MUST be additive: new optional fields, new object or background types. Existing fields
  are never renamed, repurposed or removed.
- **Known limitation of 1.0:** a 1.0 reader rejects a page that contains an object or background type it
  does not know, so one new widget makes the whole book unreadable for older apps. Chalk 1.1 is planned to
  fix this with a must-ignore rule: every object gets a fallback (bounding box, optional poster and label)
  that older readers draw instead, and the manifest lists features a reader must support (`requires`).

## 7. Roadmap (not part of 1.0)

- 1.1 compatibility: must-ignore unknown types with fallbacks; `requires`; extension namespaces.
- `lab` embeds (self-contained interactive HTML) and the Host API: a message protocol between labs or
  widgets and the host app (state, progress, data queries, permissions). **Specified in
  [Chalk 1.1](../1.1/README.md).**
- Navigation: table of contents, printed page labels, links, bookmarks.
- Structured, reflowable text (headings, paragraphs, math, tables) for small screens.
- Quizzes and interactive elements as data; learner-state packages.
- Fonts, multilingual text, accessibility (alt text, captions, reading order).
- Publishing metadata (ISBN, publisher, edition, curriculum), signatures, `assetSources` for thin bundles.
