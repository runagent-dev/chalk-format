# Make a book

From a PDF to a book students open in a browser: convert, add media and labs in the editor, save, and publish it
so a reader loads only the pages being read.

You need Node 22.13+ and pnpm 9+. Run every command from the repository root after `pnpm install`.

## 1. What a `.chalk` is

A `.chalk` file is a ZIP. It holds `manifest.json`, one JSON file per page (`pages/page-N.json`) and the
assets. Each page has a **background** (a rendered PDF page, an image or a colour) and **objects** placed on top
of it: ink, text, shapes, images, video, audio, 3D models and labs (small simulations that run in a sandbox). A
page can also carry an invisible text layer, which search and text selection use.

Assets are named by their content (`c1:` plus 26 characters, made from the bytes). A book can carry its media
inside (it works offline) or only name it, and a reader then fetches it by key from a store or a library.

Specs: [1.0 Core](../../spec/1.0/README.md) (the container, pages, objects, overlays),
[1.2](../../spec/1.2/README.md) (keys and stores), [1.3](../../spec/1.3/README.md) (how media is presented),
[1.4](../../spec/1.4/README.md) (streamed books).

## 2. Convert a PDF

```bash
npx tsx packages/cli/src/cli.ts convert book.pdf -o book.chalk \
    --title "Physics" --locale bn --license "All rights reserved"
```

Each page becomes a page of the book: a rendered picture of it as the background (WebP by default), plus the
PDF's text as the text layer. It runs in Node, with no browser.

| Flag | Default | |
|---|---|---|
| `-o <file>` | the PDF's name with `.chalk` | Where to write the book |
| `--title <text>` | taken from the file name | The book's title |
| `--locale <bcp47>` | `en` | The book's language, e.g. `bn` |
| `--author <name>` | none | |
| `--license <text>` | none | Recorded as given. Nothing is assumed when it is left out |
| `--width <px>` | 1200 | Width of the rendered page pictures |
| `--format webp\|png` | `webp` | WebP is 5 to 10 times smaller |
| `--quality 0-1` | 0.82 | WebP quality |

`npx tsx packages/cli/src/cli.ts --help` prints the same list.

Without the repository, the same command is published: `npx @chalk-fmt/pdf convert book.pdf -o book.chalk` (installed, the command is `chalk-pdf`).

The package also has a script for the same thing (`pnpm --filter @chalk-format/cli start convert …`). pnpm runs it
inside `packages/cli`, so give it absolute paths.

From code, the same conversion is `convertPdfToChalk(pdfBytes, title, options)` in `@chalk-fmt/pdf`.

## 3. Open it in the reader

```bash
pnpm --filter @chalk-format/reader-app dev      # http://localhost:5190
```

This is the showcase site of the reference reader (`@chalk-fmt/reader`). **Open a book** loads any `.chalk`
file. The book picker at the top switches between the sample books. **Configure** changes the reader live and
shows the matching code.

To show books in your own app, use the `<ChalkReader>` React component: see
[`packages/reader/README.md`](../../packages/reader/README.md).

## 4. Add media and labs in author mode

Switch **Read / Author** at the top of the showcase. In your own app, author mode needs
`config.authoring.enabled`.

- **The rail (left)** has select (V), pen (P), highlighter (H), eraser (E), text (T), shapes (R, O, L, A) and
  **+** to add media. What you draw in author mode goes into the book itself.
- **+ › Image, Video, Sound, 3D model or Lab** opens a gallery of the connected **libraries**. Search, then pick an
  item to place it on the page. **Upload new** puts a file into a library first, then places it. Media files
  dropped onto a page are placed too.
- **Libraries** are where media lives: **This device** (stored in the browser), a folder on the computer, or a
  library server. They are listed in the sidebar when nothing is selected. Connect one there and set the order
  with the arrows: the first library that has an item supplies it. See
  [Libraries](../../packages/reader/README.md#libraries); a library server speaks the
  [registry API](../../spec/1.2/registry-api.md) and `packages/library-server` is one you can run.
- **The sidebar (right)** shows the settings of what you are working on: a selected object's position, size
  and presentation (spec 1.3: live or a card, what a tap opens, label, icon, colour), the drawing tool's colour
  and thickness, or, with nothing selected, the book and page titles and what is on the page.
- **Read mode** shows the book exactly as students will see it.

**Save** (the disk in the dock) writes a **self-contained** `.chalk`: every asset the book uses, collected from
the book and from the connected libraries. The file opens anywhere, offline.

Not built yet: saving a "thin" book that keeps only keys and leaves the media in the libraries; editing a
lab's settings (`params`) in the sidebar; adding, reordering or importing pages. A lab placed from a library
keeps the default settings of its manifest.

## 5. Students' notes are overlays

Students can draw, highlight and type on a book in read mode. Their notes never change the book: the reader keeps
them as an **overlay** (spec 1.0 §4), a small package holding only the differences, tied to the book's id and
version. The reader saves it in the browser by default, or hands it to your app (`onOverlayChange`). A student
can also save and reopen their notes as a file. See [spec 1.0 §4](../../spec/1.0/README.md#4-overlay-package).

## 6. Publish as a streamed book

A `.chalk` is one file, and a reader has to download all of it. For a textbook, publish it as a **streamed
book** (spec 1.4) instead: a folder of static files the reader fetches page by page.

```bash
npx tsx tools/chalk-stream.ts publish book.chalk out/physics-9/
# out/physics-9/: 120 pages, … files
#   book.json            the index: page count, sizes, thumbnails, which assets each page needs
#   pages/<n>-<hash>.json one file per page
#   assets/<key>         the media, named by key
#   text-<hash>.json     the text of every page, for search

npx tsx tools/chalk-stream.ts pack out/physics-9/ book.chalk    # the same book as one .chalk again
```

The reader opens `book.json`, shows the whole book at once (sizes and thumbnails), and loads the current page
first, then the pages around it (5 each way by default, `config.streaming.window`). A long jump loads only
around the new place. Search uses the one text file, so it finds words on pages not loaded yet.

```tsx
<ChalkReader source="https://books.example.org/physics-9/" />
```

**Hosting.** Any static host or bucket works (S3, R2, a CDN, nginx):

- **Caching.** Every file except `book.json` is named by its content and never changes, so serve those with
  `Cache-Control: public, max-age=31536000, immutable`. Revalidate `book.json` (`no-cache` with an ETag, or a
  short max-age) so a republished book is seen.
- **CORS.** If the reader runs on another origin, allow `GET` (and `HEAD`) from it, or from `*` for public books.
- Publishing again writes new page files for the pages that changed. Old files can stay: nothing names them any
  more.

Not built yet: reading a `.chalk` at a URL by byte ranges (spec 1.4 §7). The reader opens directories (or their
`book.json`) and whole `.chalk` files.

## 7. Known limits

- **Bengali text from many PDFs has no Unicode.** Chromium's PDF output and many other tools write shaped
  Bengali glyphs (conjuncts, vowel signs) without Unicode text, and older textbooks use legacy (Bijoy-style)
  fonts. The pictures of the pages look right, but the text layer comes out empty or wrong, so search fails on
  those books. Fixing it needs OCR or a legacy-encoding converter in `convert-pdf`. See
  [the roadmap](../roadmap.md).
- **Scanned PDFs** (from a phone scanner app) are page pictures only: the book shows every page, but there is no
  text to search until the converter gains OCR. They are also large (often 0.5–1 MB a page at the default width):
  publish them streamed, and try `--width 1000 --quality 0.7`.
- Pages are fixed layouts (a PDF page, an image). Reflowable text is on the roadmap.
