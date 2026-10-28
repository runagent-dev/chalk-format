# Contributing

Thanks for helping. This page is everything you need to work on the repo: setup, where things are, how to check a
change, and the rules the format lives by. For using the format rather than changing it, start with the
[README](README.md) and the [guides](docs/guides).

## Setup

Node 22.13+ and pnpm 9+.

```bash
pnpm install
pnpm check                                        # lint + typecheck + every package's tests (incl. conformance)
pnpm --filter @chalk-format/reader-app dev        # the showcase at http://localhost:5190
```

The first start of the showcase builds the sample books (about half a minute). Edits to `packages/reader` reload
the page.

## Where things are

| Path | What |
|---|---|
| `spec/<version>/` | The specification, one folder per minor version. Each version only adds to the ones before |
| `schema/` | JSON Schemas generated from the model (`pnpm gen:schema`; CI fails if they are stale) |
| `conformance/` | Packages every reader must accept (`valid/`) or reject (`invalid/`), key test vectors, store examples. Regenerate with `pnpm --filter @chalk-format/conformance generate` (1.0 cases are frozen) |
| `packages/model` | The data model (Zod, the single source of truth), migrations, overlays, asset keys, lab manifests |
| `packages/container` | ZIP pack / unpack / validate, fat and thin books, overlays, streamed books |
| `packages/lab` | Running labs: the reader side (`mountLab`), the lab side (`connectLab`), the sandbox |
| `packages/store` | Asset stores and the resolver; libraries (`deviceLibrary`, `folderLibrary`, `registryLibrary`); the registry API client |
| `packages/reader` | `@chalk-format/reader`: the `<ChalkReader>` React component, including author mode. See its [README](packages/reader/README.md) and [internals](docs/reader-internals.md) |
| `packages/library-server` | A library server (the registry API) over Postgres and S3-compatible storage |
| `packages/pdf-engine`, `packages/convert-pdf`, `packages/cli` | PDF pages → lesson pages (pdf.js), PDF → `.chalk`, the `convert` command |
| `apps/reader` | The showcase site: sample books, Open a book, the Configure playground, author mode |
| `apps/models` | Procedural 3D models and their gallery (`pnpm --filter @chalk-format/models-app dev`, port 5192) |
| `examples/` | Example labs with their manifests; `library-seed.json`, a list for `tools/library-add.ts` |
| `libraries/` | Shared library builds for labs (`catalog.json`; built by `tools/lab-libraries.ts`) |
| `tools/` | Command-line tools and the browser test scripts |

## Checking a change

`pnpm check` must pass. After changing the model, run `pnpm gen:schema` and commit the result.

Changes to the reader are also checked in a real browser. Start the showcase, then run the scripts that cover what
you touched:

```bash
node tools/reader-media-e2e.mjs [url]                # real clicks and taps: 3D, video, lab, audio actually play
npx tsx tools/reader-author-e2e.mjs [url] [shots]    # author mode: select, properties, undo, move, resize, add, save, reopen
npx tsx tools/reader-library-e2e.mjs [url] [shots]   # libraries: gallery, upload, search, reload, missing media
node tools/reader-stream-e2e.mjs [url] [shots]       # a streamed 60-page book: what is fetched, and when
node tools/reader-insert-menu-e2e.mjs [url]          # author mode's right-click menu: what is added lands where you clicked
node tools/reader-save-e2e.mjs [url]                 # author mode's Save: the filled button, Ctrl+S, onDirtyChange, the ref's save()
node tools/reader-shots.mjs out/shots [url] [--steps steps.json]   # desktop + phone screenshots
```

`reader-library-e2e` expects no library server connected. If your `apps/reader/.env.local` names one, start the
showcase without it: `VITE_CHALK_LIBRARY_URL= pnpm --filter @chalk-format/reader-app dev`.

**Visual changes are checked by looking at them**, on desktop and phone: take screenshots and read them.
`reader-shots.mjs` steps are `{ name, waitFor?, select?: [selector, value], click?, eval?, drag?: [[x,y],…],
tap?: [x,y], type?, key?, wait? }`; each step writes `<name>-desktop.png` (1280×800) and `<name>-phone.png`
(390×844, touch, 2×). Coordinates are desktop pixels, scaled for the phone.

For the library server, `pnpm --filter @chalk-format/library-server test` runs the API against PGlite and a
temporary folder, and `chalk-library check <url>` runs the conformance test against a running server (see
[run a library server](docs/guides/run-a-library-server.md)).

## Changing the format

- `packages/model/src/schema.ts` is the source of truth. A change to what a book may contain:
  1. bump `CHALK_FORMAT_VERSION` and add a migration in `migrate.ts`, with a fixture test;
  2. `pnpm gen:schema` to regenerate `schema/`;
  3. add conformance cases and the spec text (a new `spec/1.x/` folder for a new minor version).
- **Within 1.x every change is additive:** new optional fields or new types. Never rename, repurpose or remove a
  field. Every file that was valid stays valid, and older readers keep opening newer books (they skip what they
  do not know, or show a fallback).
- Embeds and the `lab` descriptor are `z.looseObject` on purpose: writers keep fields they do not know.

## The sample book

