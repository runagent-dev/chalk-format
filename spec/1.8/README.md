# Chalk 1.8: Books in a library

Status: draft · `formatVersion` 11 (no model change) · builds on [1.2](../1.2/README.md) (keys, stores, the
[registry API](../1.2/registry-api.md)), [1.4](../1.4/README.md) (streamed books) and [1.7](../1.7/README.md) (question manifests)

A streamed book (1.4) is a folder of files at a URL. 1.8 keeps the same book **in a library** instead: its index, its
pages, its text layer and the links from its sentences to questions are items of the library, named by their keys like
any picture or lab. An app then loads everything it shows (the index, the pages, the pictures, labs and models, the
text, the question links, the questions and their pictures) through one library, and needs nothing else: no database,
no bucket, no folder of files of its own.

## 1. Why

A publishing system keeps its books where it writes them (a database, a bucket). Reading apps that load from there
are tied to that system: its schema, its credentials, its layout. A library already gives what a reader needs, for
every kind of item: content keys, immutable bytes that can be cached for ever, a delivery store, search by tag, and a
record of which book uses what. Books placed in it the same way as media are read the same way as media, and the same
picture, lab or question is kept once for every book that uses it.

## 2. Terms

- **Item:** an asset of a library (registry API §2): bytes, a media type, a content key (1.2 §3) and tags.
- **Book item, page item, text item, links item:** the four kinds of item of §3.
- **Revision:** one published state of a book. Its items never change; the next revision is new items.
- **Slug:** the book's name in the library (`physics-9-10-bn`): letters, digits, `.`, `_` and `-`, starting with a letter or
  digit, at most 128. It is part of tags and of a URL path (registry API §6).
- **Publisher:** the tool that copies a book from where it is written into a library.

## 3. Items

| Media type | `kind:` tag | Bytes |
|---|---|---|
| `application/vnd.chalk.book+json` | `book` | The book item (§3.1): the 1.4 index, with keys where 1.4 has paths |
| `application/vnd.chalk.page+json` | `page` | Exactly the bytes of a 1.4 page file (`pages/<n>-<hash>.json`): the page JSON of 1.0 §3.2 |
| `application/vnd.chalk.text+json` | `text` | Exactly the bytes of the 1.4 text layer (`text-<hash>.json`, 1.4 §4) |
| `application/vnd.chalk.links+json` | `links` | The links item (§3.4) |

The pictures, labs, models and other media of the book are ordinary items with their own media types (`image/webp`,
`text/html`, `model/gltf-binary`, …), as in 1.2. They are shared: a picture two books use is one item. Questions are
question manifests (1.7).

### 3.1 The book item

The 1.4 index (`book.json`, 1.4 §3), changed only where a path would name a file:

```json
{
  "format": "chalk.streamed", "streamVersion": 1, "formatVersion": 11,
  "id": "physics-9-10-bn", "title": "পদার্থবিজ্ঞান", "locale": "bn",
  "createdAt": "2026-10-30T00:00:00Z", "updatedAt": "2026-10-30T00:00:00Z",
  "coverAssetId": "sha256:e5479490db7fdbadde2e66fa61fcdec1354103c975417d44284abf17eff82b82",
  "pages": [
    { "id": "p12", "key": "c1:fkcj23yh7tj4sucoszwxr3jjai", "title": "সরল দোলক", "label": "১২",
      "width": 1200, "height": 1699, "bytes": 2210, "thumb": "c1:3cz2ot563hcytyt5iotjupwkza",
      "assets": ["c1:zh7tdapo47ooe22ki3wddvad5e", "c1:wdfqbjot7mgw2falug64x3got4", "sha256:e5479490db7fdbadde2e66fa61fcdec1354103c975417d44284abf17eff82b82"], "assetBytes": 103446 },
    { "id": "p13", "key": "c1:xzbcmznxo3cye3622zgl7v4qym", "label": "১৩", "width": 1200, "height": 1699 }
  ],
  "assets": [
    { "id": "c1:zh7tdapo47ooe22ki3wddvad5e", "type": "image/webp", "size": 76012 },
    { "id": "c1:3cz2ot563hcytyt5iotjupwkza", "type": "image/webp", "size": 5222 },
    { "id": "c1:wdfqbjot7mgw2falug64x3got4", "type": "text/html", "size": 18211 },
    { "id": "sha256:e5479490db7fdbadde2e66fa61fcdec1354103c975417d44284abf17eff82b82", "type": "image/png", "size": 22212 }
  ],
  "text": { "key": "c1:cohznykex3fhyq42vqmjjqqrau", "bytes": 48211 },
  "links": "c1:kggk5mnvftkuqu4k4mpuk5ypby",
  "assetSources": [
    { "id": "library", "kind": "derived", "template": "https://library.example.org/c1/{h0}/{h1}/{h}" }
  ]
}
```

