# Run a library server

`packages/library-server` (`@chalk-format/library-server`) is a complete Chalk library server: the
[registry API](../../spec/1.2/registry-api.md) of spec 1.2 that authoring tools use to upload, de-duplicate and
search media. It runs over:

- **Postgres** for the records and search, or **PGlite** (Postgres compiled to WebAssembly, no install) for trying
  it out and for tests;
- **S3-compatible storage** for the bytes (Cloudflare R2, MinIO, AWS S3, Backblaze B2, …), or a folder on the
  server's disk.

Readers never talk to the API. They fetch bytes straight from the library's **delivery store**, the public address
of the bucket (ideally behind a CDN), which the server names at `GET /v1/stores`. Every object sits at
`c1/{h0}/{h1}/{key}`, never changes, and can be cached for ever.

How the editor uses a library server is in [Media libraries](media-libraries.md).

## Try it locally

Node 22.13+ and pnpm 9+, from the repository root. This keeps everything in two folders, with no database or bucket
to set up:

```bash
pnpm install
cd packages/library-server && mkdir -p .data
PORT=8787 DATABASE_URL=pglite:./.data/db STORAGE=disk DISK_DIR=./.data/files \
  TOKENS='me:dev-token,admin!:dev-admin' npx tsx src/cli.ts serve
# chalk library on :8787 · storage disk:./.data/files · readers fetch from http://localhost:8787/files/
```

In another terminal:

```bash
curl localhost:8787/healthz                                  # {"ok":true,"name":"Chalk library"}
cd packages/library-server
npx tsx src/cli.ts check http://localhost:8787 --token dev-token --admin-token dev-admin   # 15 checks, all "ok"
cd ../.. && CHALK_LIBRARY_TOKEN=dev-token npx tsx tools/library-add.ts http://localhost:8787 examples/library-seed.json
```

Then connect `http://localhost:8787` with the token `dev-token` in the reader showcase's Libraries panel (author
mode). `pnpm --filter @chalk-format/library-server dev` runs the same `serve` command; relative paths are relative
to `packages/library-server`.

## Settings

