# Reference reader: plan and status

The reference web reader for `.chalk` books: what every app that shows a Chalk book should feel like.

- `packages/reader`: `@chalk-format/reader`, a React component (`<ChalkReader>`) other projects embed.
- `apps/reader`: the showcase site that shows it off (sample book, open your own file, a configuration
  playground that shows the code for the current setup).

## Decisions

- **Rendering is DOM/SVG**, not canvas: sharp at any zoom, text selectable and searchable, accessible.
  Vector objects in one SVG per page in page units; text, the text layer and embeds as HTML on top.
- **Annotations are a Chalk overlay** (spec 1.0 §4): the reader keeps an edited copy of the lesson and the
  overlay is `diffLesson(base, edited)`, so whatever the student does is a standard, exportable overlay.
- **Everything is configurable** through one `config` prop: features, which dock items appear and in what
  order, dock position, tools, colours, layout, theme, language, persistence, read-only. Sensible defaults.
- **Tone:** utilitarian, warm. Quiet chrome around the book: warm paper-grey desk, one ink-blue accent,
  Noto Sans + Noto Sans Bengali, a compact floating dock, no gradients. Light and dark.
- **Phone-first:** 320 px up, touch (pinch zoom, swipe, pen/touch drawing), one lab running at a time.

## Phases

- [ ] **1. Pages.** Open a book (file, bytes, URL; thin assets via a resolver). Render every background and
  object type per the spec. Continuous scroll with page virtualisation, zoom (fit width, fit page, pinch,
  ctrl+wheel), keyboard. Showcase app shell.
- [ ] **2. Navigation.** The dock. Thumbnails, search (text layer + text objects, highlighted), go to page,
  fullscreen, theme, language.
- [ ] **3. Media and labs.** Video, audio, 3D (`<model-viewer>`, loaded on demand), icon-mode markers, snip
  pages, unknown plugins as fallback cards, labs through `@chalk-format/lab` (poster, tap to start, one at a
  time, paused off screen, state saved).
- [ ] **4. Annotations.** Pen, highlighter, eraser, text, shapes, select/move/delete, undo/redo, colours and
  sizes; the overlay saved (local storage by default, or the host's callback), exported and imported as a
  `.chalk` overlay.
- [ ] **5. Showcase.** A sample book that uses every feature (bilingual physics pages from a real PDF, video,
  audio, a 3D model, labs, a snip page). The configuration playground.
- [ ] **6. Polish.** PDF rendering when a page has no rendered image, accessibility pass, performance on a
  cheap phone, docs, deployment.
