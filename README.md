# chalk-format

The **`.chalk` interactive book format**: specification, schema, reference reader/writer, converters and
conformance tests. One format shared by every RunAgent learning product: the ChalkBook smartboard, the web
and mobile apps, and PathshalaX.

A `.chalk` file is a ZIP holding an ordered set of pages. Each page has a background (a rendered PDF page,
an image, a colour) and positioned objects on top (ink, text, shapes, images, video/audio/3D embeds, and
interactive **labs**: simulations that run offline in a sandbox), with a searchable text layer. Assets are content-addressed (`sha256:…`) and either travel inside the file
("fat", works offline) or are fetched by hash ("thin", small download).

## What's here

| Path | What it is |
|---|---|
| [`spec/1.0`](spec/1.0/README.md) | The written specification (Chalk 1.0 Core = `formatVersion` 7) |
| [`spec/1.1`](spec/1.1/README.md) | Chalk 1.1: labs (`formatVersion` 8) and the [Host API](spec/1.1/host-api.md) labs use to talk to the reader |
| [`schema/`](schema) | JSON Schemas generated from the model, for non-TypeScript readers |
| [`conformance/`](conformance) | Sample packages every reader must accept (`valid/`) or reject (`invalid/`) |
| `packages/model` | The data model (Zod, single source of truth), migrations, overlays, asset ids, media sniffing |
| `packages/container` | ZIP pack / unpack / validate, fat and thin bundles, safety limits |
| `packages/pdf-engine` | PDF page → lesson page mapping (PDF.js), shared by browser and Node |
| `packages/convert-pdf` | PDF → `.chalk` in Node |
| [`packages/reader`](packages/reader) | **The reference reader**: `<ChalkReader>`, a configurable React component (pages, search, media, 3D, labs, the student's notes as an overlay) |
| [`apps/reader`](apps/reader) | The reader's showcase site: a bilingual sample book and a configuration playground (`pnpm --filter @chalk-format/reader-app dev`) |
| `packages/lab` | Running labs: `mountLab` / `createLabHost` for readers, `connectLab` for labs, the sandbox and CSP |
| [`examples/labs`](examples/labs) | Example labs (one self-contained HTML file each) |
| `packages/cli` | Command line: `convert` |
| `packages/conformance` | Runs the conformance corpus against the reference implementation |
| `spec/design-history` | The original ChalkBook design documents for the format |

## Quick start

Node 22.13+ and pnpm 9+.

```bash
pnpm install
pnpm check                       # lint + typecheck + all tests (incl. conformance)

# Convert a PDF into a .chalk book
pnpm --filter @chalk-format/cli start convert ./book.pdf -o book.chalk \
    --title "Higher Math" --locale bn --license "All rights reserved"
```

## Working on the format

- `packages/model/src/schema.ts` is the source of truth. After changing it:
  1. bump `CHALK_FORMAT_VERSION` and add a migration in `migrate.ts` with a fixture test;
  2. `pnpm gen:schema` to regenerate `schema/` (CI fails if it is stale);
  3. add conformance cases (`pnpm --filter @chalk-format/conformance generate`) and update the spec.
- Changes within 1.x must be **additive**: new optional fields or new types. Never rename, repurpose or
  remove a field. Every file that was valid stays valid.
- Commits follow `type(scope): summary`, e.g. `feat(model):`, `fix(convert-pdf):`.

## Labs

A lab is one self-contained HTML file placed on a page. The reader runs it in a sandbox where it cannot
fetch anything, and gives it its `params`, saved state and the book's assets through the
[Host API](spec/1.1/host-api.md). A lab is confined to what it is given, not a container for secrets
([spec 1.1 §3.3](spec/1.1/README.md#33-sandbox-normative-for-hosts)).
Books with labs still open in 1.0 readers, which show the lab's poster instead.

```ts
// in a reader
import { mountLab } from '@chalk-format/lab';
const { host } = await mountLab(box, { lab: object.lab, entry: entryBytes, locale: 'bn', visible: onScreen,
  loadState, saveState, getAsset, onReady: hidePoster, onProgress });
host.setVisible(false);   // when the page scrolls away: the lab stops rendering (before or after it starts)

// in a lab (or speak the protocol by hand, as examples/labs/pendulum.html does)
import { connectLab } from '@chalk-format/lab/client';
const lab = await connectLab({ id: 'org.example.pendulum', version: '1.0.0' });
```

## Roadmap

See [spec 1.1 §6](spec/1.1/README.md#6-still-on-the-roadmap): general fallbacks for other new object types
(`requires`), host-provided data queries, learner-state packages, navigation (TOC, page labels, links), and
a web reader.

## Origin

Extracted from [runagent-dev/chalkboard](https://github.com/runagent-dev/chalkboard) with full history of
the format packages. See [NOTICE](NOTICE).

## License

[Apache-2.0](LICENSE).