Everything not listed below is as in 1.4 §3.

| Field | | Meaning |
|---|---|---|
| `pages[].key` | required | The key of the page item. Replaces `file`, which MUST be absent |
| `snipPages[].key` | required | The same, for snip pages |
| `assets[]` | | Every asset is external: `id` is a content id (1.2 §3.3), a c1 key or a `sha256:` id, and `path` MUST be absent. The asset is found through stores (1.2 §6) by its c1 key (for a `sha256:` id, the resolution key of 1.2 §3.3). The `id` of each of its `renditions` is a content id too |
| `text` | | `{ "key": "c1:…", "bytes": n }`: the key of the text item and its size. Replaces `text.file`, which MUST be absent |
| `links` | | The key of the links item (§3.4), when the book has links |
| `assetSources` | required | At least one store descriptor (1.2 §5.1): the library's delivery store, as `GET v1/stores` gives it (registry API §7), and any other store the publisher suggests. As in 1.2 §4.4 they MUST NOT need a token (`auth` absent or `"none"`) |

**Item keys and asset ids.** The keys of items of the book (`pages[].key`, `snipPages[].key`, `text.key`, `links`) are
c1 keys: the library names its items so. An asset id (`assets[].id`, a rendition's `id`, `coverAssetId`, a page's
`assets` and `thumb`) is any content id. A page item is the page file unchanged (§3.2), and pages written before c1
keys name their pictures by `sha256:` ids: the book item names those assets by the same ids, so that a page and its
entry agree. Writers SHOULD use c1 keys for new assets (1.2 §3.3).

The `id` SHOULD be the slug. `format` and `streamVersion` stay those of 1.4: what tells a book item from a 1.4 index is
its media type, and a book item is never at the end of a URL a 1.4 reader would open. Every asset a page names (`assets`,
`thumb`) and `coverAssetId` MUST be listed in `assets`, and page ids are unique across `pages` and `snipPages`.

### 3.2 The page item

The bytes of the page file a 1.4 writer would write for the page, unchanged: the page JSON of 1.0 §3.2 at the
book item's `formatVersion`, with assets named by their keys. A reader validates it as 1.4 §5 step 6 says. The page item
of a page that did not change between two revisions is the same item: same bytes, same key.

### 3.3 The text item

The bytes of the 1.4 text layer, unchanged: `{ "v": 1, "pages": { "<page id>": [text runs] } }` (1.4 §4).

### 3.4 The links item

Which sentences of the book each question is answered from, so a reader can show the questions beside the text and
highlight the sentences a question comes from:

```json
{
  "format": "chalk-links", "version": 1, "book": "physics-9-10-bn", "bookRevision": 7,
  "sentences": [
    { "id": "s-0412", "page": 12, "pageId": "p12", "rects": [[0.12, 0.31, 0.76, 0.024], [0.12, 0.336, 0.41, 0.024]],
      "text": "সরল দোলকের দোলনকাল এর কার্যকর দৈর্ঘ্যের বর্গমূলের সমানুপাতিক।" }
  ],
  "links": [
    { "sentence": "s-0412", "question": "c1:74muxikui3encd3z42uf2jg7ma", "questionId": "2f6c0b1e-5d1a-4c52-9d0e-3b8a7a1c9e11", "role": "answers_from" },
    { "sentence": "s-0412", "question": "c1:nmtgoett6ffbndlzndtjbir7di", "role": "answers_from" }
  ]
}
```

