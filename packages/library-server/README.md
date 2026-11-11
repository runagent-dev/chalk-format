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
```

(PGlite allows one process at a time: stop `serve` first, or use the admin API.) Docker, from the repository root: `docker build -f packages/library-server/Dockerfile -t chalk-library-server .`

It also keeps the **highlights** of books (registry API §11): the lines of a book's text and the questions linked to
them, as records an editor and a matcher change one by one (`v1/books/<slug>/lines`, `…/links`), so reading apps get
them from the library. They are migration step 5 of its database (two tables, `book_lines` and `book_links`), applied
when the server starts.

## Files from the edge: an R2 custom domain behind Cloudflare's cache

A public library (`PUBLIC_READ` unset or `true`) names its bucket's public address in `GET /v1/stores`
(`PUBLIC_URL` + `c1/{h0}/{h1}/{h}`), and readers fetch files there. On S3 storage, `GET /v1/files/{key}` (the address
apps use for a single file: an `<img>` poster, a lab's code) answers `302` to the same file under `PUBLIC_URL`,
kept `public, max-age=86400` (a key's bytes never change; a file adopted in place, which may move to another
copy, `public, max-age=300`); `410` for a withdrawn key, `404` for an unknown one. It pre-signs the bucket instead
(5 minutes, `private, max-age=240`, as a private library always does) for an SVG, which a public address would
send inline so that its script runs on that domain (pre-signed, it is an attachment), and when `PUBLIC_URL` is not
set or is a server's own `/files/` (only a disk library serves that path). A private library
(`PUBLIC_READ=false`) never sends anyone to `PUBLIC_URL`. Those settings for the reference deployment: `STORAGE=s3`,
`PUBLIC_URL=https://assets.pathshalax.com/` (trailing slash), `SERVER_URL=https://library.pathshalax.com`.

For the bytes to come from Cloudflare's edge rather than from the bucket each time, on Cloudflare (R2 objects carry
no `Cache-Control`, so without a rule a custom domain answers `cf-cache-status: DYNAMIC`):

1. **Public access through the custom domain only.** R2 → the bucket → Settings → *Public access* → *Custom
   domains* → connect `assets.example.org` (a domain in the same Cloudflare account; it is proxied by itself).
   *R2.dev subdomain*: *Disallowed* (it is rate-limited and never cached).
2. **Cache Rule** (the zone of that domain → Caching → Cache Rules → Create rule → *Edit expression*):
   ```
   (http.host eq "assets.example.org" and starts_with(http.request.uri.path, "/c1/"))
   ```
   *Eligible for cache*; Edge TTL *Ignore cache-control header and use this TTL* → 1 year, with a status code TTL
   `404` → *No cache* (a key asked for before its upload finished, or adopted elsewhere, must not stay missing;
   without status code TTLs on the plan, use 1 day); Browser TTL *Override origin* → 1 day (a browser cannot be
   purged: this is how long it may keep a file that was withdrawn); Cache key
   *Ignore query string*. Only `c1/` is matched: files adopted in place (`chalk-books/…`) can be replaced by the
   tool that wrote them, so they are left to Cloudflare's defaults.
3. **CORS** (the bucket → Settings → CORS): readers fetch from the browser, sometimes with `Range`.
   ```json
   [{ "AllowedOrigins": ["*"], "AllowedMethods": ["GET", "HEAD"], "AllowedHeaders": ["Range"],
      "ExposeHeaders": ["Content-Length", "Content-Range", "ETag"], "MaxAgeSeconds": 86400 }]
   ```
   Keep `*` rather than a list of origins: with a list the bucket answers per origin (`Vary: Origin`), which
   Cloudflare's cache ignores, so one site's answer would be served to another. Authors' uploads go to the bucket's
   S3 endpoint (pre-signed `PUT`), not through this domain; their CORS rule is the one in the guide below.
4. **Withdrawing** a key deletes its object, but the edge keeps a copy for its 1-year TTL: purge it too (Caching →
   Configuration → *Custom purge* → URL `https://assets.example.org/c1/<h0>/<h1>/<h>`). Browsers are not reached
   by a purge: one that fetched the file may show it for up to a day more (Browser TTL), and one that followed
   `/v1/files` may follow the kept redirect for up to a day (5 minutes for a file adopted in place), after which it
   gets the `410`.
5. **Optional, defence in depth** (Rules → Transform Rules → *Modify Response Header*, when
   `http.host eq "assets.example.org"`): set `Content-Security-Policy: sandbox` and
   `X-Content-Type-Options: nosniff`, so that nothing the bucket holds can ever run as a page on that domain
   (`<img>`, `<video>`, `fetch` and model loaders are not affected by either header).

Check, with a key that is there:

```bash
curl -sI <SERVER_URL>/v1/files/c1:<h> | grep -i '^location\|^cache-control'   # PUBLIC_URL/c1/<h0>/<h1>/<h>, public, max-age=86400
curl -sI https://assets.example.org/c1/<h0>/<h1>/<h> | grep -i '^cf-cache-status'   # MISS, then:
curl -sI https://assets.example.org/c1/<h0>/<h1>/<h> | grep -i '^cf-cache-status'   # HIT
```

Every setting, Postgres and S3 setup, bucket CORS, deploying and security:
[docs/guides/run-a-library-server.md](../../docs/guides/run-a-library-server.md). Using libraries in the
reader and the editor: [docs/guides/media-libraries.md](../../docs/guides/media-libraries.md).