The showcase's books are built from committed sources by `apps/reader/showcase/make-showcase.ts`
(`pnpm --filter @chalk-format/reader-app showcase`):

- `chapter.html` is a five-page bilingual SSC physics chapter: measuring instruments, the simple pendulum, sound,
  exercises with worked answers. Elements with `data-embed="model3d|video|audio|lab"` mark where media goes;
  `data-snip` marks the snip.
- Chromium prints the chapter to PDF, `@chalk-format/convert-pdf` converts it, and the script adds the media, the
  labs, a snip page, ink notes and an icon-mode audio marker. The text layer comes from the laid-out HTML, because
  Chromium's PDFs carry no Unicode for shaped Bengali (see the [roadmap](docs/roadmap.md)).
- `media/` is made once by `make-media.mjs` (ffmpeg, Playwright's Chromium); the outputs are committed. The 3D
  screw gauge comes from `apps/models`, and rebuilding it gives the same bytes.

## Pitfalls

- **Test interactions with real input**, never `element.click()` from a script: scripted clicks skip hit testing.
  That once hid a layer that covered every media card, so nothing played for a real user while the screenshots
  looked fine. Use Playwright's `click` / `tap`.
- **tsx adds a `__name` helper** to named functions; functions sent to `page.evaluate` then fail. Fix:
  `page.addInitScript({ content: 'window.__name = (f) => f' })`.
- **Pages made with `setContent`** run at `about:blank` and cannot load `file://` fonts. Load a real file.
- React renders after a click asynchronously: wait a tick before querying what the click opened. Pages far from
  the view are not rendered (virtualisation): navigate first. A sandboxed lab's frame is `about:srcdoc`.
- **`exactOptionalPropertyTypes` is on:** optional props need `| undefined` when callers pass possibly-undefined
  values.
- **zsh:** quote `'@chalk-format/x@workspace:*'` in `pnpm add`.
- **Many lab functions and reader helpers are dense one-liners:** put a comment on its own line, never after code.
- **Labs can always navigate their own frame.** The guard reports it and the host stops the lab; a lab can still
  leak what it holds in the URL it navigates to. The spec says so.

## Text and content

- Bengali must render correctly (no tofu, conjuncts intact) and keep its meaning. The Bengali UI attaches the
  classifier to the number ("৩টি", not "৩ টি"). The reader's chrome is translated; a book's content never is.
- Physics and maths in samples and examples must be correct.
- Fonts are Noto Sans and Noto Sans Bengali.

## Commits and pull requests

- Commits are small and scoped, written `type(scope): summary` (`feat(reader):`, `fix(lab):`, `docs(spec):`,
  `test(conformance):`), with a body that says why.
- One pull request per piece of work; CI (lint, typecheck, tests, schema check, lab-library check) must pass.

## Releasing

The workspace is split into small internal packages (`packages/*`, all `private`); four public packages are assembled from
them and published to npm under the `@chalk-format` scope:

| Published | Built from |
|---|---|
| `@chalk-format/core` | `model`, `container`, `store`, `lab` |
| `@chalk-format/reader` | `reader` (+ `pdf-engine` copied in) |
| `@chalk-format/pdf` | `convert-pdf`, `cli` (+ `pdf-engine`) |
| `@chalk-format/library-server` | `library-server` |

```bash
node scripts/assemble-packages.mjs            # builds every internal package with tsc, then assembles dist-packages/<name>/
```

The assembler rewrites imports between internal packages (to a relative file inside the same published package, or to
`@chalk-format/core`), writes each `package.json` from what the code really depends on, and fails if any import in the output is
not a relative file, a Node builtin or a declared dependency. The version of all four is in `release.json`.

Before a release: `pnpm check`, then assemble and install the tarballs (`npm pack` in each `dist-packages/<name>/`) into a clean
project and try them: import from Node, `chalk-pdf convert` a PDF, `chalk-library serve` plus `chalk-library check`, and build a
small Vite + React app with `@chalk-format/reader`.

**Publishing is done by CI, from the `prod` branch.** To release:

1. On `main`, change the version in `release.json` (all four packages share it) and merge.
2. Fast-forward `prod` to `main`: `git push origin main:prod`.
3. `.github/workflows/release.yml` runs the checks, assembles the packages, publishes the ones whose `name@version` is not on npm
   yet (`scripts/publish-packages.mjs`: `core`, `reader`, `pdf`, `library-server`, in that order) and tags `v<version>`.

Pushing `prod` without a version bump publishes nothing. Nothing is published from a branch other than `prod`, and the library
server's Coolify app deploys from `prod` too, so it only redeploys on a release. `node scripts/publish-packages.mjs --dry-run`
shows what a release would publish.

The workflow publishes with npm **trusted publishing** (OIDC), so no npm token is stored in GitHub. It is set up once per
package by an owner of the `@chalk-format` org (npm 12 or newer; each command asks for your 2FA approval):

```bash
for p in core reader pdf library-server; do
  npx npm@latest trust github @chalk-format/$p --repo runagent-dev/chalk-format --file release.yml --allow-publish --yes
done
npm trust list @chalk-format/core        # shows the relationship
```

Provenance statements are added automatically once the repository is public.

## Security

Please report vulnerabilities privately, through GitHub's "Report a vulnerability" on this repository, not in a
public issue.