| Field | | Meaning |
|---|---|---|
| `format`, `version` | required | `"chalk-links"`, `1` |
| `book`, `bookRevision` | required | The slug and the revision the links were made for |
| `sentences[]` | required | The sentences that have at least one link, and only those |
| `sentences[].id` | required | The sentence's lasting name on the publisher's side. Unique in the item |
| `sentences[].page` | required | The page's number on the publisher's side, for people |
| `sentences[].pageId` | required | The `id` of the page entry in the book item: the page the sentence is on |
| `sentences[].rects` | required | Where the sentence is on that page: `[x, y, width, height]`, each a fraction of the page's width or height (0 to 1). One rectangle per line. Empty when the place is not known: the reader shows the link without a highlight |
| `sentences[].text` | required | The sentence, as on the page |
| `links[]` | required | `sentence` (an `id` of `sentences`), `question` (the key of a question manifest, 1.7, that is in the library), `role`, and optionally `questionId` |
| `links[].questionId` | optional | The question's lasting id: a UUID string, the one in the manifest's `question:<id>` tag (1.7). `question` is the version published when the links item was made; `questionId` names the question whatever its version |

The roles this version knows:

| `role` | The sentence… |
|---|---|
| `answers_from` | holds what the question asks for |
| `tests_concept` | states the idea the question tests |
| `formula_source` | gives a formula the question uses |
| `uses_figure` | is about a figure the question uses |

**Current version by id.** A question is corrected by publishing a new version of it: a new manifest with a new key, the
same lasting id, tagged `state:current`, the old one `state:superseded`. A link that has a `questionId` points at the
question, not at one version: a reader that can ask the library uses the **current** version of that id, and the links
item need not be published again when a question changes. It asks `POST v1/assets/current` with the tags
`question:<questionId>` (registry API §4.1; the default requirement is `state:current`, the media type is
`application/vnd.chalk.question+json`), many ids in one request, and checks each manifest it gets against its key as any
item (§7 step 3). For an id the library answers `null` for, for a library without that endpoint (404 or 405), or when it
cannot ask (offline), the reader uses the link's `question` key. A link without `questionId` (every links item made
before this field) uses its `question` key, as before. A publisher writes `questionId` whenever it knows the id, and
`question` always. Writers keep a `questionId` they do not understand; a reader that does not know the field ignores it
(the item is an open object) and shows the version named by `question`.

**The links item is found by tag.** Like the book item (§5), the links item that is current is found by searching
`book:<slug>`, `kind:links`, `state:current` (§4), the newest `createdAt` winning, a tie going to the larger key. The key
the book item names in `links` is the fallback: a reader uses it when the search finds none or cannot be made. This lets
a publisher publish the links alone (a new links item, the book item untouched) and readers see them at once.

A reader MUST skip a link whose role it does not know, and does not show a sentence left with no link it knows. A link appears once. Questions without a key in the library are left out by the
publisher. Like the other items, the links item is an open object: writers keep fields they do not know.

## 4. Tags

The publisher lists the four kinds of item under these tags (registry API §3, `tags`):

| Tag | |
|---|---|
| `origin:<origin>` | What published it (`origin:chalkbook`) |
| `book:<slug>` | The book |
| `book-revision:<n>` | The revision, an integer the publisher counts up, for people and tools |
| `kind:book`, `kind:page`, `kind:text`, `kind:links` | Which of the four it is |
| `state:current`, `state:superseded` | Whether it belongs to the book as it is now (§6.2) |

A media item of the book (a picture, a lab) carries its own tags, not these: it may be in many books. Which books use it
is said by the record of use (§6.3).

Tags are replaced, not added to, when a key is registered again (registry API §3): to change one tag, the publisher
registers the key again with the whole new list. Bytes the library already has are not registered by `POST v1/uploads`
(it answers `exists`), so a publisher that adds an item whose key the library has (a page that did not change) still
registers it (`POST v1/assets`) to give it the new revision's tags.

## 5. Finding the current book

```
GET v1/search?tag=book:<slug>&tag=kind:book&tag=state:current
```

From the results, a reader takes the one book item that is current:

1. Leave out any item whose media type is not `application/vnd.chalk.book+json`, or that is not `available`.
2. **Newest current wins:** of those left, the one with the latest `createdAt`. Two with the same time: the larger key,
   so every reader picks the same one.
3. None left: the library has no current revision of the book.

Between the moment a publisher adds a book item and the moment it supersedes the old one (§6.1), two are current: rule 2
already picks the new one.

