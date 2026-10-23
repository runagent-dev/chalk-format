# chalk-3d

Programmatic 3D science models (three.js + TypeScript) and the gallery that shows them.

```bash
npm install
npm run dev        # gallery on http://localhost:5173
npm run build      # static build in dist/
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
