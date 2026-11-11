# @chalk-format/library-server

A Chalk library server: the [registry API](../../spec/1.2/registry-api.md) (spec 1.2) over Postgres and
S3-compatible storage (Cloudflare R2, MinIO, AWS S3, …) or a disk. Authoring tools upload, de-duplicate and search
media through it. Readers fetch the bytes from the bucket's public address. It includes a conformance check for any
registry server.

Try it locally, with no database or bucket to set up:

```bash
pnpm install && cd packages/library-server && mkdir -p .data
PORT=8787 DATABASE_URL=pglite:./.data/db STORAGE=disk DISK_DIR=./.data/files \
  TOKENS='me:dev-token,admin!:dev-admin' npx tsx src/cli.ts serve
npx tsx src/cli.ts check http://localhost:8787 --token dev-token --admin-token dev-admin
```

Users and API keys (the library issues its own tokens; spec 1.2 registry API §10):

```bash
DATABASE_URL=pglite:./.data/db npx tsx src/cli.ts user add alice --roles admin    # asks for a password
DATABASE_URL=pglite:./.data/db npx tsx src/cli.ts key add ci --roles author       # prints the key once
DATABASE_URL=pglite:./.data/db npx tsx src/cli.ts key add dashboard --roles admin --act-for   # may send Chalk-Actor (acts for its people)
DATABASE_URL=postgres://owner… npx tsx src/cli.ts migrate                          # the release step when MIGRATE_ON_START=false
```

An app's server can act for its signed-in people with a key made `--act-for`: it sends `Chalk-Actor` (base64url
JSON `{"id": "staff:<id>", "name"}`), and the library records the person's id (registry API §10.7). `staff:` and
`system:` ids are reserved for this: every writer that names a person or a job (a staff dashboard, a sync job sending
`system:library-sync`) needs its own `--act-for` key; a plain key sending such a `by` gets `400 actor_requires_act_for`.
`HUMAN_ACCOUNTS=off` runs the library with keys and `TOKENS` only (§10.8). The keys and settings of such a
deployment, one by one: [run a library server](../../docs/guides/run-a-library-server.md#a-deployment-whose-people-sign-in-elsewhere-keys-and-settings).

(PGlite allows one process at a time: stop `serve` first, or use the admin API.) Docker, from the repository root: `docker build -f packages/library-server/Dockerfile -t chalk-library-server .`

It also keeps the **highlights** of books (registry API §11): the lines of a book's text and the questions linked to
them, as records an editor and a matcher change one by one (`v1/books/<slug>/lines`, `…/links`), so reading apps get
them from the library. They are migration step 5 of its database (two tables, `book_lines` and `book_links`), applied
when the server starts (or by `chalk-library migrate` with `MIGRATE_ON_START=false`).

Every setting, Postgres and S3 setup, bucket CORS, deploying and security:
[docs/guides/run-a-library-server.md](../../docs/guides/run-a-library-server.md). Using libraries in the
reader and the editor: [docs/guides/media-libraries.md](../../docs/guides/media-libraries.md).
