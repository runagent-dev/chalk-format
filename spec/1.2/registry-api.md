# Chalk registry API, version 1

**Status:** Draft, part of [Chalk 1.2](README.md). The HTTP API between authoring tools and a **registry**:
the database of a library's assets (their keys, facts and locations) and the stores behind it. Students'
devices do not use it; they resolve assets through stores (1.2 §6). Request and response shapes are in
[`schema/registry.schema.json`](../../schema/registry.schema.json); a reference database is in
[registry.sql](registry.sql).

## 1. Conventions

- Base URL: the registry's, e.g. `https://store.example.org/`. Paths below are relative to it.
- JSON bodies, UTF-8. Times are ISO 8601 UTC.
- **Auth:** `Authorization: Bearer <token>`. How tokens are issued is up to the deployment; a registry that
  issues its own follows §10. Reading the public library MAY be open; everything else needs a token. A request
  without a valid token where one is needed is answered `401 unauthorized`; a valid token without the permission,
  `403 forbidden`.
- **Errors:** an HTTP status and `{ "error": { "code": "…", "message": "…" } }`. Codes: `invalid`,
  `unauthorized`, `forbidden`, `not_found`, `conflict`, `too_large`, `unsupported_type`, `verification_failed`,
  `gone`.
- **Pagination:** list endpoints return `{ items, next }`; pass `next` back as `cursor`. `next` absent means
  the end.

## 2. The asset record

What the registry knows about one asset:

```json
{
  "key": "c1:jf3zbfd5izthmdhdr46ab2csy4",
  "sha256": "497790947d4666760ce38f3c00e852c71fdb66cae849bae8e9ede352719e1581",
  "type": "model/gltf-binary", "size": 1556468,
  "meta": { "width": null, "height": null, "duration": null },
  "title": "Screw gauge · স্ক্রু গজ", "filename": "screw-gauge.glb",
  "tags": ["physics", "measurement"], "subject": "physics", "license": "CC BY 4.0",
  "poster": "c1:…", "renditions": ["c1:…"],
  "status": "available",
  "uploadedBy": "user-123", "createdAt": "2026-10-21T09:00:00Z",
  "locations": [{ "store": "media-r2", "path": "c1/jf/3z/jf3zbfd5izthmdhdr46ab2csy4" }]
}
```

`status` is `pending` (upload started, not yet verified), `available`, or `withdrawn` (§8). `locations` is
returned to authorised callers only.

## 3. Adding an asset

The author's tool hashes the file once, then:

1. **`POST v1/assets/check`** `{ "keys": ["c1:…", …] }` (up to 1,000)
   → `{ "present": ["c1:…"], "missing": ["c1:…"] }`.
   Present assets need no upload: the tool reuses them (the same file is stored once, whatever book it is in).
2. **`POST v1/uploads`** `{ "key", "sha256", "type", "size", "filename"? }`
   → `{ "upload": { "url", "method": "PUT", "headers": { … }, "expiresAt" }, "store": "media-r2" }`,
   or `{ "exists": true, "asset": { … } }` if it is already there.
   The URL is normally a pre-signed URL of the store's bucket at the standard layout (1.2 §5.2), so the bytes
   go from the author's machine to the bucket directly. The registry MUST check that `key` is the c1 key of
   `sha256` and MAY refuse types or sizes it does not accept (`unsupported_type`, `too_large`).
3. The tool uploads the bytes to `upload.url` with `upload.method` and `upload.headers`.
4. **`POST v1/assets`** `{ "key", "sha256", "type", "size", "meta"?, "title"?, "tags"?, "subject"?, "license"?,
   "filename"?, "poster"?, "renditions"? }` → the asset record, `status: "available"`.
   Before it answers, the registry MUST confirm the object exists at the location with the declared size, and
   MUST verify its SHA-256 (from the store, or a checksum the store computed on upload). On a mismatch it
   deletes the object and answers `verification_failed`.

Registering the same key again with the same `sha256` is not an error: it updates the descriptive fields
(title, tags, …) for callers allowed to, and returns the record.

## 4. Reading

- **`GET v1/assets/{key}`** → the asset record, or `not_found`.
- **`POST v1/assets/batch`** `{ "keys": […] }` (up to 1,000) → `{ "items": [record, …] }` (unknown keys are
  left out). For an authoring tool opening a book.

## 5. Searching the library

**`GET v1/search`** with query parameters:

| Parameter | Meaning |
|---|---|
| `q` | Text, matched against title, file name and tags, in any script. Registries SHOULD match parts of words and tolerate spelling variants (reference: trigram similarity), since there is no general-purpose Bengali stemmer. |
| `type` | A type pattern: `video/*`, `image/png`. Repeatable. |
| `subject`, `tag` | Exact match. `tag` is repeatable (all must match). |
| `book` | Only assets used by this book (§6). |
| `mine` | `1`: only the caller's uploads. |
| `minDuration`, `maxDuration`, `minWidth` | Numeric filters on `meta`. |
| `limit` | Up to 100 (default 30). |
| `cursor` | From the previous page's `next`. |

→ `{ "items": [record, …], "next"? }`, best matches first when `q` is given, newest first otherwise. Each
record carries its `poster` key so the tool can show thumbnails through the stores.

## 6. Which books use what

- **`PUT v1/books/{bookId}/assets`** `{ "keys": […] }` (up to 20,000) replaces the set of assets the book uses. Authoring tools
  call it when a book is saved or published.
- **`GET v1/assets/{key}/books`** → `{ "items": [{ "bookId", "updatedAt" }], "next"? }`.

A registry MAY delete the bytes of assets that no book has used for a period it chooses, unless they are
pinned. It MUST NOT delete an asset any book uses.

## 7. Stores for readers

**`GET v1/stores`** → `{ "items": [store descriptor, …] }`: the descriptors (1.2 §5.1) readers should use for
this registry's assets, in order. Apps fetch this when they start and pass it to their reader as its host
stores. It is public and cacheable.

### 7.1 A private library's files

A registry whose bytes are not public (its bucket is private) serves them only to callers with a token, and
names that in its store:

```json
{ "items": [{ "id": "library", "kind": "derived", "template": "https://library.example.org/v1/files/{h}", "auth": "bearer" }] }
```

- **`GET v1/files/{key}`** (a token that may read; `{key}` is `c1:…` or the hash part `{h}`) answers with the
  bytes (200, with `Range` support), or `302` to a pre-signed URL of the bucket valid for **5 minutes**, sent with
  `Cache-Control: private, max-age=240`. Readers send `Authorization: Bearer <token>` and follow the redirect;
  fetch does not send the header on to the bucket's origin, and the URL itself carries no token. `404` for an
  unknown key, `410` for a withdrawn one.
