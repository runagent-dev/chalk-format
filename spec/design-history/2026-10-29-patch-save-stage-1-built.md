# Patch save, stage 1: built

Status note for [the design](./2026-10-28-concurrent-section-editing-design.md) (PR #20). **Stage 1 is built; the host, lazy author mode and page
operations are not.**

## What exists

- `@chalk-format/container`: `mergeBook`, `applyStreamPatch`, `createPatch`, `pagesNeeded`, `pageHashes` and the types (`BookPatch`,
  `PatchResult`, `MergeReport`, `MergeNote`), all pure. Tests: 32 example tests (every rule of §4.3, the golden "empty patch changes nothing",
  idempotence, counter naming, text-file and asset handling, content-name checks) and 10 randomised properties over 250 seeded cases each
  (nothing either side added is lost; every property edit survives or is reported with the losing value; delete-vs-edit keeps the edit;
  idempotent; the stored book is valid; non-conflicting edits commute; a patch carries only changed pages). The merge was also sabotaged three
  ways to prove the tests catch it.
- `@chalk-format/reader`: `onSavePatch`, `onMergeReport`, the streamed book's `version`, the patch path of Save / Ctrl+S / `handle.save()`
  with the busy state and progress of the save feedback work. Measured: a one-object change on the 60-page sample is a 7 KB patch with zero
  picture requests (`tools/reader-patch-save-e2e.mjs`).
- Guide for hosts: `docs/guides/host-patch-save.md`.

## Decisions (the design's proposed defaults, plus these)

| Topic | Decision |
|---|---|
| Delete against edit | The edit is kept and reported |
| Same property edited by both | Last saver wins; the other value is in the report |
| Page file names | A book-wide counter `pages/<k>-<hex8>.json` (`k` = largest in the index + 1); moved pages keep their names |
| Merge log | The host's: the core only returns a `MergeReport` |
| Version id | SHA-256 of the exact `book.json` bytes; a fast path only |
| Nested properties | Merged one by one (`presentation.open` and `presentation.show` both land); arrays are atomic |
| Stacking order and page order | Longest common subsequence against the base; an item moved by one side takes that side's place, by both the last saver's |
| Last page | A merge never leaves a book without a page (`last-page-kept`) |
| After a merged save | The editor takes the merged page in and restarts its undo history there (older snapshots would undo the other work) |
| Snip pages | Merged and ordered like pages (`snipOrder`); not in the search text |
| Library items | Only unsent assets a changed page uses are fetched and sent |

## Still to do

Stage 2: the host (`chalkbook-internal`: `PATCH /api/chalk-books/<slug>`, the lock, the merge log). Then lazy author mode (design §4.6) and page
operations in the editor; both are independent of this stage.
