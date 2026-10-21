# @chalk-format/reader

The reference reader for `.chalk` books: a React component that shows everything the format can hold and
lets the student work on it. Other apps embed it as is, or follow it as the model of how a Chalk book should
read. Try it in [`apps/reader`](../../apps/reader) (`pnpm --filter @chalk-format/reader-app dev`).

## What it does

- **Pages:** every background and object type of spec 1.0, drawn in the book's order, sharp at any zoom
  (DOM and SVG, not canvas). Continuous, single-page or two-page layouts; fit width, fit page or `auto`; zoom
  with buttons, keys, ctrl/⌘+wheel or a pinch. Long books stay light: pages far from the view are not drawn.
- **Finding your way:** thumbnails, search over the text layer and the book's own text (Bengali-aware:
  Unicode forms and whole letters), go to page, keyboard, fullscreen, light and dark, Bengali and English.
- **Media:** video, audio (a player drawn in the page), 3D models (`<model-viewer>`, loaded on first use),
  icon-mode markers and snip pages (opened in a dialog), and plugins the reader does not know shown as their
  poster card (spec 1.1 §2.2).
- **Labs** (spec 1.1) through [`@chalk-format/lab`](../lab): poster until tapped, then a sandboxed frame
  with no network; one at a time, paused off screen, state saved, progress reported. On a phone a lab opens in
  a full-reader view.
- **Presentation as the author chose it** (spec 1.3): live or as a card, what a tap opens (in place, a
  dialog, full screen), label, icon and accent colour, autoplay, loop, muted, auto-rotate. A live model or lab
  starts once at least half of it is on screen and it is big enough there to use; otherwise its card opens it.
- **The student's notes:** pen, highlighter, eraser, text, shapes and select, with undo. They are a standard
  Chalk overlay (spec 1.0 §4): kept in the browser, handed to the host, saved and opened as a `.chalk` file.
- **PDF pages without a rendered image** drawn with pdf.js, when the host gives `pdfWorkerSrc`.

## Use

```tsx
import { ChalkReader } from '@chalk-format/reader';
import '@chalk-format/reader/fonts.css';    // Noto Sans + Noto Sans Bengali (skip if you load them already)
import '@chalk-format/reader/styles.css';

<div style={{ height: '100vh' }}>
  <ChalkReader source="/books/physics.chalk" config={{ locale: 'bn', dock: { position: 'bottom' } }} />
</div>
```

The reader fills its container; give the container a height.

### Props

| Prop | Type | |
|---|---|---|
| `source` | `Uint8Array \| ArrayBuffer \| Blob \| string \| URL` | The book: bytes, a File, or a URL to fetch. |
| `book` | `Book` | An already opened book (`openBook()` / `bookFrom()`), instead of `source`. |
| `resolveAsset` | `(id) => string \| Blob \| null` (or a Promise) | Fetches assets a thin book does not carry. |
| `config` | `ReaderConfigInput` | Everything below; partial, the rest stays default. |
| `overlay` / `defaultOverlay` | `Overlay` | The student's notes, controlled or as a starting point. |
| `onOverlayChange` | `(overlay) => void` | After every change to the notes. |
| `labStorage` | `{ load, save, clear }` | Where labs keep state (default: this browser). |
| `onLabProgress` | `(progress, { objectId, labId, page }) => void` | A lab reported progress. |
| `onPageChange` | `(index, page) => void` | The current page changed (0-based). |

A ref gives `goTo(page)`, `next()`, `prev()` and `zoomTo(zoom)`.

### Configuration

`DEFAULT_CONFIG` holds every default; `resolveConfig(partial)` shows what a partial config becomes (objects
merge, arrays replace).