Everything comes from environment variables (`src/config.ts`). `packages/library-server/.env.example` is a
starting point. Never commit the real `.env`.

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | `pglite:` (in memory) | `postgres://user:pass@host:5432/db?sslmode=require`, or `pglite:./dir` to keep PGlite's data in a folder. The Docker image needs Postgres (see below). |
| `DB_SCHEMA` | `chalk_library` | Postgres only. The library keeps everything in this schema (tables, its migration record, `pg_trgm`), so it can share a database with an app. |
| `STORAGE` | `disk` | `s3` or `disk`. |
| `S3_ENDPOINT` | | e.g. `https://<account-id>.r2.cloudflarestorage.com`, `http://minio:9000`, `https://s3.eu-central-1.amazonaws.com`. |
| `S3_BUCKET` | | The bucket. |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | | A key that can read, write, list and delete objects in that bucket. |
| `S3_REGION` | `auto` | R2: `auto`. AWS: the bucket's region. MinIO: usually `us-east-1`. |
| `S3_VIRTUAL_HOSTED` | `false` | `true` puts the bucket in the host name (AWS virtual-hosted style). R2 and MinIO use the path style (`false`). |
| `DISK_DIR` | `./library` | `STORAGE=disk`: where the files go. |
| `UPLOAD_SECRET` | random at start | `STORAGE=disk`: signs upload links. Set it if you run more than one instance, or if uploads must survive a restart. |
| `PUBLIC_URL` | `<SERVER_URL>/files/` | Where readers fetch the bytes: the bucket's public domain or CDN. With disk storage the server serves them itself at `/files/`. |
| `SERVER_URL` | `http://localhost:<PORT>` | This server's own public address, e.g. `https://library.example.org`. Disk storage puts it in upload links, and it is the `iss` of every access token, so set it in production and do not change it casually (tokens issued under the old value stop working). |
| `TOKENS` | none | Bootstrap tokens: `name:token,name:token`. A plain name is an author (reads and writes), a name ending in `!` an administrator (`admin!:…`). Compared in constant time. See [Users, sign-in and API keys](#users-sign-in-and-api-keys). |
| `PUBLIC_READ` | `true` | `false`: searching and reading records needs a token too (any signed-in user or key). Writing always needs one. |
| `ACCESS_TOKEN_TTL` | `900` | Seconds an access token lasts. |
| `REFRESH_TOKEN_TTL` | `2592000` (30 days) | Seconds a refresh token lasts (each use gives a new one). |
| `AUTH_RATE_LIMIT` | `10` | Sign-in attempts per minute and username. |
| `AUTH_RATE_LIMIT_IP` | `60` | Requests to `/v1/auth/token` per minute and client address. Both limits are counted in each process's memory: with several instances the real limit is this times the instances, and a restart clears them. |
| `TRUST_PROXY` | `false` | `true` behind a reverse proxy (Coolify's Traefik, nginx): the client's address is the last `X-Forwarded-For` entry. Leave it `false` when the server is reached directly, or anyone can choose their address. |
| `ORIGINS` | any | Browser origins allowed to call the API (CORS), comma separated, e.g. `https://editor.example.org`. |
| `MAX_BYTES` | `536870912` (512 MiB) | The largest file accepted. |
| `PORT` | `8080` | |
| `NAME` | `Chalk library` | Shown at `/` and `/healthz`. |

Accepted types: images, video, audio, `model/gltf-binary`, PDF, `text/html` and `text/javascript` (labs and the
libraries they import), lab manifests (`application/vnd.chalk.lab+json`) question manifests (`application/vnd.chalk.question+json`, spec 1.7), and the items of books kept in a library
(`application/vnd.chalk.book+json`, `…page+json`, `…text+json`, `…links+json`, spec 1.8).

## Postgres

Any Postgres 13+ where the library's user can create a schema and the `pg_trgm` extension (or where both already
exist). On first start the server:

1. creates `DB_SCHEMA` if it is missing;
2. points every connection's `search_path` at it (then `public`);
3. applies [`spec/1.2/registry.sql`](../../spec/1.2/registry.sql) once, recording it in
   `chalk_library_schema`.

Nothing outside that schema is touched. Search uses trigram similarity on titles, file names and tags, which works
in any script, including Bengali (no Bengali stemmer exists).

## S3-compatible storage

The server uses only standard S3 calls: pre-signed PUT, HEAD, GET, ListObjectsV2, CopyObject and DELETE. Authors'
browsers upload **straight to the bucket** through a pre-signed URL that is valid for 15 minutes. The bytes never
pass through the server. Then the server reads the object back, checks its SHA-256 and size against the key, and
only then makes it available.

What the bucket needs:

1. **Public read at `PUBLIC_URL`.**
   - **R2:** a custom domain on the bucket. Cloudflare's cache then serves it.
   - **AWS:** a bucket policy or CloudFront.
   - **MinIO:** an anonymous download policy.
   - Set `PUBLIC_URL` to that address, with a trailing `/`.
2. **CORS.** Authoring tools PUT from the browser, and readers GET and HEAD from the browser. A pre-signed URL
   carries its own signature, so no `Authorization` header is involved. The browser does send `Content-Type`, and
   sometimes `Range` for video. In the AWS CLI's format (the R2 dashboard takes the inner `CORSRules` list):

   ```json
   {
     "CORSRules": [{
       "AllowedOrigins": ["https://editor.example.org", "https://reader.example.org"],
       "AllowedMethods": ["GET", "HEAD", "PUT"],
       "AllowedHeaders": ["Content-Type", "Range"],
       "ExposeHeaders": ["Content-Length", "Content-Range", "ETag"],
       "MaxAgeSeconds": 86400
     }]
   }
   ```

   ```bash
   aws s3api put-bucket-cors --bucket my-library --cors-configuration file://cors.json \
     --endpoint-url https://<account-id>.r2.cloudflarestorage.com
   ```

   `"AllowedOrigins": ["*"]` is fine for a public library. Uploads still need a pre-signed URL, and only callers
   with a token get one.
3. **An access key** limited to that bucket.

A bucket that already holds media can be adopted: `scan` hashes each object, copies it (server side) to its
standard path, and records it with a title from its file name.

## The command line

```bash
chalk-library serve                       # the API (the default)
chalk-library scan [prefix]               # adopt media already in the storage; again adds only what is new
chalk-library check <url> --token T [--admin-token A]   # conformance: does a server do what the registry API says?
chalk-library check <url> --user U [--admin-token A]    # the same, signed in (password: CHALK_LIBRARY_PASSWORD, a prompt or stdin)
chalk-library user add <username> --roles reader        # users (password: a prompt without echo, or the first line of stdin)
chalk-library user list | disable <username> | enable <username> | password <username>
chalk-library key add <name> --roles author             # API keys for machines; the key is printed once
chalk-library key list | revoke <id>
chalk-library signing-key rotate                        # a new token signing key
```

`user`, `key` and `signing-key` need only `DATABASE_URL` (and `DB_SCHEMA`), not the storage settings.

From the repository use `npx tsx packages/library-server/src/cli.ts <command>`. From a build use
`node dist/server.mjs <command>`.

`check` works against any server that speaks the registry API, not only this one:

- it uploads a small unique file, then checks de-duplication, search (English and Bengali), the type filter, the
  bytes from the delivery store, wrong keys and wrong bytes, and book usage;
- with an admin token, it also withdraws the file.

It leaves one withdrawn test record behind.

## Users, sign-in and API keys

The library is its own identity provider ([registry API §10](../../spec/1.2/registry-api.md#10-authentication)).
Every client sends `Authorization: Bearer <credential>`, one of:

| Credential | For | Made by | Lasts |
|---|---|---|---|
| Access token (a JWT signed with the library's Ed25519 key) | people, in an app | `POST /v1/auth/token` with a username and password | 15 minutes; renewed with the refresh token (30 days, single use) |
| API key `clk_…` | machines: CI, a publisher, an app's server | an administrator (`key add`, `POST /v1/admin/keys`) | until revoked |
| Bootstrap token (`TOKENS`) | the first administrator; existing deployments | the operator, in the environment | until removed from `TOKENS` |

Roles: `reader` (search, records, file bytes, book usage), `author` (reader + upload, register, record book
usage) and `admin` (author + withdraw, users and keys). Apps find the endpoints at
`/.well-known/openid-configuration` and the public keys at `/.well-known/jwks.json`.

What the database keeps: users with scrypt password hashes, the SHA-256 of refresh tokens and API keys, and the
signing keys (table `auth_keys`, made on first start). Whoever can read the library's database can sign tokens, so
treat its credentials like the tokens themselves. `chalk-library signing-key rotate` makes a new key; the old one
stays in JWKS until its tokens have expired (instances re-read keys within 5 minutes).

**Bootstrapping the first administrator.** Either keep an administrator in `TOKENS` (`admin!:<long random>`) and
create users through the API, or, with access to the database, from the command line:

```bash
DATABASE_URL=postgres://… chalk-library user add alice --roles admin   # asks for the password twice
printf '%s\n' "$PW" | DATABASE_URL=… chalk-library user add bob --roles author   # from a script
```

In the Docker image: `docker exec -it chalk-library node server.mjs user add alice --roles admin`.

**Keys for CI and the dashboard.** One key per tool, with the least role it needs, kept in that tool's secret
store:

```bash
chalk-library key add github-publish --roles author     # CI that publishes books and media
chalk-library key add dashboard --roles author          # an app's server that uploads on its users' behalf
chalk-library key add web-reader --roles reader         # a server that only reads
chalk-library key list                                  # names, roles, when last used
chalk-library key revoke <id>                           # stops working at once
```

The same through the API, as an administrator: `POST /v1/admin/keys {"name","roles"}` returns `{ id, key }` once.

**Signing in from an app.** `POST /v1/auth/token` with `{"grant_type":"password","username","password"}` gives
an access token and a refresh token. Before the access token expires, `{"grant_type":"refresh_token",
"refresh_token"}` gives new ones; each refresh token works once, and sending a used one again ends that sign-in
on every device that shares it (theft detection). `POST /v1/auth/revoke {"refresh_token"}` signs out.
`@chalk-format/store`'s `libraryAuth` does all of this for a browser or app.

### Making a library private (PUBLIC_READ=false)

Turning reading off breaks every reader that has no credential, so do it in this order:

1. Deploy this version with `PUBLIC_READ=true` (nothing changes for anyone) and `SERVER_URL` set.
2. Create the users and keys (above), and give every consumer one: the reader apps (users sign in, or a reader
   key on their server), the dashboard, CI, publishers. Check each with `GET /v1/auth/me`, and in `key list` that
   each key has a recent "last used".
3. Set `PUBLIC_READ=false` and restart. Run `chalk-library check <url> --user <an author>` against it.
4. **Make the bucket private.** The server cannot do this: until the bucket (or its CDN domain) stops serving
   objects to anyone, every file is still public at its address. First check that this server delivers files to
   signed-in readers: with `PUBLIC_READ=false`, `GET /v1/stores` must name a store with `"auth": "bearer"` (a
   version without it still points readers at the public bucket, and making the bucket private would break
   them). Then remove the R2 custom domain's public access or the bucket policy; readers get bytes only through
   the library (`GET /v1/files/{key}`, a pre-signed link that lasts minutes).
5. Remove the bootstrap tokens nobody needs any more from `TOKENS`.

To go back, set `PUBLIC_READ=true`.

## Build and run with Docker

The image is built from the **repository root**, because it bundles the workspace packages it uses:

```bash
docker build -f packages/library-server/Dockerfile -t chalk-library-server .
docker run -d --name chalk-library -p 8080:8080 --env-file packages/library-server/.env chalk-library-server
docker exec chalk-library node server.mjs scan          # the CLI inside the container
```

About the image:

- It holds one bundled file (`server.mjs`, made by `build.mjs`) plus `registry.sql`, runs as the `node` user, and
  listens on `PORT` (8080).
- It needs **Postgres**. PGlite is not in the image (it is for local use and tests).
- With `STORAGE=disk`, mount a volume at `DISK_DIR` that the `node` user (uid 1000) can write.

`build.mjs` also works without Docker: `pnpm --filter @chalk-format/library-server build`, then
`node packages/library-server/dist/server.mjs serve`.

## Deploying

Any Docker host or platform (Coolify, Fly.io, Railway, Render, a VM with Docker) works the same way:

1. Build from the repository with the Dockerfile at `packages/library-server/Dockerfile`, with the repository root
   as the build context.
2. Expose port 8080 and put the env variables from the table above in the platform's settings, never in the
   repository. A database on the same private network can be reached by its internal host name.
3. Give it a domain with HTTPS. Set `SERVER_URL` to it, and `PUBLIC_URL` to the bucket's public domain.
4. Health check:
   - The image has its own `HEALTHCHECK`, a Node script that calls `GET /healthz`. That route also checks the
     database.
   - Some platforms run their own probe with `curl` or `wget`, which the slim image does not have. Turn that probe
     off, or point an HTTP probe at `/healthz`.
5. Run `check` against the public address with a test token.

## Security notes

- **Bytes are verified.** An upload counts only after the server has hashed what is in storage. Bytes that do not
  match their key are deleted, and the request is answered with 422. Readers verify again on their side.
- **Code is never served as a page.** A lab's HTML and a library's script are stored as
  `application/octet-stream`, so a public bucket cannot serve them as a web page or script on its own domain. Disk
  delivery (`/files/`) also sends `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff`.
- **Tokens.**
  - Only the SHA-256 of each bootstrap token is kept in memory, and they are compared in constant time. Refresh
    tokens and API keys are stored only as SHA-256, passwords only as scrypt hashes; none is ever logged.
  - Access tokens are verified with Ed25519 only (a token that says `alg: none` or `HS256` is refused), and their
    issuer, audience and expiry are checked. A disabled user's tokens stop working within 10 seconds.
  - Writing needs `author`. Withdrawing, users and keys need `admin`.
  - Sign-in attempts are limited per username and per address (per process; see `AUTH_RATE_LIMIT`).
  - A withdrawn key is deleted from storage, and it can never be uploaded again.
  - Use one token per person or tool, so `uploadedBy` says who added what.
- **What books keep.** Books hold keys only, never the server's address or a token. A token in a browser bundle can
  be read by anyone who has the bundle.
