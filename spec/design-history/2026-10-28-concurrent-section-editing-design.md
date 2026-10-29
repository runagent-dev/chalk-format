# Concurrent section editing — patch saves with a three-way merge

**Date:** 2026-10-28
**Status:** Proposed. Nothing here is implemented. Items marked **Open decision** have a proposed default and are
not decided.

## Goal

Several people edit one streamed book (spec 1.4) at once and **every edit lands**, even when two edits touch the
same page. Opening the editor is quick, and saving sends only what changed, whatever the size of the book. The
editor gains page-level operations.

## 1. Problem, with measurements

Measured on the ChalkBook dashboard with a 366-page streamed book (about 41 MB of page pictures), 2026-10-28:

| Step | What the browser does | Size | Time |
|---|---|---|---|
| Open the book to read | 9 requests: the index, 6 page files, 2 pictures | 0.2 MB | about 3 s |
| Switch to Author view (live site) | fetches **360 page files**, and **no pictures** | 0.6 MB | **14.5 s** until editing begins |
| Edit (add a 3D model) | nothing | 0 | instant |
| **Save** (local disk copy) | downloads **367 pictures**, packs one `.chalk`, uploads it | **37.5 MB down**, plus the whole `.chalk` (about 40 MB) up | 5.3 s |

Correction to an earlier explanation: pictures are **not** fetched when Author view opens. They are fetched when
**Save** runs, because the editor packs the whole book. A one-object change moves about 80 MB.

Why: author mode waits until every page is loaded, and loads them in batches that wait for each other (see §3);
Save re-downloads every picture to pack one `.chalk`; the host then writes only the files that are new, which
saves bucket writes but not the transfer. Worse, a whole-book save replaces the book: when two people save, the
second silently drops the first's work.

## 2. Goals and non-goals

**Goals**

- Everyone's edits land. A conflict has a fixed, reported resolution; nothing is lost silently.
- Start editing quickly: no wait for the whole book.
- Save sends only what changed: the changed pages and the media added in this session.
- Page-level operations in the editor: add a blank page, add pages from images, delete, reorder, replace a page's
  picture, edit a page's title.
- History is **not** a priority (see §4.7 for the cheap way to add it later).

**Non-goals**

- Real Git (a Git client in the browser would clone the whole book, which is the problem; line-based merge fits
  page JSON badly; Git still needs an atomic update of its branch pointer, the race §4.4 solves anyway).
- Per-line text merging.
- Real-time collaboration or a CRDT (edits are merged at save, not live).
- A history or restore UI.

## 3. Current state (read from `origin/main`)

- **The editor's state** (`packages/reader/src/author/state.ts`, `useAuthoring`): a stack of immutable `Lesson`
  snapshots, up to 200, one entry per gesture, with `apply(fn)`, undo and redo. Pages an edit did not touch stay the
  same object, so "which pages changed" is a cheap identity comparison with the last saved lesson. `dirty` is
  `lesson !== saved`.
- **Edits are per object on a page** (`edit.add`, `edit.replace`, `edit.remove` in
  `packages/reader/src/annotate/state.ts`). The book title and a page's title are also editable
  (`packages/reader/src/author/Sidebar.tsx`). There are **no page-level operations**: nothing adds, deletes,
  reorders or duplicates pages, so the page list never changes while editing.
- **The gate:** `author` is `authoringOn && mode === 'author' && (!streamed || streamed.complete)` in
  `packages/reader/src/ChalkReader.tsx`; entering author mode calls `streamed.loadAll()`. In
  `packages/reader/src/stream.ts`, `loadAll` walks the pages in groups of `MAX_REQUESTS` (6) and awaits each
  group before starting the next, so a 360-page book is 60 sequential round trips of 6.
- **Why the gate exists:** `useAuthoring` follows a streamed book's arriving pages only while nothing has been
  edited (`if (h.stack.length === 1)`), so a page arriving later would not appear in the history.
