# Chalk 1.5: Lab libraries and lab manifests

Status: draft · `formatVersion` 11 · builds on [1.1](../1.1/README.md) (labs), [1.2](../1.2/README.md) (keys, stores)

Two additions for labs made apart from books, kept in a store, and placed by book designers:

- **Libraries** (§2): a lab names the libraries it uses (three.js and its add-ons, …) instead of carrying them.
  The reader supplies them, so a book with twenty 3D labs carries three.js once, not twenty times, and a
  student's device downloads it once.
- **Lab manifests** (§4): what a store keeps about a lab, so a designer can find it, place it and set it up
  (a settings form generated from the manifest) without reading its code.

## 1. Why

A self-contained lab (spec 1.1 §3.1) that uses three.js carries its own copy: about 720 KB (185 KB compressed)
in every lab. Twenty labs, twenty copies, and each a different file, so nothing is shared or cached between
them. Memory was never the issue (a reader runs one lab at a time); download and storage are.

## 2. Libraries

```json
"lab": { "id": "org.pathshalax.physics.screw-gauge", "version": "1.0.0", "title": "Screw gauge · স্ক্রু গজ",
         "entry": "c1:…",
         "libraries": [
           { "specifier": "three", "version": "0.185.1", "asset": "c1:…" },
           { "specifier": "three/addons/controls/OrbitControls.js", "version": "0.185.1", "asset": "c1:…" } ] }
```

| Field | | Meaning |
|---|---|---|
| `specifier` | required | The bare name the lab imports (`import * as THREE from 'three'`). Unique within the lab |
| `version` | required | The library's version, for people and tools; the bytes are fixed by `asset` |
| `asset` | required | A content-addressed asset of the book: one ES module file, bundled (no relative imports). It may import only other specifiers of the same lab's `libraries` |

Rules:

- **The lab is written like any ES module project**: `import * as THREE from 'three'`. No global, no loader.
- **Readers MUST verify** each library's bytes against its `asset` key before running anything, as for `entry`.
- **Readers supply libraries through an import map placed before the lab's own markup** (reference: a
  `blob:` URL per library, made inside the lab's frame, so the lab's Content Security Policy is unchanged). The
  same module specifier gives the same module: an add-on that imports `three` gets the lab's `three`.
- **A lab MAY carry its own import map** pointing its specifiers at a CDN, so the file runs when opened on its
  own (§3). Inside a reader, the reader's map comes first and wins (import map rules: a specifier, once mapped,
  is not remapped), and the sandbox forbids the network anyway. Its versions SHOULD match `libraries`.
- **Budgets** (spec 1.1 §3.4): each library ≤ 2 MiB, ≤ 4 MiB in all per lab. Libraries do not count toward
  `lab.assets`.
- `libraries` are assets of the book like `entry` (carried, or found through stores by key), and are not
  available through the Host API's `asset.get`: they are code, given to the document, not data.

**Shared builds.** Libraries are shared when books use the same bytes. chalk-format publishes reproducible
builds of common libraries (`libraries/catalog.json`: three.js and the add-ons labs use most, with their keys);
a lab SHOULD use them. Any other bundled ES module is allowed and simply costs its own download.

**Compatibility.** A 1.4 reader does not supply libraries: such a lab cannot load them (its own map points at
a network the sandbox forbids). Labs SHOULD catch a failed import and say so on their poster area, and authoring
tools SHOULD warn when a book with library labs is saved for older readers.

## 3. Running a lab file on its own

A lab file stays runnable outside any reader (opened directly, or from any static server) when it:

1. carries its own import map for its specifiers (a CDN, or local copies), and
2. starts with default settings when no reader answers (no `init` within ~300 ms; reference:
   `examples/labs/pendulum.html`).

Tested in Chromium (desktop and phone size), Firefox and WebKit, under the lab CSP of spec 1.1 §3.3:

