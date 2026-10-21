# Handoff: chalk-format

Read this first in a new conversation. Last updated 2026-10-21.

## What this repo is

`runagent-dev/chalk-format` (private, Apache-2.0): the **`.chalk` interactive book format**. It holds the
spec, the JSON Schemas, the reference reader and writer, the converters, the conformance tests, and now the
**reference web reader**. It was extracted from `runagent-dev/chalkboard` (the ChalkBook smartboard app)
with the format packages' history. Every RunAgent learning product is meant to share it: ChalkBook,
web/mobile apps, and PathshalaX (a 3D virtual science lab for SSC/HSC students in Bangladesh).

A `.chalk` file is a ZIP: `manifest.json`, `pages/page-N.json` (a background plus positioned objects, and an
optional text layer), assets addressed by `sha256:`, and optionally an overlay (a student's notes).

## Where things stand

| | State |
|---|---|
| `main` | Chalk 1.0 Core (7), **1.1 labs** (8), **1.2 asset stores** (9), and **the reference reader** (PRs #1–#3, merged) |
| `feat/presentation` | **Chalk 1.3 presentation** (`formatVersion` 10) + **host restyling** + **author mode**, on top of `main`, **not pushed**. Spec `spec/1.3/`; `presentation` on images and embeds (live or card, what a tap opens, label, icon, accent, playback); `config.presentation` / `config.renderers` (host icons, colours, defaults, own players); `config.authoring` (Read/Author switch, select/move/resize, properties panel, add media, save). |
| `feat/streamed-books` | **Chalk 1.4 streamed books**, on top of `feat/presentation` (PR #4): spec `spec/1.4/`; `publishStreamed` / `assembleStreamed` (container); `openStreamedBook` in the reader (index first, ±window, priority, cancelled jumps, search through `text.json`, author mode loads all); `tools/chalk-stream.ts`; showcase samples `Streamed: …` (incl. a 60-page book); `tools/reader-stream-e2e.mjs` watches the network. Not yet: reading a `.chalk` by byte ranges (spec §7), host stores for streamed books' external media, thumbnails for books that have none. |
| CI | `.github/workflows/ci.yml`: lint, typecheck, tests, and "schema/ matches the model" |

The plan and phase status for the reader live in [`docs/reader-plan.md`](docs/reader-plan.md).

## Map

| Path | What |
|---|---|
| `spec/1.0/README.md` | Chalk 1.0 Core |
| `spec/1.1/README.md`, `spec/1.1/host-api.md` | Labs (`embed: "plugin"`, `plugin: "chalk.lab"`) and the Host API (lab ↔ reader protocol) |
| `schema/` | JSON Schemas, generated: `pnpm gen:schema` (CI fails if stale) |
| `conformance/` | `valid/` and `invalid/` sample packages + `cases.json`; regenerate with `pnpm --filter @chalk-format/conformance generate` (1.0 cases are frozen, written only if missing) |
| `packages/model` | Zod model (single source of truth), migrations, overlays (`composeOverlay` / `diffLesson`), media sniffing, `isLabEntryBytes` |
| `packages/container` | ZIP pack / unpack / validate, fat and thin bundles, overlays |
| `packages/lab` | Running labs: `mountLab` / `createLabHost` (reader side), `connectLab` (lab side), sandbox + CSP + guard |
| `packages/reader` | **`@chalk-format/reader`**: `<ChalkReader>` (React). Has its own [README](packages/reader/README.md) with props and the full config |
| `packages/pdf-engine`, `packages/convert-pdf`, `packages/cli` | PDF → page mapping (pdf.js), PDF → `.chalk`, the `convert` command |
| `apps/reader` | The showcase site (Vite + React): sample books, Open a book, Configure playground |
| `apps/reader/showcase/` | Sources of the sample book (see "The sample book") |
| `examples/labs/pendulum.html` | Example lab, speaking the Host API by hand |
| `tools/reader-shots.mjs` | Desktop + phone screenshots of the running app, with scripted steps |
| `docs/reader-plan.md` | Reader decisions and phases |

## Run, check, look

```bash
pnpm install
pnpm check                                        # lint + typecheck + all tests (338 at last count)
pnpm --filter @chalk-format/reader-app dev        # the showcase at http://localhost:5190
pnpm --filter @chalk-format/reader-app showcase   # rebuild the sample books
pnpm --filter @chalk-format/reader-app build      # production build (apps/reader/dist)
node tools/reader-shots.mjs out/shots [url] [--steps steps.json]
node tools/reader-stream-e2e.mjs [url] [shots]    # a streamed 60-page book: what is fetched on open, on a jump, for search, for author mode
npx tsx tools/chalk-stream.ts publish book.chalk out/dir/   # a .chalk as a streamed book (and `pack dir/ book.chalk` back)
node tools/reader-media-e2e.mjs [url]             # real clicks (desktop) and taps (phone): 3D, video, lab, audio play
npx tsx tools/reader-author-e2e.mjs [url] [shots] # author mode with real input: select, properties, undo, move, resize, add files, save and reopen
```

`reader-shots.mjs` steps: `{ name, waitFor?, select?: [selector, value], click?, eval?, drag?: [[x,y],…],
tap?: [x,y], type?, key?, wait? }`. It shoots `<name>-desktop.png` (1280×800) and `<name>-phone.png`
(390×844, touch, 2×) for each step and prints page errors. Coordinates are desktop px, scaled for phone.
`eval` runs before pointer input. Read the PNGs: **every visual change is checked by looking at it**, desktop
and phone.

A dev server on :5190 may still be running from the last session; its PID is not tracked here. Before
starting one, check the port (`lsof -i :5190`). Only stop processes you started.

## The reference reader (`packages/reader`)

Built in phases (see `docs/reader-plan.md`). Phases 1–5 are done; phase 6 is partly done.

- **Rendering is DOM/SVG, not canvas.** Each page is one box in page units scaled to the screen. Vector
  objects are batched into SVG runs, while text, embeds and snips are HTML between them, so array order
  (the spec's draw order) holds. The text layer is invisible, selectable spans, each stretched to its
  recorded width.
  - `src/render/PageView.tsx`, `TextLayer.tsx`, `ink.ts` (perfect-freehand, same settings as ChalkBook), `Markers.tsx` (cards, 56 px markers).
- **Viewer** (`src/Viewer.tsx`):
  - continuous / single / spread layouts, fit `auto` (default: fit the width, max 900 px per page) / `width` / `page`;
  - zoom keeps the anchor still (buttons, keys, ctrl+wheel, pinch);
  - virtualised: pages beyond about one screen are sized boxes only;
  - the current page is the row with the largest visible share.
- **Dock** (`src/Dock.tsx`):
  - its items, order and position come from config, and hosts can add custom items;
  - when it overflows, items move into a "more" menu least-needed first (the `NEED` table); tools and page turning stay;
  - side docks become bottom docks below 720 px.
- **Panels** (`src/panels/`): thumbnails (inert previews: a thumbnail is a button) and search (`src/search.ts`: NFC + case-fold, matches widened to whole grapheme clusters, hits highlighted). A side sheet on wide readers, a bottom sheet below 720 px (container query on `.chalk-reader`).
- **Media** (`src/render/Embeds.tsx`):
  - video plays inline; audio is a player bar drawn in page units;
  - 3D uses `<model-viewer>` (dynamic import);
  - labs use `LabFrame`: `mountLab`, poster until ready, `setVisible` via IntersectionObserver and tab visibility, state in `labStorage` (localStorage by default);
  - one live embed at a time, drawn in **screen pixels** above the page (`.chalk-page-active`) so iframes and canvases stay sharp;
  - if the box on screen is smaller than 440×260 px, the lab or model opens in a dialog instead (full reader on phones);
  - icon markers and snips open in `Modal.tsx`.
- **Annotations** (`src/annotate/`):
  - `state.ts`: `useAnnotations` keeps the edited lesson; the overlay is always `diffLesson(base, edited)`; history has one entry per gesture;
  - `Surface.tsx`: pointer tools in page units;
  - `ToolsMenu.tsx`: the dock popover;
  - `ops.ts`: hit-testing and moves, tested;
  - only the student's own objects can be edited unless `annotations.editBase`;
  - saved to localStorage (`chalk:<lessonId>:overlay`), reported via `onOverlayChange`, saved and opened as an overlay `.chalk`.
- **PDF fallback** (`src/render/pdf.ts`): a `pdf_page` without `renderedImageAssetId` is drawn with pdf-engine/pdf.js when `config.pdfWorkerSrc` is set (the showcase sets it with Vite `?url`).
- **Config** (`src/config.ts`): `DEFAULT_CONFIG` + `resolveConfig()` (objects merge, arrays replace). The full table is in the package README.
- **Styling** (`src/styles.css`):
  - every value is a `--chalk-*` token on `.chalk-reader`, with dark mode under `[data-theme="dark"]`;
  - nothing leaks outside `.chalk-reader`; `fonts.css` bundles Noto Sans + Noto Sans Bengali;
  - design tone (chosen with the user): **utilitarian, warm**: paper-grey desk, one ink-blue accent, compact floating dock, no gradients.
- **Strings** (`src/i18n.ts`): Bengali (default) and English, with Bengali digits via `num()`. The reader's chrome is translated; the book never is.

Verified in the browser with real clicks and taps (`tools/reader-media-e2e.mjs`): every embed type, labs (sandbox holds), search with Bengali, notes save → wipe
storage → reopen (the file is a valid overlay), the PDF fallback, the playground, desktop and phone.

## The sample book

All built from committed sources by `apps/reader/showcase/make-showcase.ts`:

- `chapter.html`: a 5-page bilingual SSC physics chapter.
  - Contents: measuring instruments (vernier constant 0.1 mm; screw gauge pitch 0.5 mm / 50 divisions, least count 0.01 mm), the simple pendulum (T = 2π√(L/g) ≈ 2.01 s for 1 m), sound (λ = 332 ÷ 440 ≈ 0.75 m), exercises with worked answers.
  - Elements with `data-embed="model3d|video|audio|lab"` mark where the media goes; `data-snip` marks the snip.
- Pipeline: Chromium prints the chapter to PDF → `@chalk-format/convert-pdf` → the script adds the media, the lab, a snip page, the book's own ink notes and an icon-mode audio marker → `public/samples/showcase.chalk`. It also writes `pdf-only.chalk` (no rendered images).
- **The text layer comes from the laid-out HTML, not the PDF:** see "Known problems".
- `media/` is made once by `make-media.mjs` (needs ffmpeg, Playwright's Chromium, and a `chalk-3d` checkout next to this repo):
  - the pendulum video, recorded from a canvas (WebM);
  - a 440 Hz tone (MP3);
  - chalk-3d's screw gauge exported as GLB with a rendered poster;
  - the lab poster (Bengali locale).

## Known problems and what is next

1. **Bengali text from PDFs is broken.** Chromium's PDF output (and many other tools') has no Unicode for shaped Bengali glyphs (conjuncts, pre-base vowel signs); pdf.js reads them as U+0000, so search on a converted Bengali PDF fails. Real textbooks in older Bijoy-style fonts will be worse. `convert-pdf` needs OCR or legacy-encoding → Unicode conversion. Not started.
2. **Phase 6 is not finished:** an accessibility audit with a screen reader, a performance check on a cheap Android phone, a smaller first download (179 KB gzip: React + zod validation + JSZip; pdf.js and model-viewer already load on demand), deploying the showcase.
3. **Author mode, next:** it has ChalkBoard's tools (rail: select, pen, highlighter, eraser, text, shapes, media) and
   a Figma-style right sidebar that holds every setting (selection › media being added › tool › page). The user
   asked for exactly that: all configuration in the right sidebar, by context. The user wants it desktop-first (mouse and keyboard). Still
   missing: editing lab settings (`lab.params`), replacing a poster, editing text in place (it is edited in the
   panel), a snip-region tool, pages (add, reorder, import from PDF), the media library over
   the registry (search and reuse; needs the registry service, see 5). Audio shows as a card in author mode, not as
   its player bar. Push `feat/presentation` and open a PR: ask the user.
4. **Switching chalkboard to chalk-format:** not started. Do it on a separate branch in a separate worktree. Chalkboard's `feat/interactive-lab-embed` branch has a stale uncommitted WIP (from 2026-08-29) that adds `embed: "lab"` as `formatVersion` 8, which conflicts with Chalk 1.1. Don't build on it, and don't touch that working tree.
5. **Asset stores (1.2), next steps:** push and PR `feat/asset-stores`; make the reader use `@chalk-format/store`'s
   resolver (host stores from config, the book's `assetSources`, a Cache Storage cache, `locate()` for video);
   build a registry service (open questions for the user: Cloudflare R2 or MinIO on Coolify for the bucket, and
   whether the service is its own app or part of `runagent-middleware-v2`); the authoring UI on top of it
   (author mode exists now, see 3; its media library waits for the registry).
6. **Spec roadmap** (`spec/1.1/README.md` §6): general fallbacks for other new object types (`requires`), host-provided data queries (the reserved `data` capability), learner-state packages, navigation (TOC, links), reflowable text.

## Pitfalls already hit

- **Test interactions with real input, never `element.click()` from a script.** Scripted clicks skip hit
  testing. That once hid a bug where the invisible text layer covered every media card, so nothing played for a
  real user while the screenshots looked fine. Use `click`/`tap` steps or Playwright's `p.click`/`p.tap`, and run
  `tools/reader-media-e2e.mjs` after touching the reader's layers.
- **Scripts run with tsx** add a `__name` helper to named functions; functions sent to `page.evaluate` then fail. Fix: `page.addInitScript({ content: 'window.__name = (f) => f' })`.
- **Pages created with `setContent`** run at `about:blank` and cannot load `file://` fonts. Load from a real file (`make-media.mjs` `filePage`).
- **Scripted UI steps:**
  - React renders after `element.click()` asynchronously, so wait a tick before querying what the click opened;
  - pages far from the view are not rendered (virtualisation), so navigate first;
  - in a sandboxed lab the iframe is `about:srcdoc`.
- **Zod `z.object` strips unknown keys.** Embeds and the `lab` descriptor are `z.looseObject` on purpose: writers must preserve fields they don't know.
- **`exactOptionalPropertyTypes` is on:** optional props need `| undefined` when callers pass possibly-undefined values.
- **zsh:** quote `'@chalk-format/x@workspace:*'` in `pnpm add`.
- **Labs and navigation:** a frame can always navigate itself. The guard script reports `gone` with a per-mount nonce, and the host stops the lab. A lab can still leak data it holds in the URL it navigates to; the spec says so.
- **Bengali UI text:** the classifier attaches to the number ("৩টি", not "৩ টি").

## Conventions

- **Commits:** `type(scope): summary` (`feat(reader):`, `fix(lab):`, `docs(spec):`, `test(conformance):`), small and scoped, with a body explaining why, and ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. PR descriptions end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- **Before saying done:** run `pnpm check` and, after model changes, `pnpm gen:schema` (commit the result). Changes in 1.x stay additive: bump `CHALK_FORMAT_VERSION` + add a migration + conformance cases + spec text.
- **Correctness:** physics content must be correct, and Bengali must render (no tofu, conjuncts intact) and keep its meaning.
- **Outward-facing actions:** push, PRs, merges and deploys happen when the user asks.

## Related repos (siblings of this one)

- `../chalkboard`: the ChalkBook app (React 18, Konva). The source the format came from. See point 4 above.
- `../chalk-3d`: procedural three.js models (screw gauge, vernier caliper) and their gallery; the screw gauge GLB in the sample book comes from here.
- `../../practice_runagent/pathshalax`: the PathshalaX site and 3D lab (has its own CLAUDE.md and HANDOFF.md).
