# chalk-format

The **`.chalk` interactive book format**: specification, schema, reference reader/writer, converters and
conformance tests. One format shared by every RunAgent learning product: the ChalkBook smartboard, the web
and mobile apps, and PathshalaX.

A `.chalk` file is a ZIP holding an ordered set of pages. Each page has a background (a rendered PDF page,
an image, a colour) and positioned objects on top (ink, text, shapes, images, video/audio/3D embeds),
with a searchable text layer. Assets are content-addressed (`sha256:…`) and either travel inside the file
("fat", works offline) or are fetched by hash ("thin", small download).

## What's here

| Path | What it is |
|---|---|
| [`spec/1.0`](spec/1.0/README.md) | The written specification (Chalk 1.0 Core = `formatVersion` 7) |
| [`schema/`](schema) | JSON Schemas generated from the model, for non-TypeScript readers |
| [`conformance/`](conformance) | Sample packages every reader must accept (`valid/`) or reject (`invalid/`) |
| `packages/model` | The data model (Zod, single source of truth), migrations, overlays, asset ids, media sniffing |
| `packages/container` | ZIP pack / unpack / validate, fat and thin bundles, safety limits |
| `packages/pdf-engine` | PDF page → lesson page mapping (PDF.js), shared by browser and Node |
| `packages/convert-pdf` | PDF → `.chalk` in Node |
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

## Roadmap

See [spec §7](spec/1.0/README.md#7-roadmap-not-part-of-10). Next up: the 1.1 compatibility rules (fallbacks
for unknown object types), `lab` embeds with a Host API, navigation (TOC, page labels, links), and a web reader.

## Origin

Extracted from [runagent-dev/chalkboard](https://github.com/runagent-dev/chalkboard) with full history of
the format packages. See [NOTICE](NOTICE).

## License

[Apache-2.0](LICENSE).
