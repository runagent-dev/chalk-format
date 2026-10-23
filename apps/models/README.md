# 3D models

Procedural 3D science models (three.js and TypeScript) and the gallery that shows them. Each model is a working
instrument: turn the thimble, close the jaws, read the scales, check your reading. They are the source of the 3D
media in Chalk books: `apps/reader/showcase/make-media.mjs` exports the screw gauge as the sample book's GLB and
poster.

From the repository root:

```bash
pnpm --filter @chalk-format/models-app dev      # the gallery at http://localhost:5192
pnpm --filter @chalk-format/models-app build    # a static build in apps/models/dist/
```

## Models

| Model | Path | Notes |
|---|---|---|
| Screw gauge (micrometer) | `src/models/screw-gauge/` | 0–25 mm, pitch 0.5/1 mm, 50/100 divisions, zero error, tray of 6 objects, ratchet stop |
| Vernier caliper | `src/models/vernier/` | 0–150 mm, 10/20/50 vernier divisions, zero error; outside jaws, inside jaws (ring) and depth rod (acrylic block) |

Each model is a module registered in `src/models/registry.ts` and loaded on demand, so the gallery page
itself never downloads three.js. Models build in millimetres inside a root group scaled to metres, and name
their parts `part:*` (Chalk 3D asset profile) so they can be exported as GLB.

- `model.ts`: geometry and materials (no DOM)
- `reading.ts`: the physics/maths, pure functions (no three.js)
- `page.ts`: interaction and the side panel

Shared code: `src/core/specimen.ts` (poses, tray, tray-to-instrument flight), `src/core/viewer.ts` (renderer, environment light, orbit camera, render on demand) and
`src/core/textures.ts` (canvas textures, scales wrapped around cylinders, knurling).