A reader then fetches the book item by its key (§7), and everything else by the keys the book item holds. **The book
item and the links item (§3.4) are what a reader looks up by tag**, and a question's current version by its id (§3.4).
It never searches for page or text items: their tags are for people and for tools that tidy a library, and a page shared
by two revisions carries the tags of the last one that published it.

The searches (and `POST v1/assets/current`) are the only requests that change answer over time. Everything else is immutable, so a reader caches it by key
for ever (1.2 §6.5), and SHOULD remember the last current book item's key, to open the book without a network.

## 6. Publishing

### 6.1 Order: the book item is the commit point

A reader that finds a book item MUST find everything it names, and a library MUST NOT lose what a current book uses. So a
publisher:

1. adds the media items the book uses that the library does not have yet (registry API §3: `check`, `uploads`, `assets`);
2. adds the page items, the text item and the links item, tagged `state:current`;
3. records the use (§6.3) of **both** revisions: the keys the library already records for the book and those of steps 1 and 2;
4. adds the **book item**, tagged `state:current`. From this moment readers open the new revision;
5. at once records the use of both revisions again, the new book item added to the set of step 3;
6. supersedes the old book item (§6.2);
7. checks that its book item is now the current one (§6.2), then records the use of the new revision alone (§6.3), the book
   item included.

A publisher MUST NOT do step 4 before 1 to 3 have succeeded. If it stops before step 4, nothing a reader sees has changed:
the new items are there, recorded, and the next run reuses them (their keys are the same). If it stops after step 5, the
book is published and everything it names is recorded; the next run repeats steps 6 and 7. Only between steps 4 and 5 is
the new book item missing from the recorded use, and it does not depend on that: a library never deletes a current book
item (§6.3), however long the publisher stays down. Everything the item names was recorded in step 3.

**One publisher at a time.** Publishing a book is not atomic: a publisher MUST NOT publish a book while another run is
publishing the same book (the publishing side holds a lock per slug, or runs one job at a time). Even so, §6.2 never
supersedes a book item created after the one being published, so two runs that overlap leave the later book current, never
none.

### 6.2 Superseding

In step 6 the publisher registers again (registry API §3, step 4) each book item of the same book that is still
`state:current` and was created **before** the new one or at the same time (`createdAt`), with its tags and
`state:superseded` instead of `state:current`. A tie goes to the item just added: runs of one book do not overlap, so an
item with the same time is an earlier run's. A book item created later is left alone: another run published it, and readers
take it.

In step 7, before it records anything, the publisher searches again (§5) and checks that the book item it added is the one
readers pick. If it is not (a later run's item is current), it MUST NOT record the new revision alone: the use of both
revisions stays recorded, and it reports that another run published the book.

It SHOULD do the same for page, text and links items of the book that are tagged `state:current` and that the new book
item does not name. It MUST NOT supersede an item the new book item names: an unchanged page is the same item in both
revisions, and is registered again with the new revision's tags in step 2.

A book item whose key the library already has (a publisher brings back an earlier revision, byte for byte) keeps its
original `createdAt`, so it is older than the book items after it. Bringing it back is the one case where a publisher
supersedes newer book items: it registers it as current, then supersedes every other current book item, and the switch
happens then, not at step 4. It MUST hold the book's lock to do so.

Superseded items are not withdrawn: a reader that opened the old revision keeps reading it, from its cache or from the
library.

### 6.3 Recording the use

```
PUT v1/books/<slug>/assets   { "keys": ["c1:…", …] }
```

(registry API §6). The keys of a revision are: the book item, its page items, its text and links items, every asset in
`assets` with the keys of its `renditions` (1.2 §4.3) and its `poster`, each by its c1 key (a `sha256:` id by its
resolution key, 1.2 §3.3), and the question manifests the links name with the
assets they list. The call replaces the book's set, so it always carries everything that must stay: in steps 3 and 5 both
revisions, in step 7 the new one, after which the old revision's items that the new one does not use leave the set. The
keys the library records for the book now are found with `GET v1/search?book=<slug>` (registry API §5), or the publisher
keeps its own list.

A library MUST NOT delete the bytes of an item a book uses, nor those of a book item (`kind:book`) tagged `state:current`,
whether or not a book's recorded use names it: that is the item readers open, and between steps 4 and 5 of §6.1 it is not
yet recorded. It MAY delete other items no book has used for a while (registry API §6), so a publisher records the use on
every publish. A book's set can be large (a 300-page textbook with its
pictures and questions has thousands of keys): a library MUST accept at least 20,000 keys in one call.

