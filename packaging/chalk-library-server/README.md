# @chalk-format/library-server

A **media library server for `.chalk` books**: the registry API authoring tools use to upload, de-duplicate and
search images, video, sound, 3D models and labs. Records in Postgres (or PGlite, with nothing to install), bytes in
any S3-compatible storage (Cloudflare R2, MinIO, AWS S3) or a folder. Readers fetch the bytes straight from the
bucket's public address.

Try it with nothing to set up:

```bash
DATABASE_URL=pglite:./data/db STORAGE=disk DISK_DIR=./data/files TOKENS='me:dev-token' PORT=8787 \
  npx @chalk-format/library-server serve
npx @chalk-format/library-server check http://localhost:8787 --token dev-token     # the API conformance test
```

(Installed, the command is `chalk-library`.) Or embed it: `import { createLibraryApp, libraryFromEnv } from '@chalk-format/library-server'`.

Every setting, Postgres and S3 setup, bucket CORS, Docker and deployment:
[running a library server](https://github.com/runagent-dev/chalk-format/blob/main/docs/guides/run-a-library-server.md).
Apache-2.0.