| Key | Default | |
|---|---|---|
| `layout` | `'continuous'` | `'single'` or `'spread'` (cover alone, then pairs; wide screens only). |
| `fit` | `'auto'` | `'width'`, `'page'`, or `auto` = fit the width, no wider than a reading width. |
| `zoom` | `{ min: 0.25, max: 5, step: 1.25 }` | |
| `theme` | `'system'` | `'light'` or `'dark'`. |
| `locale` | `'bn'` | `'en'`. The reader's own words only; the book is never translated. |
| `initialPage` | `1` | A 1-based number or a page id. |
| `readOnly` | `false` | No annotations at all. |
| `features.*` | all `true` | `thumbnails`, `search`, `annotations`, `media`, `model3d`, `labs`, `snips`, `fullscreen`, `export`, `keyboard`, `textSelection`, `themeToggle`, `languageToggle`. |
| `dock` | bottom, all items | `false` for none, or `{ position: 'bottom' \| 'top' \| 'left' \| 'right', items }`. Items: `prev page next zoomOut fit zoomIn layout thumbnails search tools undo redo export import theme language fullscreen`, `'|'` for a divider, or your own `{ id, label, icon, onClick, active? }`. What does not fit goes in a "more" menu, least needed first. |
| `annotations.tools` | all but `line` | `pan pen highlighter eraser text rect ellipse line arrow select`. |
| `annotations.defaultTool` | `'pan'` | |
| `annotations.colors` / `highlighterColors` / `sizes` | five / four / `[3, 6, 12]` | |
| `annotations.editBase` | `false` | Let the student move or remove the book's own objects (recorded in the overlay). |
| `labs.autoStart` | `false` | Start the lab on a page as the page opens. |
| `persistence` | `'local'` | Keep notes and lab state in this browser, or `'none'`. |
| `pdfWorkerSrc` | `null` | pdf.js's worker URL, to draw PDF pages that carry no rendered image. With Vite: `import src from 'pdfjs-dist/build/pdf.worker.min.mjs?url'`. |
| `presentation.icons` | built-in | Your artwork per icon name (`ruler`, `atom`, … spec 1.3 §2) or per kind (`video audio model3d lab image plugin snip`): an element or `(size) => element`. A name wins over a kind. |
| `presentation.defaults` | none | Presentation for objects whose author set nothing, per kind, e.g. `{ model3d: { show: 'live', autoRotate: true, accent: '#7c3aed' }, lab: { open: 'fullscreen' } }`. What the author set wins. Accents are `#rrggbb`. |
| `presentation.authorAccents` | `true` | `false`: ignore the colours authors chose; your `defaults` accents (or the theme's) everywhere. |
| `presentation.live` | `true` | `false`: nothing starts by itself (no live models or labs, no autoplay), e.g. to save data. |
| `renderers` | none | Your own player or viewer: `{ video, audio, model3d }`, each `(p) => element` given `{ object, src, poster, presentation, where: 'page' \| 'popup', locale, theme }`. With your own `model3d`, `<model-viewer>` and three.js are never loaded. |

### Theming

Every colour, font, space and radius is a CSS custom property on `.chalk-reader` (`--chalk-desk`,
`--chalk-surface`, `--chalk-accent`, `--chalk-font`, …; see `styles.css`). Override them on the container, or on
`.chalk-reader[data-theme="dark"]` for the dark theme. Nothing leaks outside `.chalk-reader`.

## Author mode

With `config.authoring.enabled`, the reader can also edit the book. A Read / Author switch sits at the start of the
dock (or drive it yourself with the `mode` prop and `onModeChange`).

- **Author mode** looks like an editor (a dotted desk, outlined pages) and has a tool rail on the left, as in
  ChalkBoard: select (V), pen (P), highlighter (H), eraser (E), text (T), shapes (R rectangle, O ellipse, L line,
  A arrow), colour and thickness, and + to add media. Everything drawn goes into the book itself (in read mode
  the same tools write the student's notes). The eraser takes drawings, text and shapes; media is removed by
  selecting it.
- **The sidebar (right)** holds every setting, and shows what the moment needs, as in a design tool:
  - an object selected: position and size (X, Y, W, H), bring to front / send to back, then its kind's settings:
    media presentation (spec 1.3: full size or small icon, thumbnail or live, what a tap opens, label, icon,
    colour, playback), a text's words, size and colour, a shape's line, fill and thickness, a drawing's colour;
  - a drawing tool out: what it draws next (colour, thickness, fill, text size);
  - a media kind picked from +: choose or drop the file, and how it will be presented once added;
  - nothing selected: the book's and the page's titles, the page background, and a list of what is on the page.
  Escape in a field leaves the field; a second Escape clears the selection.
- **Select:** click any object; drag to move it, the corner handle to resize it (media keeps its proportions),
  arrows to nudge, Delete to remove; the object under the mouse is outlined.
- **Add media** from the rail or by dropping files on a page: images, video (a poster is taken from its frames),
  audio, `.glb` models and `.html` labs. Added media gets c1 keys (spec 1.2). Undo and redo cover every change.
- Made for a computer (mouse and keyboard); it still works by touch.
- **Read mode** is the student's reader over the edited book, notes included, so you see exactly what students will.
- **Save** writes a `.chalk` file with every asset it can reach (`onSave(bytes, lesson)` to keep it yourself;
  otherwise it downloads). `onLessonChange` reports every edit. Closing the tab with unsaved changes asks first.

| Option | Default | |
|---|---|---|
| `authoring.enabled` | `false` | Allow author mode. Off for a student app. `readOnly` turns it off. |
| `authoring.startIn` | `'read'` | The mode the reader opens in. |
| `authoring.locale` | `'en'` | Language of the author's tools (sidebar, rail, author dock). `locale` stays the students' language; book content is never translated. |
| `authoring.dock` | mode, pages, page turning, zoom, undo, redo, save, theme, language | The dock in author mode (the tools are in the rail). |

## Restyling media

The book says how the author wants each piece of media presented (spec 1.3: live or a card, what a tap opens,
label, icon, colour). How it looks is yours: theme variables (`--chalk-*`) for the reader as a whole,
`presentation` for icons, colours per kind and defaults, `renderers` to replace a player outright. Cards and
markers carry `data-kind` (`video`, `model3d`, …) for CSS of your own. Try it all in the showcase's Configure
panel, which prints the config for what you set.

## Notes for hosts

- **Bundle:** the reader itself loads with the book (React, the format's validation, the ZIP reader).
  `<model-viewer>` and pdf.js load only when a book needs them.
- **Labs** run in a sandboxed `srcdoc` frame, which inherits the host page's own Content Security Policy:
  a host whose page forbids inline scripts must serve labs from a separate origin (spec 1.1 §3.3).
- **Bengali text from PDFs:** text extracted from PDFs made by Chromium (and many other tools) loses shaped
  Bengali letters (conjuncts, pre-base vowel signs come out as U+0000). Search needs a good text layer;
  build it from the source when you have it, as `apps/reader/showcase/make-showcase.ts` does.