| How the reader supplies a library | Result |
|---|---|
| import map → `data:` URL | blocked by the lab CSP everywhere (`script-src` has no `data:`) |
| import map → `blob:` URL made inside the frame (reference) | works everywhere, no CSP change; add-ons share the same `three` |
| classic script defining a global | works everywhere; needs labs written for a global (fallback for old browsers) |
| reader's map first, then the lab's own CDN map | the reader's library is used; the CDN is never contacted |
| the lab file opened on its own | loads from its own map |

Import maps need Chrome 89+, Firefox 108+ or Safari 16.4+.

## 4. Lab manifests

What a store keeps for a lab, uploaded with its HTML (media type `application/vnd.chalk.lab+json`):

```json
{
  "format": "chalk.lab", "manifestVersion": 1,
  "id": "org.pathshalax.physics.screw-gauge", "version": "1.0.0",
  "title": { "bn": "স্ক্রু গজ", "en": "Screw gauge" },
  "description": { "bn": "…", "en": "Turn the thimble and read the diameter." },
  "subject": "physics", "classes": ["9", "10"], "tags": ["measurement", "least count"],
  "entry": "c1:…", "poster": "c1:…", "assets": [], "libraries": [ { "specifier": "three", "version": "0.185.1", "asset": "c1:…" } ],
  "capabilities": ["state", "progress"],
  "size": { "width": 960, "height": 600, "minWidth": 440, "minHeight": 300 },
  "params": {
    "type": "object",
    "properties": {
      "pitch": { "type": "number", "title": { "bn": "পিচ", "en": "Pitch" }, "minimum": 0.25, "maximum": 1, "multipleOf": 0.25, "default": 0.5, "x-chalk-unit": "mm" },
      "divisions": { "type": "integer", "title": { "bn": "বৃত্তাকার ভাগ", "en": "Circular divisions" }, "enum": [50, 100], "default": 50 },
      "zeroError": { "type": "boolean", "title": { "bn": "শূন্য ত্রুটি", "en": "Zero error" }, "default": false }
    }
  },
  "presets": [ { "id": "practice", "title": { "bn": "অনুশীলন", "en": "Practice" }, "params": { "zeroError": true } } ],
  "license": "CC-BY-4.0", "authors": ["PathshalaX"]
}
```

| Field | | Meaning |
|---|---|---|
| `format`, `manifestVersion` | required | `"chalk.lab"`, `1` |
| `id`, `version`, `entry` | required | As in the lab descriptor. A new version of a lab is a new manifest; books keep the version they were made with |
| `title` | required | A string, or one per language (`bn`, `en`, …) |
| `description`, `subject`, `classes`, `tags`, `license`, `authors` | | For finding labs in a store |
| `poster` | SHOULD | The lab's opening view (spec 1.1 §2) |
| `assets`, `libraries`, `capabilities` | | As in the descriptor |
| `size` | | The box to place it in, in page units, and the smallest it is usable at (readers open smaller ones larger, spec 1.3) |
| `params` | | A JSON Schema (draft 2020-12) of an object: the settings a designer may change. Each property: `type` (`number`, `integer`, `boolean`, `string`), `title` (string or per language), `default`, and for numbers `minimum`, `maximum`, `multipleOf`, `x-chalk-unit`; `enum` for a fixed choice. Authoring tools build a form from it; properties they cannot show are left as their defaults |
| `presets` | | Named sets of settings (`id`, `title`, `params`) |

**Placing a lab from its manifest** (authoring tools): an `embed` object with `plugin: "chalk.lab"`, `width` and
`height` from `size`, `poster`, and a `lab` descriptor with the manifest's `id`, `version`, `entry`, `assets`,
`libraries`, `capabilities`, `title` in the book's language, and `params` = the schema's defaults, then the chosen
preset, then the designer's changes. A designer's settings MUST validate against `params`.

## 5. Conformance

- `schema/lab-manifest.schema.json`.
- `conformance/valid/lab-libraries.chalk`: a lab with libraries (and its own import map for standalone use).
- `conformance/invalid/lab-library-not-content-addressed.chalk`, `…/lab-library-duplicate.chalk`.
- `examples/labs/screw-gauge.html` + `screw-gauge.lab.json`: a 3D lab using the shared three.js, runnable on
  its own.
