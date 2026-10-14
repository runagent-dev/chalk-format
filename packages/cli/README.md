# @chalk-format/cli

Converts a PDF into a `.chalk` lesson from the command line — no browser
required. Renders each page (WebP by default, ~5–10× smaller than PNG),
extracts a searchable text layer, and packs a portable document.

Uses the same model builder (`@chalk-format/pdf-engine`) and packer
(`@chalk-format/container`) as the in-app import, so a CLI-converted `.chalk`
is identical to one produced in the browser. Rendering in Node uses
PDF.js + `@napi-rs/canvas`.

## Usage

```bash
pnpm --filter @chalk-format/cli start convert ./book.pdf
# → book.chalk

pnpm --filter @chalk-format/cli start convert ./book.pdf \
    -o out.chalk --title "Physics" --locale bn --license "All rights reserved" --width 1600 --format webp --quality 0.85
```

Open the resulting `.chalk` in the app (Open .chalk) or publish it with
the content CLI.
