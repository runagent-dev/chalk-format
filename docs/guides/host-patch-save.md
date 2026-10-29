# The patch save: saving a changed page, not the whole book

For a host (a server that keeps streamed books, spec 1.4) that wants Save to cost kilobytes. This is a conversation between the
editor (`@chalk-format/reader`) and its host; it is **not part of the book format** and changes no file or `formatVersion`.

## Why

A whole-book save of a 366-page book (368 pictures, 38 MB) fetches every picture in the browser, packs a `.chalk`, uploads it, and the host
unpacks and rewrites everything: seconds that grow with the book, whatever the edit. A **patch** is the pages that changed and the media
added, with the version they started from. The host merges it into the book it has, so two editors' changes to different objects of one page
both land. Measured on the 60-page sample (`tools/reader-patch-save-e2e.mjs`): one edited object is a **7 KB** patch and **no picture request**.

## The editor's side

```tsx
<ChalkReader
  source="/api/books/physics/stream/"      // a streamed book: its index is `book.json`
  config={{ authoring: { enabled: true } }}
  onSavePatch={async (patch, media) => {
    const body = new FormData();
    body.set('patch', JSON.stringify(patch));
    for (const [id, m] of media) body.set(`media:${id}`, new Blob([m.bytes], { type: m.type }));
    const res = await fetch('/api/books/physics', { method: 'PATCH', body });
    if (!res.ok) throw new Error((await res.json()).error);   // not kept: the book stays unsaved
    return res.json();                                         // a PatchResult
  }}
  onMergeReport={(report) => console.log(report.notes)}
/>
```

`patch` (`BookPatch`): `base` (the `version` = `sha256:` of the exact `book.json` bytes the editor opened, the page and snip-page order, the
title, and every changed or deleted page **as it was**, with its `hex8`), `mine` (the order now, the title and cover if changed, every
changed or added page, the deleted ids) and `media` (`{ id, type }` of what was added; the bytes are the second argument). Only changed pages
are in it. For a streamed book `save()`, **Ctrl/Cmd+S** and the dock's Save use the patch path whenever `onSavePatch` is given; a book opened
from a `.chalk` file still saves whole through `onSave`.

## The host's side

```ts
import { applyStreamPatch, mergeBook, pagesNeeded, parseStreamIndex, parseStreamPage, type BookPatch } from '@chalk-format/container';

await withBookLock(slug, async () => {                       // ONE writer of the book at a time, across every process (e.g. a Postgres advisory lock)
  const index = parseStreamIndex(JSON.parse(await readText(`${slug}/book.json`)));
  // 1. read only what the merge needs: pages the patch changed or deleted that the store changed since the editor opened it
  const pages = new Map(await Promise.all(pagesNeeded(patch, index).map(async (id) => [id, await readPage(slug, index, id)] as const)));
  // 2. merge (pure)
  const merge = mergeBook(patch, { index, pages });
  // 3. the new files and the new index (pure); content-named media is verified by file name here
  const applied = await applyStreamPatch({ index, text: await readSearchText(slug, index) }, merge, media, {
    expects: patch.expects,                                    // assets the editor believes the book carries (see below)
    restore: await filesStillInTheStore(slug, patch.expects),  // optional: Map<id, { type, size }> for those that are no longer in the index but whose file is
  });
  // 4. write the new files FIRST, then book.json LAST: a reader sees the old book or the new one, never a mix
  for (const [path, bytes] of applied.files) await write(`${slug}/${path}`, bytes);
  if (!applied.result.unchanged) await write(`${slug}/book.json`, applied.indexBytes);
  // 5. your own bookkeeping (revision, size), pruning of files no version uses any more, and the merge log from applied.result.report
  return applied.result;                                      // the PatchResult the editor adopts
});
```

- **`mergeBook(patch, theirs)`** is pure and never reads a store: `theirs` is the current index plus the pages `pagesNeeded` asked for. It
  returns what to write (`write`), what to drop (`remove`), the order, the title and a `MergeReport`.
- **`applyStreamPatch(current, merge, media)`** is pure too. New and rewritten pages are named `pages/<k>-<hex8>.json` with `k` one more than the
  largest in the index, so pages that only moved keep their names; per-page `assets` and `assetBytes` are updated; assets no page uses are
  dropped from the index (prune their files later, under your lock); the one search-text file is rewritten only when a page's text really
  changed; files named by their content (`assets/c1_…`, `assets/sha256_…`) must hold those bytes or it throws; media whose bytes do not match
  their key are refused. An empty merge returns `result.unchanged` and nothing to write.
- **The `PatchResult`** carries the new `version` (the hash of the new `book.json`), the new file name and `hex8` of every page written, for a page
  that was merged with someone else's work that page whole (`page`), which the editor takes in (merging it with anything the user edited meanwhile),
  `dropped`: the assets taken out of the index, which the editor forgets so it sends their bytes again if the picture comes back, and `assets`: the
  carried media (id, type, file) that the merged pages use, which may be someone else's new pictures: the editor adds them to the book it draws from.
- **`patch.expects` and `restore`.** Another editor's save may have taken an asset out of the index (its last reference was deleted) after this editor
  opened the book; a stale edit can bring a reference to it back. The editor lists, in `patch.expects`, the assets its changed pages use that it
  believes the book carries. Pass them to `applyStreamPatch` with `restore`: for those no longer in the index whose `assets/<key>` file your store
  still has (it prunes after a grace period), the entry is listed again with its file. Any that cannot be restored come back in
  `PatchResult.unresolved`; the editor then sends their bytes in one follow-up patch that changes no page.
- **The version id is informational.** A patch is untrusted input: a claimed `version` or page `hash` proves nothing. The merge decides whether the
  store changed a page since the editor opened it by comparing the page itself with the editor's base copy, which is why `pagesNeeded` lists every page
  the patch touches that the store has (a patch touches a few). Never reject a patch for a version mismatch alone.

## The rules (always reported in `report.notes`)

| Situation | What lands |
|---|---|
| One side changed a property of an object or page | That change |
| Both changed **different** properties (also nested, e.g. `presentation.open` and `presentation.show`) | Both |
| Both changed the **same** property to different values | The last saver's (the patch's) value; the other is in `loser` |
| One deleted an object or page the other edited | **The edit is kept**; reported |
| Both inserted at the same spot | Both, the earlier save first |
| Both moved the same page or object | The last saver's place |
| The editor replaced a page's picture and left its text layer as it was | The text layer is cleared (the positions belong to the old picture). A layer the same patch supplies is kept, and so is one the host made for a picture the host replaced |
| The merge would leave the book without a page | The first deleted page stays (`last-page-kept`) |

Applying the same patch twice changes nothing more. Edits that do not touch the same thing give the same book whichever was saved first
(both properties are tested with 250 random cases each in `merge.random.test.ts`).

## Compatibility

Additive: a new optional prop and new exports, no format change. Hosts that pass only `onSave` (or nothing, which downloads a `.chalk`) behave
exactly as before. A script that writes a book's files directly must take the same lock as the patch writer.
