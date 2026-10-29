# Roadmap

What works today, what is known to be missing, and what comes next. Pull requests for any of it are welcome; for
anything that changes the format, open an issue first.

## Where things stand

| Part | State |
|---|---|
| Format | Chalk 1.0 to 1.5 (`formatVersion` 7 to 11): pages, objects, overlays, labs and the Host API, asset stores, presentation, streamed books, lab libraries and lab manifests. Spec, JSON Schemas, migrations and conformance cases for each |
| Reader | `@chalk-format/reader`: every object type, search, notes, presentation, streamed books, libraries, author mode. Checked in the browser with real input on desktop and phone |
| Libraries | This device, folders and library servers, one interface. A library server (Postgres and S3-compatible storage) with a conformance check |
| Converters | PDF → `.chalk` (CLI and Node) |

## Known problems

1. **Bengali text from many PDFs has no Unicode.** Chromium's PDFs (and many other tools') do not map shaped
   Bengali glyphs (conjuncts, pre-base vowel signs) back to text; pdf.js reads them as U+0000, so search fails on a
   converted Bengali PDF. Textbooks set in older Bijoy-style fonts are worse. The converter needs OCR or a legacy
   encoding → Unicode step. Not started.
2. **Scanned books have no text at all.** A PDF made by a phone scanner is page images only, so the converted book
   shows the pages but cannot be searched. Same fix: OCR in the converter (Bengali and English).
3. **A lab added as a file loses its shared libraries.** Dropping or picking a lab's `.html` places it without a
   manifest, so a three.js lab gets no `lab.libraries`. Labs placed from a library (through their manifest) are
   fine. The Lab gallery has no upload yet.
4. **Audio in author mode** shows as a card, not as its player bar.
5. **The CLI's command is still called `chalkbook-pdf`** (its old name) in its usage text and `bin`.

## Next

**Author mode**
- A settings form for a lab, made from its manifest's `params`.
- Replacing a poster; editing text in place (today it is edited in the sidebar); a snip-region tool.
- Pages: add, reorder, delete, and import pages from a PDF.
- Concurrent editing: patch saves with a three-way merge, a quick start, and the page operations above; design in
  [spec/design-history/2026-10-28-concurrent-section-editing-design.md](../spec/design-history/2026-10-28-concurrent-section-editing-design.md).
- Linked saving: a book that keeps only keys, with a check that warns about media that lives only on this device.
- Autosaved drafts.

**Labs**
- A check-lab tool: runs a lab in the sandbox and reports what it asks for, what it loads and whether it says
  ready.

**Streamed books**
- Reading a `.chalk` by byte ranges, without a separate publish step (spec 1.4 §7).
- Host stores for a streamed book's external media; thumbnails for books that have none.

**Library server**
- Sign-in per person (today: a fixed list of tokens), and a small admin page.

**Reader**
- An accessibility audit with a screen reader; performance measured on a cheap Android phone; a smaller first
  download (pdf.js and model-viewer already load on demand).

**Format** (see [spec 1.1 §6](../spec/1.1/README.md#6-still-on-the-roadmap))
- General fallbacks for other new object types (`requires`), host-provided data for labs (the reserved `data`
  capability), learner-state packages, navigation (table of contents, page labels, links), reflowable text.