- **`GET v1/assets/{key}/link`** (a token that may read) → `{ "url", "expiresAt" }`: a URL that needs no
  header, for places that cannot send one (an `<img>` or `<video>` source, a lab's frame). It is pre-signed by
  the bucket or signed by the registry (`…?exp=&sig=`), valid for 5 to 15 minutes (the reference: 15), and
  answered with `Cache-Control: no-store`. A changed, moved or expired link gets `403`.
- Neither may let stored code run as a page: HTML and JavaScript are served as `application/octet-stream`
  (on a pre-signed URL the type is part of the signature, `response-content-type`), and the registry's own
  answers add `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff`.
- `GET v1/stores` stays public: it names where the bytes are, not the bytes.

How tokens are issued is in §10; a token "may read" when it has the `reader` role (§10.1).

## 8. Withdrawing an asset

**`POST v1/assets/{key}/withdraw`** `{ "reason" }` (privileged) sets `status: "withdrawn"`. From then on the
registry's API store answers `410 Gone` for the key, and stores it controls SHOULD delete the bytes. The
record is kept, so the same key cannot be uploaded again by mistake (`gone`).

## 9. Versioning

This is version 1 (`v1/` in every path). Later versions add endpoints and fields; clients MUST ignore fields
they do not know.

## 10. Authentication

A registry MAY be its own identity provider: it keeps users and machine keys and issues the tokens itself, so
any app (an authoring tool, a reader, a publisher in CI) signs in against the library and sends
`Authorization: Bearer <token>`. A registry that does MUST do it as this section says, so one client works with
every such registry. The key words MUST, SHOULD and MAY are as in RFC 2119.

### 10.1 Roles

| Role | May |
|---|---|
| `reader` | search (§5), read records (§4), check keys (§3.1), read file bytes, read which books use a key (§6) |
| `author` | `reader`, and add (§3.2, §3.4) and re-register assets, and `PUT v1/books/{bookId}/assets` |
| `admin` | `author`, and withdraw (§8) and manage users and API keys (§10.5) |

Roles nest: a caller holding `author` holds `reader`, and `admin` holds both. Registries SHOULD return the full set
(`["reader", "author"]`) wherever roles are listed. A caller's permissions are the union of the roles its
credential carries. When reading is open (a public library), a request without a token may do what `reader` may.

### 10.2 Credentials

All are sent as `Authorization: Bearer <credential>`.

1. **Access token** (users): a JWT (RFC 7519) in compact JWS form, signed with Ed25519: header `alg` = `EdDSA`
   (RFC 8037) and `kid`. Claims: `iss` (the registry's public base URL, no trailing slash), `aud` =
   `"chalk-library"`, `sub` (the user's id), `name` (the username), `roles` (array), `iat`, `exp`, `jti`. It
   lasts 15 minutes (`expires_in`: 900). A registry MUST verify the signature with a key it holds under that `kid`,
   MUST refuse any other `alg` (`none`, `HS256`, …) whatever the header says, and MUST check `iss`, `aud`, `exp`
   and `iat`, allowing at most 60 seconds of clock difference. It MUST refuse the tokens of a disabled user within
   a short time it documents.
2. **Refresh token** (users): an opaque random string of at least 32 bytes (base64url), valid for 30 days. The
   registry keeps only its SHA-256. Each refresh token can be used **once**: using it returns a new one. If a
   refresh token that was already used comes back, the registry MUST revoke every refresh token descended from the
   same sign-in (its family), since one of the two holders is not the user.
3. **API key** (machines: CI, publishers, an app's server): an opaque string `clk_<random>`, at least 32 random
   bytes. Made by an administrator, shown once, kept as its SHA-256. It has a name and roles, records when it was
   last used, and can be revoked.
4. **Other tokens** the deployment configures (the reference server: `TOKENS`) MAY also be accepted.

Passwords are stored with a memory-hard hash (the reference server: scrypt with a random salt per user) and
compared in constant time; they have at least 10 characters. There is no self sign-up: an administrator creates
accounts. Other ways of signing in (one-time codes, social sign-in) are later grant types of the same endpoint.

### 10.3 Discovery

- **`GET .well-known/openid-configuration`** → `{ "issuer", "jwks_uri", "token_endpoint", "revocation_endpoint",
  "grant_types_supported", … }` (the fields of OpenID Connect Discovery that apply).
- **`GET .well-known/jwks.json`** → `{ "keys": [{ "kty": "OKP", "crv": "Ed25519", "x", "kid", "alg": "EdDSA",
  "use": "sig" }] }`: every key whose tokens may still be valid. When the signing key changes, the old public key
  stays listed until the last token it signed has expired. Both are public.

### 10.4 Signing in and out

**`POST v1/auth/token`** (OAuth 2.0 shaped, RFC 6749 §4.3 and §6; JSON or `application/x-www-form-urlencoded`):

- `{ "grant_type": "password", "username", "password" }`
- `{ "grant_type": "refresh_token", "refresh_token" }`

→ `200 { "access_token", "token_type": "Bearer", "expires_in": 900, "refresh_token", "roles": [...] }`, with
`Cache-Control: no-store`. Errors use OAuth's shape, not §1's: `400 { "error": "invalid_request" |
"invalid_grant" | "unsupported_grant_type", "error_description"? }`. A wrong password, an unknown username and a
disabled account give the same `invalid_grant`, in about the same time. The registry MUST limit attempts per
username and per client address (the reference server: 10 and 60 a minute) and answers `429` with `Retry-After`
when a limit is reached.

**`POST v1/auth/revoke`** `{ "refresh_token" }` → `200`, always: signing out ends that sign-in (its family).

**`GET v1/auth/me`** → `{ "sub", "name", "roles", "kind": "user" | "api-key" | "bootstrap" }` for any valid
credential, `401` without one.

### 10.5 Administration (`admin`)

- **`POST v1/admin/users`** `{ "username", "password", "roles" }` → `201` the user: `{ "id", "username",
  "roles", "disabled", "createdAt", "updatedAt", "lastSignInAt" }`. `409 conflict` if the name is taken. Usernames
  are compared without case.
- **`GET v1/admin/users`** → `{ "items": [user, …] }`.
- **`PATCH v1/admin/users/{id}`** `{ "password"?, "roles"?, "disabled"? }` → the user. Disabling a user or
  setting a new password revokes all of the user's refresh tokens.
- **`POST v1/admin/keys`** `{ "name", "roles" }` → `201 { "id", "key", "name", "roles", … }`. `key` is never
  shown again.
- **`GET v1/admin/keys`** → `{ "items": [{ "id", "name", "hint", "roles", "createdBy", "createdAt", "lastUsedAt",
  "revokedAt" }] }`; never the key.
- **`DELETE v1/admin/keys/{id}`** → `200`; the key stops working at once.

### 10.6 A private library

A registry MAY require a token for reading too (the reference server: `PUBLIC_READ=false`). It then names, at
`GET v1/stores`, a store with `"auth": "bearer"` (1.2 §5.1) for the bytes, and readers send the same bearer
credential to it (§7.1). `GET v1/stores` itself and the discovery documents of §10.3 stay public.