- **Save:** `save()` in `author/state.ts` fetches the bytes of every asset the lesson references (`assetBytes`,
  or the libraries' `bytes`) and calls `packLesson`: one `.chalk` for the whole book.
- **The streamed form** (`packages/container/src/stream.ts`, `publishStreamed`; spec 1.4): `book.json` lists every
  page (`id`, `file`, `title`, `bytes`, `assets`, `assetBytes`, ...); a page file is named
  `pages/<n>-<hex8>.json`, where `n` is the page's **1-based position at publish time** and `hex8` is the first
  four bytes (32 bits) of the SHA-256 of `JSON.stringify(page)`. The search text is one file,
  `text-<hex8>.json`, with the text runs of every page (`pageText`). Spec 1.4 §2 says file names are the writer's
  choice, listed in the index, and readers must not guess them.
- **The ChalkBook dashboard** (a host, `chalkbook-internal`, `apps/dashboard/src/lib/chalk-books.ts`): the editor's
  `.chalk` is sent whole (`PUT /api/chalk-books/<slug>`); the server republishes it as a streamed form and writes only
  files the store lacks, `book.json` last; saves of one book are queued **in memory**, and the code states that
  one server process is assumed.

Findings that shape the design:

1. A page's position is part of its file name. Inserting or moving a page changes the name of every page after it
   even if their bytes are the same. A per-page fingerprint must therefore be the **`hex8` part**, not the whole
   file name, and a patch writer should not renumber pages that did not change (§4.2).
2. `hex8` depends on the serialization of the page. The server must hash **its own** serialization of a page and
   never trust a hash from the client.
3. The 32-bit hash is accepted as enough for naming and comparing pages (decided); the page number in the name and
   the page id in the index make an accidental collision on the same page practically impossible.

## 4. Design

The unit that is sent is a changed page; the unit that is **merged** is an object inside a page. Replacing a page
wholesale cannot keep two people's edits to different objects of one page, so the server merges.

### 4.1 Version id and bases

- **Version id** = `sha256:` + SHA-256 of the exact `book.json` bytes the editor opened, computed in the browser
  when the index is fetched (proposed: `openStreamedBook` reads the response as bytes and parses those; today it calls `res.json()`). The server computes the same hash
  over the `book.json` it holds. Equal ids mean nothing was saved in between.
- **Base** = what the editor started from, and the editor already has it: the index it opened (page order, titles,
  each page's `hex8`) and the page JSON of every page it loaded. No history is needed on the server.
- The version id is only a **fast path**. If it differs (someone saved, or a CDN re-serialized the index), the
  server falls back to the per-page checks in §4.3, so a false mismatch costs a merge, not a failure.

### 4.2 The patch protocol

A host-to-server protocol, **not part of the book format**. Sketch (TypeScript):

```ts
type BookPatch = {
  base: {
    version: string;                       // sha256 of the book.json the editor opened
    order: string[];                       // page ids, as opened
    title: string;                         // book title, as opened
    pages: Record<string, { hash: string; page: LessonPage }>; // hex8 and JSON of every page the editor changed or deleted
  };
  mine: {
    order: string[];                       // page ids now
    title?: string;                        // only if changed
    pages: Record<string, LessonPage>;     // every page changed or added
    deleted: string[];
  };
  media: { id: string; type: string }[];   // new in this session; the bytes travel as separate parts keyed by id
};

type PatchResult = {
  version: string;                         // sha256 of the new book.json
  pages: Record<string, { file: string; hash: string }>; // new file name and hex8 of every page the server wrote
  report: MergeReport;
};
type MergeReport = { notes: { page: string; object?: string; property?: string; rule: string; by: string; loser?: unknown }[] };
```

- **Media:** only assets added in this session are sent. An asset a changed page references that is neither in the
  index nor in the session (a library item, §4.5) is fetched once and sent too.
- **Page files:** the server names new and rewritten pages `pages/<k>-<hex8>.json`, where `k` is a book-wide counter
  (one more than the largest in the index), so pages that only moved keep their file names and are not rewritten.
  **Open decision:** keep `<position>` naming (simple, renames files on every move) or the counter (proposed).
- **The index:** the server updates the entries of the pages it wrote (`file`, `bytes`, `title`, `assets`,
  `assetBytes`, `thumb`), the order, the title, and the `assets` list (adds the new media; drops entries no page
  references, using the pages' own `assets` lists).
- **The search text** is one file, so it is rewritten only when a page's `pageText` actually changed (moving an
  image does not change it); the server replaces just those pages' entries and writes a new `text-<hex8>.json`.
- **After a save** the editor takes the new version id and the new `hex8` of the pages it wrote as its next base, so it
  never re-fetches the index. Pages it did not touch may be stale in its view; that is harmless, because editing one
  later is checked then.

### 4.3 The three-way merge (server)

Inputs: **base** (from the patch), **mine** (the patch), **theirs** (the current index and pages in the store). The
merge is a **pure function** (`mergeBook`) over plain data, with no store access, so it can be property-tested.

**Page list**, by page id:

- Pages in `mine` but not in base are **inserts**; in base but not in `mine` are **deletions**.
- The result starts from `theirs`' order. My inserts go after the page that preceded them in `mine` (if it still
  exists, else at the end); my deletions remove the page unless `theirs` edited it (below). A page both of us moved
  takes the last saver's position; pages only one side moved take that side's.

**Objects inside a page**, by object id, property by property:

- An object (or page property: `title`, `background`, `width`, `height`) that only one side changed takes that
  side's change. A change by both sides to **different properties** of one object keeps both.
- A page that `theirs` did not change and `mine` changed is taken as `mine` (no merge needed).

**Conflict rules** (the same rules every time, always reported):

| Situation | What lands |
|---|---|
| Both change the same property of one object | The last saver's value wins; the other value goes in the merge log |
| One deletes an object or page, the other edits it | **The edit is kept**, so work is not destroyed; the report says "deleted by A, edited by B, kept" |
| Both insert pages at the same spot | Both are added, ordered by save time |
| Both reorder | Pages both moved take the last saver's position; others keep theirs |
| One replaces a page's picture, the other adds objects on it | Both land; the objects stay where they were placed |

**Replacing a page's picture** is a change of the page's `background`. It also **clears that page's text layer**
(`textLayer`), since the text positions belong to the old picture; the page is then listed without text until the
text is made again (OCR, spec roadmap).

### 4.4 Races

| Race | Handling |
|---|---|
| Two people, same book, different times | The per-page checks of §4.3; the report names what was merged or overridden |
| Two saves at the same moment (both read the same index, the later write drops the other's pages) | A **Postgres advisory lock per book slug** around read, merge, write and prune. It works across any number of server processes, uses the database the host already has, and is released if the process dies |
| The same person saves twice (second Ctrl+S during the first) | The reader allows **one save in flight**; a request made meanwhile waits and runs after, from the new base |
| A reader during a save | Files are named by their content and `book.json` is written last, so a reader sees the old book or the new one, never a mix |
| Prune against a save (it could delete a day-old file the save is about to re-use, e.g. a page reverted) | Prune runs **inside the same lock** |
| A crash part way | Order is files, then `book.json`, then the host's table row. A crash leaves unused files, or a stale row; **correctness never depends on the row**, because the version id is the hash of the index in the store |
| A script writing to the store directly (`books:upload`) | It must take the same lock |

An S3 conditional write (replace `book.json` only if it still has the ETag that was read) is an optional second
net. **To be tested against the real bucket**; it must not be the only mechanism, since support varies between
S3-compatible stores.

Today's whole-book save has the lost-update race: the in-memory queue stops two saves interleaving but not the
second replacing the first.

### 4.5 Library items

A library item added in a session (spec 1.2) is a reference until it is saved; at save its bytes are fetched from
the library into the book. In a patch, **only new library-sourced media** is fetched, not the media of the whole
book.

### 4.6 The editor

- **Lazy author mode:** drop the `streamed.complete` gate. Editing starts on the pages already loaded; pages that
  arrive later are merged into every history snapshot in which that page is still the unedited placeholder (safe:
  a page can only be edited after it has loaded). `loadAll` becomes a pool, not batches that wait for each other.
- **Changed pages** = pages whose object differs from the last saved lesson; added and deleted ids are the
  difference of the id lists.
- **Page operations** (new UI and `edit` helpers): add a blank page; add pages from images (a dropped image becomes a
  page whose background is that image); delete; reorder; replace a page's picture; edit a page's title (already
  exists). The patch type already carries order, inserts and deletions.
- **Single-flight save** (§4.4) and a conflict message: the editor keeps the user's edits in memory and names the
  page; the user reloads that page or chooses **Save anyway** for it.

### 4.7 History (optional, later)

Not needed for the merge, because the editor carries the base. If wanted: a commits table (parent, author, time,
message, changed pages, the version id), a snapshot of each saved `book.json`, a **retention rule** in place of
the one-day prune (keep files any retained save uses), and restore as a new commit pointing at an old index (no
file copying, since pages are content-named).

## 5. Public API and compatibility

- **No change to the book file format** and no `formatVersion` bump: the streamed form already allows any file
  names, and the patch is a conversation between editor and host.
- **Reader** (`@chalk-format/reader`, additive): `onSavePatch(patch, media)` on `ChalkReader`; the streamed book
  exposes its version id; `ReaderHandle.save()` uses the patch path when `onSavePatch` is given. Hosts that pass
  only `onSave` (or nothing, which downloads a `.chalk`) behave exactly as today.
- **Core** (`@chalk-format/container` and `model`, additive): `mergeBook` (pure) and `applyStreamPatch` (writes the new
  files and index from a merge result), with the types above.
- **Host (ChalkBook dashboard):** `PATCH /api/chalk-books/<slug>` beside the existing `PUT`, which stays for import and
  restore; the lock; the merge log (§6).
- **Version:** additive, so a minor release of the published packages.

## 6. Phases and effort

Each step ships and helps on its own.

| Step | What | Effect | Effort |
|---|---|---|---|
| 0 | Replace the batch loader with a pool; a progress indicator ("loading the book for editing, 120 of 360") | start editing in about 2 s instead of 14.5 s | hours |
| 1 | Lazy author mode (§4.6) | editing starts at once; Save still whole-book | about 2 days |
| 2 | Page operations in the editor, saved with today's whole-book save | add, delete, reorder, replace picture, from images | 3 to 4 days |
| 3 | Patch save: `mergeBook`, `applyStreamPatch`, the reader option, the endpoint, the lock, the merge report and log | a save sends kilobytes; concurrent edits merge | 5 to 6 days |
| 4 | History and restore (§4.7), optional | | about 2 days |

Total about 2 to 3 weeks, plus a reader release (a pull request, a release pull request, the registry) before the
host can use steps 1 to 3.

## 7. Test plan

- **`mergeBook`, property-based:** every edit by either side survives or is reported as overridden with its value
  kept; the result does not depend on the order in which the two sides' non-conflicting edits are applied; applying
  the same patch twice changes nothing more; deletions, inserts, moves and property edits are generated at random.
- **Race script** against a real store and database: many parallel patches to different pages all survive; to one
  page, one value wins and the rest are reported; **two server processes** on one bucket and one database; `kill -9`
  mid-save never leaves a half-visible book (a reader fetching throughout always sees one whole version).
- **Editor:** undo and redo across pages that load late; Ctrl+S during a save; the conflict message and **Save
  anyway**.
- **End to end in a browser** on the 366-page book: bytes sent per save (expect kilobytes for a one-object change,
  against about 80 MB today), time to start editing, and large-book timing.

## 8. Risks and open decisions

| Topic | Proposed default |
|---|---|
| **Open decision:** delete against edit | The edit is kept and reported (work is not destroyed) |
| **Open decision:** the same property edited by two people | Last saver wins; the other value goes in the merge log; the saver sees a report. Alternative: ask the second saver |
| **Open decision:** where the merge log lives | A table in the ChalkBook database, not in `chalk-format` |
| **Open decision:** page file naming | A book-wide counter, so moved pages are not renamed (§4.2) |
| Page order conflicts | The rules in §4.3; complex reorders are the likeliest to surprise, so they get the most tests |
| Undo across late-arriving pages | Merge arrivals into every snapshot where the page is still a placeholder; the trickiest part of step 1 |
| Library-sourced media | Fetch only the new items at save (§4.5) |
| Text layer of replaced pages | Cleared (§4.3); regenerating it needs OCR (roadmap) |
| Text file rewrite cost | One file holds all pages' text (1.9 MB for this book); rewrite it only when a page's text changed |
| Index hash false mismatch (a CDN re-serializes `book.json`) | The version id is a fast path only; the per-page checks decide |
| Scripts that bypass the lock | They must take it; documented |
| Coarse conflicts | Per-page checks plus object-level merge are enough for a few editors; a live collaboration mode is a non-goal |
