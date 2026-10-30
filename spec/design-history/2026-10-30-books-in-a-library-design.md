# Books in a library: design

Status: the contract of [spec 1.8](../1.8/README.md). Written so that end-user apps load a whole book (index, pages, pictures,
labs, models, text, question links, questions) from a Chalk library server, and never from the publishing system's database or
bucket.

## Choices

| Topic | Decision | Why |
|---|---|---|
| Where the book lives | Items of the library, one per file of a streamed book (1.4), plus a links item | The library already has keys, immutable delivery, search by tag and a record of use. No new endpoint, no new table |
| Which revision is current | Tags (`state:current` / `state:superseded`); of two current, the newest `createdAt` | The same rule the 3D figure sync already uses. Needs nothing from the server but tag search |
| Commit point | The book item, added last; the old one superseded after | A reader that finds a book item finds everything it names. A publish that stops halfway changes nothing a reader sees |
| Page and text bytes | Exactly the 1.4 files | One writer for both forms; an unchanged page is the same item in every revision, so a new revision costs only what changed |
| Assets | All external, by c1 key, through the library's delivery store (`assetSources`) | Shared and deduplicated across books, as 1.2 intends |
| Question links | One links item per revision, only sentences with a link and only questions with a library key | Small, and everything it names can be fetched |
| Version | 1.8, not 1.7 | 1.7 was already the question manifests when this was written. The plan that preceded this called it 1.7 |

## Open

- **Who may read.** Search can need a token (`PUBLIC_READ=false`), but the reference library's delivery store is public: anyone
  with a key gets the bytes. Copyrighted books need a delivery store that checks a token, or must stay out of a public library.
  Not decided by the owner yet.
- **Where the code lives.** The schemas and tag helpers are in `@chalk-format/store` (`packages/store/src/library-book/`), beside
  the registry client a loader needs; published as part of `@chalk-format/core`.
