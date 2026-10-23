# CLAUDE.md: chalk-format

The `.chalk` interactive book format: spec, schemas, reference reader and writer, conformance, the reference web
reader with author mode, media libraries and a library server. Read [CONTRIBUTING.md](CONTRIBUTING.md) first (setup,
map, checks, pitfalls), then [docs/roadmap.md](docs/roadmap.md) for what is open.

- `pnpm check` before saying done; `pnpm gen:schema` after model changes (CI checks it).
- The showcase: `pnpm --filter @chalk-format/reader-app dev` → http://localhost:5190. A dev server may already be
  running there: check the port, use another one for your own, and stop only processes you started.
- Reader changes are checked in a real browser with real input (`tools/reader-*-e2e.mjs`); visual changes by
  taking screenshots (`node tools/reader-shots.mjs out/shots`) and looking at them, desktop and phone.
- 1.x changes are additive (bump `CHALK_FORMAT_VERSION`, add a migration, conformance cases and spec text).
- Commits: `type(scope): summary`, small, with the Co-Authored-By trailer. Push, PRs, merges and deploys only
  when asked.
- Bengali must render correctly and keep its meaning; physics content must be correct.
- Never commit secrets: `.env` and `.env.local` stay local (`packages/library-server/.env`, `apps/reader/.env.local`).
