# CLAUDE.md: chalk-format

The `.chalk` interactive book format: spec, schemas, reference reader/writer, conformance, and the reference web
reader (`packages/reader`, showcase in `apps/reader`). **Start by reading [HANDOFF.md](HANDOFF.md)**: what is done,
what is next, how to run and verify, and the pitfalls already hit.

- `pnpm check` before saying done; `pnpm gen:schema` after model changes (CI checks it).
- The showcase: `pnpm --filter @chalk-format/reader-app dev` → http://localhost:5190.
- Visual changes are verified by looking: `node tools/reader-shots.mjs out/shots` (desktop + phone), then read the PNGs.
- 1.x changes are additive (bump `CHALK_FORMAT_VERSION`, add a migration, conformance cases and spec text).
- Commits: `type(scope): summary`, small, ending with the Co-Authored-By trailer. Push, PRs, merges and deploys
  only when the user asks.
- Bengali must render correctly and keep its meaning; physics content must be correct.
