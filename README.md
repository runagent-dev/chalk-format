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
| [`spec/1.2`](spec/1.2/README.md) | Chalk 1.2: asset stores (`formatVersion` 9): short `c1:` keys, stores that turn keys into bytes, the reader's resolution rules, and the [registry API](spec/1.2/registry-api.md) authoring tools use (with a [reference database](spec/1.2/registry.sql)) |
| [`schema/`](schema) | JSON Schemas generated from the model, for non-TypeScript readers: lesson, page, overlay, store descriptor, index shard, registry API |
| [`conformance/`](conformance) | Sample packages every reader must accept (`valid/`) or reject (`invalid/`), key test vectors (`keys.json`), store examples (`stores/`) |
| `packages/model` | The data model (Zod, single source of truth), migrations, overlays, asset ids, media sniffing |
| `packages/container` | ZIP pack / unpack / validate, fat and thin bundles, safety limits |
| `packages/pdf-engine` | PDF page → lesson page mapping (PDF.js), shared by browser and Node |
| `packages/convert-pdf` | PDF → `.chalk` in Node |
| `packages/store` | Asset stores: key → URL, the reader's resolver (cache, stores in order, verification), the registry API schemas and client |
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

## Asset stores

A book refers to its media by short keys (`c1:` + 26 characters, derived once from the bytes). The media can
travel inside the book or live in **stores**: buckets where the path is the key, servers with a small sharded
index, or an API. A reader finds an asset with a cache lookup and at most one request, and checks the bytes
against the key, so untrusted stores (a classroom server, a USB drive) are safe. Authoring tools upload,
de-duplicate and search through the **registry API**. See [spec 1.2](spec/1.2/README.md).

```ts
import { assetKey } from '@chalk-format/model';
import { createResolver, createRegistryClient } from '@chalk-format/store';

const key = await assetKey(bytes);                                    // authoring: once per file
const resolver = createResolver({ hostStores, bookStores: assetSources, cache });
const media = await resolver.resolve(object.assetId, 'video/mp4');      // reader: cache, then stores in order
```

## Roadmap

See [spec 1.2 §9](spec/1.2/README.md#9-conformance) for what 1.2 adds and [spec 1.1 §6](spec/1.1/README.md#6-still-on-the-roadmap)
for what is still open: general fallbacks for other new object types (`requires`), host-provided data queries,
learner-state packages, navigation (TOC, page labels, links), and a web reader.

## Origin

Extracted from [runagent-dev/chalkboard](https://github.com/runagent-dev/chalkboard) with full history of
the format packages. See [NOTICE](NOTICE).

## License

[Apache-2.0](LICENSE).
