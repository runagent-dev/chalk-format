# Phase 2 — Backend book delivery + additive overlay (`.chalk`) design

Status: **2a shipped** (this PR); **2b designed, not yet built**.
Date: 2026-07-11.

## Goal

Make "what books/assets are available" — and eventually a user's edits —
come from the **backend + DB + object storage**, not static files. Do it
so that:

- the original uploaded book is **read-only**;
- a user editing it forks a **personal, editable copy**;
- that copy is a small **additive overlay** over the shared base, not a
  full duplicate — so sync and updates stay cheap;
- clearing local storage always safely **reverts** by re-fetching.

---

## 1. Where a downloaded book lives (the resolution ladder)

| Tier | What | Lifetime | Today |
|---|---|---|---|
| RAM | `useAssetStore` object URLs the canvas renders | until lesson switch / reload | ✅ |
| IndexedDB | downloaded lesson JSON + asset bytes (autosave target) | until cleared / evicted | ✅ |
| OPFS | better home for large binaries (e.g. 66 MB physics) | same, faster/bigger | ❌ (#25) |
| Cloud (Garage) | authoritative copy, streamed via the server | permanent | ✅ |

**Download** = fetch `.chalk` → unpack → write into IndexedDB → open →
hydrate RAM → render.

**Clearing & revert.** Clearing RAM re-hydrates from IndexedDB. Clearing
IndexedDB is safe because base content is **content-addressed** (asset id
= its `sha256`), so any cached blob is re-fetchable and self-verifying —
the base is a pure cache. The **only** non-evictable thing is *unsynced
user edits*; that single fact drives the overlay + sync design.

---

## 2. Read-only source vs. editable copy (fork-on-edit)

- The published book is an immutable **base** (`book:physics@v3`), owned
  by the publisher/admin. Writing a new version is **admin-only** —
  enforced by the existing entitlement seam with an admin policy.
- A student annotating **forks-on-write**: a personal lesson
  `{ baseRef: physics@v3, overlay }`. The base stays pristine; "reset to
  original" = discard overlay.
- Many students share **one** cached base; each carries a **tiny**
  overlay. When the publisher ships `@v4`, overlays **rebase** onto it
  (git-style) — the "update available" flow `mergeShelf` already models.

Users **cannot** change the uploaded source.

---

## 3. The additive overlay format

`effective_lesson = base ⊕ overlay`, composed in memory at open time.
Because the model is object-based (every object has an id) and
annotations are **new objects with new ids**, the overlay is nearly pure
additive.

```jsonc
// overlay: manifest.kind = "overlay", base = { id, version, hash }
{
  "base": { "id": "physics", "version": 3, "hash": "sha256:…" },
  "pages": {
    "page-42": {
      "addedObjects":    [ /* ink, text, shapes the student drew */ ],
      "updatedObjects":  { "obj-7": { /* full replacement, rare */ } },
      "removedObjectIds":[ "obj-9" ],          // tombstone
      "backgroundOverride": null,
      "cleared": false
    }
  },
  "addedPages":    [ { "afterPageId": "page-42", "page": { /* blank */ } } ],
  "pageOrder":     [ /* only if reordered */ ],
  "removedPageIds":[],
  "assets":        [ "sha256:…" ],             // new content-addressed assets
  "meta": { "titleOverride": "Physics — my notes", "updatedAt": "…" }
}
```

**Composition:** load base pages → append `addedObjects` (z-order),
replace `updatedObjects`, drop `removedObjectIds`, apply
`cleared`/`backgroundOverride` → splice `addedPages`, apply
`pageOrder`/`removedPageIds`. Deterministic; unit-testable like the
existing `roundtrip`/`thin` tests.

**Format-wise** this is a thin `.chalk` (`bundling: 'thin'`, assets by
reference) + a `base` pointer + a `patch` section. One format family.

**Representation choice:** structured per-object overlay (above), *not*
RFC-6902 JSON-patch — it aligns with the domain model and gives
conflict-free merges of annotations.

---

## 4. Sync

The overlay is the **unit of sync**:

- Autosave writes the overlay locally (IndexedDB/OPFS).
- Sync uploads **just the overlay JSON** + pushes any **new** asset bytes
  (content-addressed → dedup; base never re-uploads).
- Cross-device **merge**: mostly new-id additions → union conflict-free
  (CRDT-like); LWW per object id for the rare true conflict, tombstones
  win for removes. (Real-time collaboration is a much larger CRDT effort
  — out of scope for v1.)
- **Eviction becomes always-safe** once synced: base (by hash) and
  overlay (by user+book) are both re-fetchable, so clearing the browser
  → re-fetch → recompose → byte-identical. Rule: pin unsynced overlays
  (non-evictable) until pushed.

---

## 5. Backend / DB

- `books` (base catalog) — **shipped (2a).**
- `user_lessons` (overlays): `id, user_id, base_id, base_version,
  overlay_key|overlay_jsonb, updated_at`. Small overlays can be JSONB;
  large ones a Garage object.
- Endpoints: `GET/PUT /api/lessons/:id` (overlay, entitlement = owner);
  `GET /api/books/:id/download` (base — **shipped**); assets unchanged.
- **Auth** is on the critical path for 2b: overlays are per-user, sync
  can't be anonymous. (Surfaces the deferred #25 auth decision.)

---

## 6. Hard parts (2b)

1. Deterministic **composition + rebase** across base versions (stable
   page ids help; added/removed pages need an id map).
2. **Auth** becomes required (per-user overlays).
3. **Merge semantics** — LWW fine for one user on many devices; live
   collab is a separate CRDT project.
4. Structural ops (page reorder / base-page delete / base-object edit)
   are the parts to test hardest.

---

## 7. Phasing

### 2a — backend serves books end-to-end (SHIPPED, this PR)
- Postgres + Drizzle catalog (`/api/books`, `/:id`), migrations on
  startup, single root `docker-compose.yml` (DB + server), seed.
- Book `.chalk` + covers **streamed through the server** from the private
  Garage bucket (no CORS, no presigned URL exposed; assets keep the
  presigned-`<img>` path). Content-type is forced safe (downloads
  `application/zip` + attachment; covers a non-scriptable raster
  allowlist), `nosniff` + `CSP: default-src 'none'; sandbox`.
- Web catalog reads `/api/books` when `VITE_API_URL` is set, with a
  static `catalog.json` fallback.

### 2b — additive overlay + sync + auth (DESIGNED, next)
- Base/overlay `.chalk` manifest + `base ⊕ overlay` compose (+ tests).
- `user_lessons` table + `GET/PUT /api/lessons/:id`.
- Fork-on-edit in the web; pin-until-synced eviction; rebase on base
  update.
- Auth (the gating decision) — needed for per-user overlays.
