# Reader internals

How `@chalk-fmt/reader` is built, for people changing it. For using it, see its
[README](../packages/reader/README.md).

## Decisions

- **Rendering is DOM and SVG, not canvas:** sharp at any zoom, text selectable and searchable, accessible. Each
  page is one box in page units, scaled to the screen.
- **A student's notes are a Chalk overlay** (spec 1.0 §4). The reader keeps an edited copy of the lesson; the
  overlay is always `diffLesson(base, edited)`, so whatever the student does is a standard, exportable overlay.
- **Everything is configurable through one `config` prop**, with sensible defaults: features, the dock's items and
  order and position, tools, colours, layout, theme, language, persistence, author mode.
- **Phone first:** 320 px and up, touch (pinch zoom, swipe, drawing with a finger or pen), one live lab at a time.
  Author mode is the exception: it is built for a computer with a mouse and keyboard.
- **Tone:** utilitarian and warm. Quiet chrome around the book: a paper-grey desk, one ink-blue accent, Noto Sans
  and Noto Sans Bengali, a compact floating dock, no gradients. Light and dark.

## Pages (`src/render/`)

- `PageView.tsx` draws a page. Vector objects are batched into SVG runs; text, embeds and snips are HTML between
  them, so array order (the spec's draw order) holds.
- `TextLayer.tsx`: the text layer is invisible, selectable spans, each stretched to its recorded width.
- `ink.ts`: strokes with perfect-freehand.
- `Markers.tsx`: cards and 56 px icon markers (spec 1.3 presentation).
- `pdf.ts`: a `pdf_page` without a rendered image is drawn with pdf.js when `config.pdfWorkerSrc` is set.
- `assets.ts`: `useAssetUrl`, the URL to draw an asset with. It asks the open book, which knows its own assets,
  the host's resolver and (through `withLibraries`) the connected libraries.

## Viewer and dock

- `Viewer.tsx`: continuous, single and spread layouts; fit `auto` (fit the width, at most 900 px a page), `width`
  or `page`; zoom keeps the point under the cursor still (buttons, keys, ctrl+wheel, pinch). Pages more than about
  a screen away are sized boxes only. The current page is the one with the largest visible share.
- `Dock.tsx`: items, order and position come from config; hosts can add their own. When it overflows, items move
  into a "more" menu, least needed first (the `NEED` table); tools and page turning stay. Side docks become bottom
  docks below 720 px.
- `panels/`: thumbnails (inert previews; a thumbnail is a button) and search (`search.ts`: NFC and case folding,
  matches widened to whole grapheme clusters). A side sheet on wide screens, a bottom sheet below 720 px
  (a container query on `.chalk-reader`).

## Media (`src/render/Embeds.tsx`, `src/present.tsx`)

- Video plays inline; audio is a player bar drawn in page units; 3D uses `<model-viewer>`, imported on demand.
- Labs use `LabFrame`: `mountLab` from `@chalk-format/lab`, the poster until the lab says it is ready, `setVisible`
  from an IntersectionObserver and tab visibility, state in `labStorage` (localStorage by default). Shared
  libraries named in `lab.libraries` are found like any asset and handed to `mountLab`.
- One live embed at a time, drawn in **screen pixels** above the page (`.chalk-page-active`), so frames and
  canvases stay sharp. If the box on screen is smaller than 440×260 px, a lab or model opens in a dialog instead.
- `present.tsx` applies spec 1.3 presentation: live or a card, what a tap opens, label, icon, accent, playback,
  and the host's `config.presentation` defaults.

## Notes (`src/annotate/`)

- `state.ts`: `useAnnotations` keeps the edited lesson and a history with one entry per gesture.
- `Surface.tsx`: pointer tools in page units. `ToolsMenu.tsx`: the dock's tool popover. `ops.ts`: hit testing and
  moves (tested).
- Only the student's own objects can be edited unless `annotations.editBase`. Saved to localStorage
  (`chalk:<lessonId>:overlay`) by default, reported through `onOverlayChange`, and saved or opened as an overlay
  `.chalk`.

## Author mode (`src/author/`)

- `state.ts`: `useAuthoring` edits the book itself (not an overlay): edits, undo and redo, save. For a streamed
  book it loads every page first.
- `AuthorRail.tsx`: the left rail (select, pen, highlighter, eraser, text, shapes, add media) with keyboard
  shortcuts. `AuthorSurface.tsx`: selection, move and resize handles, drawing.
- `Sidebar.tsx`: the right sidebar holds every setting, by context: the selection, else the media being added,
  else the active tool, else the page (with the book's libraries and the objects on the page).
  `Inspector.tsx` and `controls.tsx` are its fields.
- `Gallery.tsx`: **+ › a kind** searches the connected libraries, places a pick, or uploads a file into the chosen
  library first. `Libraries.tsx`: connect, order and disconnect libraries. `insert.ts`: what a file or a library
  item becomes on the page.
- `i18n.ts`: the author tools' strings (English by default, Bengali available).

## Books, streaming and libraries

- `book.ts` opens a book from a URL, bytes or a file; `stream.ts` opens a streamed book (spec 1.4): the index
  first, then the pages around the current one (`windowAround`), nearest first, at most six requests at a time,
  after the view settles for 150 ms; a long jump loads only the new place.
- `libraries.ts`: `withLibraries` lets the reader find media a book does not carry in the connected libraries, and
  counts what none of them has (the "not in your libraries" cards and list).
- `saved-libraries.ts`: `useSavedLibraries` keeps the connected libraries in the browser (servers in localStorage,
  folder handles in IndexedDB), with host presets.

## Styling and text

- `styles.css`: every value is a `--chalk-*` token on `.chalk-reader`, dark mode under `[data-theme="dark"]`;
  nothing leaks outside `.chalk-reader`. `fonts.css` bundles Noto Sans and Noto Sans Bengali.
- `i18n.ts`: the reader's chrome in Bengali (the default) and English, with Bengali digits through `num()`. A
  book's content is never translated.
