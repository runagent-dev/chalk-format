# Chalk

**`.chalk` is an open format for interactive books**: textbook pages with ink, text, images, video, sound, 3D
models and **labs** (small simulations that run offline, in a sandbox) placed on them. This repository holds the
specification and everything needed to use it: JSON Schemas, a reference reader and writer, a React reader with an
editor, media libraries, a library server you can run yourself, converters and conformance tests.

It was made for SSC and HSC students in Bangladesh, so it is bilingual (Bengali and English) throughout and works
on cheap phones and slow connections. Nothing in it is specific to one country, school or app.

```
  a PDF ──convert──► book.chalk ──open──► <ChalkReader>  (read: search, notes, media, labs)
                         ▲                     │
                         │                     ▼ author mode
                         └──── save ◄──── add media and labs from libraries
                                               (this device · a folder · a library server)
```

## What a book is

A `.chalk` file is a ZIP of pages. Each page has a background (a rendered PDF page, an image, a colour) and objects
placed on it, with a text layer for search. Media is named by **keys** made from its bytes (`c1:` + 26 characters),
so the same video is the same key in every book. A book can carry its media inside ("self-contained": works
offline), or carry only the keys and find the media in **stores** and **libraries** (small books, shared media).
Large books can be published **streamed**: an index plus one file per page, so a 300-page textbook opens at once.

A student's notes are kept apart from the book, as an **overlay**: the book stays untouched and the notes travel
as their own small file.

## Guides

| Guide | For |
|---|---|
| [Make a book](docs/guides/make-a-book.md) | Converting a PDF, adding media in the editor, saving, publishing a streamed book |
| [Media libraries](docs/guides/media-libraries.md) | Where authors find and put media: this device, folders, library servers; connecting them in the editor and in code |
| [Run a library server](docs/guides/run-a-library-server.md) | Your own library over Postgres and any S3-compatible storage (Cloudflare R2, MinIO, AWS S3), with Docker |
| [Write a lab](docs/guides/write-a-lab.md) | A simulation in one HTML file: the sandbox, the Host API, three.js shared between labs, the lab manifest |
| [The reader](packages/reader/README.md) | Embedding `<ChalkReader>` in an app: props, the full configuration, theming, author mode |

## Install

Four packages are published to npm, all under the `@chalk-format` scope and released together (one version, `release.json`):

| Package | What it is |
|---|---|
| [`@chalk-format/core`](https://www.npmjs.com/package/@chalk-format/core) | The format in JavaScript: the data model, reading and writing `.chalk` files, asset keys and stores, media libraries, and `@chalk-format/core/lab/client` for writing labs |
| [`@chalk-format/reader`](https://www.npmjs.com/package/@chalk-format/reader) | The React reader and editor, `<ChalkReader>` (also imports `@chalk-format/reader/styles.css` and `/fonts.css`) |
| [`@chalk-format/pdf`](https://www.npmjs.com/package/@chalk-format/pdf) | PDF → `.chalk` in Node, and the `chalk-pdf` command |
| [`@chalk-format/library-server`](https://www.npmjs.com/package/@chalk-format/library-server) | A media library server (the registry API), and the `chalk-library` command |

```bash
npm i @chalk-format/reader @chalk-format/core react react-dom      # read and edit books in a web app
npx @chalk-format/pdf convert book.pdf -o book.chalk --locale bn   # convert a PDF
```

The packages listed under [Packages](#packages) are the repository's internal split of the same code (all private; `reader` and
`library-server` happen to share their names with the published ones). The four published packages are assembled from them
(`node scripts/assemble-packages.mjs`, see [Releasing](CONTRIBUTING.md#releasing)).

## Quick start

Node 22.13+ and pnpm 9+.

```bash
pnpm install
pnpm check                                          # lint, typecheck and every test (incl. conformance)

pnpm --filter @chalk-format/reader-app dev          # the showcase: http://localhost:5190

npx tsx packages/cli/src/cli.ts convert ./book.pdf -o book.chalk --title "Physics" --locale bn
```

The showcase opens a bilingual sample chapter (pages from a PDF, video, sound, a 3D screw gauge, two labs, a
snip). **Open a book** loads any `.chalk`; **Configure** changes the reader live and shows the code for it;
**Author** switches to the editor.

## The specification

| Version | `formatVersion` | Adds |
|---|---|---|
| [1.0 Core](spec/1.0/README.md) | 7 | Pages, objects, the text layer, assets, self-contained and thin books, overlays |
| [1.1 Labs](spec/1.1/README.md) | 8 | Labs, the sandbox, and the [Host API](spec/1.1/host-api.md) labs use to talk to the reader |
| [1.2 Asset stores](spec/1.2/README.md) | 9 | `c1:` keys, stores that turn keys into bytes, how a reader finds media, and the [registry API](spec/1.2/registry-api.md) libraries speak |
| [1.3 Presentation](spec/1.3/README.md) | 10 | How the author wants each piece of media shown: live or a card, what a tap opens, label, icon, accent, playback |
| [1.4 Streamed books](spec/1.4/README.md) | 10 (no model change) | A book as static files: an index, one file per page, a search file |
| [1.5 Lab libraries](spec/1.5/README.md) | 11 | Labs share libraries such as three.js, supplied by the reader; lab manifests describe a lab for libraries and editors |
| [1.6 Question manifests](spec/1.6/README.md) | 11 (no model change) | A question kept in a store, so books point at it instead of copying it |

Each version only adds to the ones before: every valid book stays valid, and older readers still open newer books.
[`schema/`](schema) has the JSON Schemas for readers written in other languages, and
[`conformance/`](conformance) the books every reader must accept or reject.

## Packages

| Package | What it does |
|---|---|
| [`@chalk-format/model`](packages/model) | The data model (Zod), migrations, overlays, asset keys, lab manifests |
| [`@chalk-format/container`](packages/container) | Pack, unpack and validate `.chalk` files; streamed books |
| [`@chalk-format/store`](packages/store) | Asset stores, the resolver, libraries, the registry API client |
| [`@chalk-format/reader`](packages/reader) | `<ChalkReader>`: the React reader and editor |
| [`@chalk-format/lab`](packages/lab) | Running labs in a reader (`mountLab`) and writing them (`connectLab`) |
| [`@chalk-format/library-server`](packages/library-server) | A library server: the registry API over Postgres and S3-compatible storage |
| [`@chalk-format/pdf-engine`](packages/pdf-engine), [`convert-pdf`](packages/convert-pdf), [`cli`](packages/cli) | PDF pages to book pages, PDF to `.chalk`, the `convert` command |
| [`@chalk-format/conformance`](packages/conformance) | Runs the conformance books against the reference implementation |
| [`apps/reader`](apps/reader) | The showcase site |
| [`apps/models`](apps/models) | Procedural 3D science models (screw gauge, vernier caliper) and their gallery: the source of the sample book's 3D model |

Tools in [`tools/`](tools): `chalk-stream.ts` (publish a streamed book), `library-add.ts` (fill a library from a
list), `lab-libraries.ts` (reproducible shared builds for labs), and the browser test scripts.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, how to check a change and the rules the format lives by, and
the [roadmap](docs/roadmap.md) for what is open. [Reader internals](docs/reader-internals.md) explains how the
reader is built.

## Origin and license

The format began in RunAgent's ChalkBook smartboard app and was extracted from it with the history of its format
packages. [`spec/design-history`](spec/design-history) keeps the original design documents.

[Apache-2.0](LICENSE). See [NOTICE](NOTICE).