## 7. Reading

A reader is given a library (its base URL) and, when the library needs one, a token.

1. **The stores.** `GET v1/stores` (registry API §7) gives the library's delivery store. The reader uses it as a host store
   (1.2 §6.1, step 3) for the whole book: book, page, text and links items, media and questions are all found through it,
   by key, at the store's URL for the key (1.2 §5.2). The book item's `assetSources` are the book's suggested stores
   (1.2 §4.4), tried after the host's: for an item or a media file the library's store does not deliver, or delivers
   bytes that fail their key.
2. **The book item.** Find it (§5), fetch it through the stores, and check it: its bytes MUST hash to its key (1.2 §6.4),
   and it MUST be a valid book item. A book item that fails is not used; the reader says the book cannot be opened.
3. **The pages.** As 1.4 §5: the book item takes the place of the index, a page entry's `key` the place of its `file`.
   Page items, the text item and the links item MUST be checked against their keys before they are used, from any store:
   the book item names them by key, so this is what makes a book item a promise about every page.
4. **Media.** As 1.4 §5 step 7 and 1.2 §6: every asset is external.
5. **Questions.** The links item names question manifests by key, and, when a link has a `questionId`, by the question's lasting id (§3.4: the current version is asked for with `POST v1/assets/current`, and checked against its key); the reader fetches them through the stores, as 1.7 says,
   when it shows them (media type `application/vnd.chalk.question+json`, which picks the store), and their pictures the
   same way (images; the manifest gives their keys, not their formats).

**A library that needs a token to read.** A library MAY refuse to search and give records without a token (the reference
library server's `PUBLIC_READ=false`). A reader that was given a token sends `Authorization: Bearer <token>` with every
registry API request (§5's search above all). `GET v1/stores` stays public (registry API §7). The delivery store needs no
token in this version: 1.2 §4.4 forbids a book from carrying one, and a reader fetches bytes by key from it as from any
store (but see §9). A reader MUST NOT put the token in a URL or send it to a store that does not ask for one (1.2 §5.1,
`auth`).

## 8. Older readers

A 1.4 reader never sees a book item: it opens the URLs of streamed books, and a library is not one. An app that reads
books from a library uses a reader that knows 1.8. Nothing in a `.chalk` file or a streamed book changes, and
`formatVersion` stays 11. A book can be published both as a streamed book and in a library: the page and text bytes
are the same.

## 9. Security and privacy

- **Keys are not secrets.** A token that guards search (§7) keeps people from finding the book; it does not keep the
  bytes from someone who has a key. A library that must keep a book's bytes from people without a token needs a
  delivery store that checks one (`auth: "bearer"`, configured by the host, never named in the book). The reference
  library server does not have such a store. A publisher MUST NOT put a book it may not distribute into a library whose
  delivery store anyone can read.
- Every item is checked against its key before use (§7), so a store, a cache or a CDN cannot change a book: it can only
  fail to deliver it.
- The tags of §4 show which books a library holds and how often they change, to anyone who may search it.

## 10. What this version does not say

- How a reader shows questions beside the text, or a highlight. A links item says what is linked; the reader decides how
  to show it.
- How a publisher numbers revisions, or how long a library keeps superseded items.
- Partial updates: each revision is a whole book item. Unchanged pages cost nothing (same key, §3.2), so a small change is
  a new book item and the pages that changed.

## 11. Conformance

- `schema/library-book.schema.json`, `schema/library-links.schema.json`. The two examples above are valid against them.
- A library server accepts the four media types, and finds book items by the tags of §4
  (`packages/library-server`, its tests).
- Refused: a book item with a page `file`, an asset `path`, a `text.file`, no `assetSources`, an item key (§3.1) that is
  not a c1 key, or an asset id that is not a content id; a links item whose `format` is not `chalk-links`, or a rectangle
  outside 0 to 1, a `questionId` that is not a UUID string.
- Accepted: a link with a `questionId` (a UUID string), and a links item without it; a book item whose asset ids are `sha256:` ids (the example above names one); a links item with a role this
  version does not know (a reader skips that link, §3.4).
