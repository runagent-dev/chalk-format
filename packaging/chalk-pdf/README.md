# @chalk-format/pdf

Converts a **PDF into a `.chalk` book** in Node, with no browser: each page rendered as a picture (WebP by default)
with the PDF's text as a searchable text layer.

```bash
npx @chalk-format/pdf convert book.pdf -o book.chalk --title "Physics" --locale bn --license "All rights reserved"
npx @chalk-format/pdf --help
```

(Installed, the command is `chalk-pdf`.)

```ts
import { convertPdfToChalk } from '@chalk-format/pdf';
const chalk = await convertPdfToChalk(pdfBytes, 'Physics', { locale: 'bn' });   // the .chalk file's bytes
```

`@chalk-format/pdf/engine` is the page mapping it uses (pdf.js), shared with in-browser imports.

Scanned PDFs have no text to extract: the book shows the pages but cannot be searched until they are OCR'd.
Making a book from start to finish: [the guide](https://github.com/runagent-dev/chalk-format/blob/main/docs/guides/make-a-book.md).
Apache-2.0.
