# @chalk-format/cli

Converts a PDF into a `.chalk` book from the command line, with no browser. It renders each page (WebP by
default, about 5–10× smaller than PNG), extracts a searchable text layer, and packs a self-contained book.

It uses the same page builder (`@chalk-format/pdf-engine`) and packer (`@chalk-format/container`) as an in-browser
import, so a book converted here is the same as one made in the browser. Rendering in Node uses pdf.js and
`@napi-rs/canvas`.

## Usage

From the repository root:

```bash
npx tsx packages/cli/src/cli.ts convert ./book.pdf
# → book.chalk

npx tsx packages/cli/src/cli.ts convert ./book.pdf -o out.chalk --title "Physics" --locale bn \
    --license "All rights reserved" --width 1600 --format webp --quality 0.85
```

The package's `start` script runs the same command, but pnpm runs it inside `packages/cli`, so give it absolute
paths. Scanned PDFs have no text to extract; see [making a book](../../docs/guides/make-a-book.md) for that and
for what to do with the result.
