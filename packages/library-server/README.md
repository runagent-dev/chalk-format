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

Docker, from the repository root: `docker build -f packages/library-server/Dockerfile -t chalk-library-server .`

Every setting, Postgres and S3 setup, bucket CORS, deploying and security:
[docs/guides/run-a-library-server.md](../../docs/guides/run-a-library-server.md). Using libraries in the
reader and the editor: [docs/guides/media-libraries.md](../../docs/guides/media-libraries.md).
