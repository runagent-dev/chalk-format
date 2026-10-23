# Media libraries

A book refers to its media (images, video, sound, 3D models, labs) by **key**: `c1:` plus 26 characters, computed
once from the bytes ([spec 1.2](../../spec/1.2/README.md)). The bytes can travel inside the `.chalk` file, or live
in a **library**. Authors find and add media through libraries, and readers get from them what a book does not carry.

Why it works this way:

- **Books stay small and portable.** A book holds keys, never addresses, accounts or tokens. Any reader on any
  device that is connected to a library holding the media shows the same book.
- **Media is kept once.** The same bytes give the same key, so adding a video twice keeps it once, and twenty books
  that use it share one copy.
- **Nothing has to be trusted.** A reader checks every file against its key, so a library on a USB drive or a
  classroom server cannot swap one picture for another.

## The three kinds

| Kind | Where the media is | Can others read it? | Made with |
|---|---|---|---|
| **This device** | The browser's own database (IndexedDB). Always there, and works offline. | No, only this browser | `deviceLibrary()` |
| **Folder** | A folder on the computer, a USB drive or a school server's disk | Yes, if the folder is served over HTTP | `folderLibrary(dir, { publicUrl? })` |
| **Library server** | A server that speaks the [registry API](../../spec/1.2/registry-api.md), over Postgres and S3-compatible storage | Yes, from its public delivery address | `registryLibrary({ url, token? })` |

All three implement one interface, `Library` in `@chalk-format/store` (`search`, `item`, `get`, `url`, `has`, and
optionally `put`, `delivery`, `status`, `connect`). The reader and the editor only ever see that interface.

### A folder's layout

A folder library writes what it is given in the standard layout of spec 1.2 §5, and keeps a catalog for search:

```
my-library/
  chalk-library.json         titles, types, tags, sizes, posters; which file holds each key
  index/ab.json              one shard per first two characters of the key: key → file (spec 1.2 §5.3)
  c1/ab/cd/abcd…             media added through the library, named by key
  anything/else.mp4          media that was already there, found by "scan"
```

`scan()` (the ↻ button in the Libraries panel) hashes files that were already in the folder and adds them to the
catalog. They stay where they are. Because the index shards are plain JSON, the same folder served by any static web
server is a store that readers can use: pass its address as `publicUrl`. Connecting a folder in the browser needs the
File System Access API (Chrome or Edge on a computer). After a reload the browser asks for access again, and the
panel shows **Allow** for that.

### A library server

`packages/library-server` is a complete one: Postgres for the records and search, Cloudflare R2, MinIO, AWS S3 or a
plain disk for the bytes. Readers fetch the bytes straight from the bucket's public address (a CDN), never through
the API. See [Run a library server](run-a-library-server.md).

Without a token you can search and read (unless the server turns that off). With a token you can also upload.

## In the editor

Turn on author mode (`config.authoring.enabled`) and switch to **Author**.

- **Libraries panel.** Click an empty part of the page (or press Escape until nothing is selected). The sidebar
  shows the book, the page and **Libraries**. There you can:
  - **Connect a folder** or **Connect a library server**. A server needs its address, and a token if you want to
    upload.
  - Change the order with ↑ and ↓. Earlier libraries are asked first.
  - **Disconnect** a library (This device always stays).
  - Read each library's status from its dot: green is connected, otherwise it needs a token, access or a network.
- **Gallery.** Click **+** in the left rail and choose Image, Video, Sound, 3D model or Lab.
  - The gallery searches every connected library at once (or one, chosen in the menu), in any script, ignoring
    case.
  - A pick places the item on the page at its own proportions, using the facts the library keeps, so nothing is
    downloaded first.
  - A lab is placed from its [lab manifest](../../spec/1.5/README.md), together with its poster and the shared
    libraries it imports.
- **Upload new.** Puts a file into the library chosen under the button, then places it. The first writable library
  is chosen to begin with. A video gets a poster from one of its frames, stored in the same library.

## In code

```tsx
import { ChalkReader, useSavedLibraries } from '@chalk-format/reader';
import { deviceLibrary, folderLibrary, registryLibrary } from '@chalk-format/store';

// 1. The app decides which libraries there are
<ChalkReader
  source={book}
  libraries={[
    registryLibrary({ url: 'https://library.example.org', token: () => session.token }),
    deviceLibrary(),
  ]}
/>

// 2. People connect their own; the list is kept in this browser
const [libraries, setLibraries] = useSavedLibraries();
<ChalkReader source={book} libraries={libraries} onLibrariesChange={setLibraries} />

// 3. Both: the app offers its own library server, people manage the rest
const [libraries, setLibraries] = useSavedLibraries({
  preset: [{ url: 'https://library.example.org', name: 'School library' }],
});
```

How each option behaves:

- **`libraries`** is a list, first first. A new list asks again, so connecting the right library makes missing
  media appear.
- **`onLibrariesChange`** lets the Libraries panel change the list. Without it the panel only shows the list.
- **`registryLibrary`**:
  - `token` may be a string, or a function that returns the current token (for sign-ins that expire).
  - A token given as a function is never stored.
  - Without a token the library is read-only (`writable: false`).
- **`useSavedLibraries`**:
  - It keeps library servers (address, name, and a token typed into the panel) in `localStorage` under
    `chalk:libraries` (change it with `key`).
  - Folder handles go in IndexedDB.
  - "This device" stays where the person put it. Pass `device: false` to leave it out.
  - It returns `[libraries, setLibraries, ready]`.
- **`preset`**:
  - Each server is connected **once**, the first time it is offered in this browser, in front of This device, so
    uploads go there by default.
  - After that, the person's own order wins, and a preset they disconnect stays disconnected.
  - A preset's token fills in a saved connection to the same address that has none.
  - Changing the preset list offers only the new addresses.
- **Shipping a token to the browser.** A token given in `preset` (or anywhere in browser code) ends up in the
  bundle. Do that only for local work. For people, use a sign-in and `token: () => …`.

The showcase app does the third pattern from its environment: copy `apps/reader/.env.example` to
`apps/reader/.env.local`, set `VITE_CHALK_LIBRARY_URL` (and `VITE_CHALK_LIBRARY_NAME`, `VITE_CHALK_LIBRARY_TOKEN`),
and restart `pnpm --filter @chalk-format/reader-app dev`.

Outside React, the same objects work on their own:

```ts
const lib = registryLibrary({ url: 'https://library.example.org', token });
const { items } = await lib.search({ q: 'দোলক', types: ['video/*'] });
const added = await lib.put!({ bytes, type: 'image/png', title: 'Optics bench', tags: ['optics'] });
```

## When media is missing

If neither the book nor any connected library has an item, the reader still opens the book:

- The item's place shows a card marked **Not in your libraries**.
- A chip says **"N items not found"**. It opens a list of what is missing and on which page, with a hint to connect
  a library that has it.
- Connecting or reordering libraries asks again, and items that are found appear in place.

## Saving

**Save** in author mode writes a self-contained `.chalk` file: every asset the book uses, wherever it was found,
goes inside, so the file opens anywhere with no library at all. Hosts can take the bytes themselves with
`onSave(bytes, lesson)`. The book records keys only, never which library an item came from.

## Filling a library from a list

`tools/library-add.ts` uploads media with titles, tags, subjects, licences and posters, and labs whole (the lab's
page, its poster, the shared libraries it imports, then its manifest). Image, video and sound sizes and lengths
come from `ffprobe`, if it is installed. Running the tool again uploads nothing new.

```bash
npx tsx tools/lab-libraries.ts      # once: builds the shared three.js files labs import (libraries/build/)
CHALK_LIBRARY_TOKEN=… npx tsx tools/library-add.ts https://library.example.org examples/library-seed.json
```

The list is JSON, and paths are relative to the list file:

```json
[
  { "file": "media/pendulum.webm", "poster": "media/pendulum-poster.png",
    "title": "সরল দোলক · Simple pendulum", "tags": ["pendulum", "period"], "subject": "physics", "license": "CC-BY-4.0" },
  { "lab": "labs/screw-gauge.lab.json",
    "files": { "c1:l5lsonev5rtspdijwg66epn4cm": "labs/screw-gauge.html", "c1:fylmqzbkwsvx2owkq5kqo6th7q": "labs/screw-gauge-poster.png" } }
]
```

- A lab's manifest names its page and poster by key. `files` says which file has those bytes, and the tool refuses
  a file whose key does not match.
- Shared libraries (`three`, its add-ons) come from [`libraries/catalog.json`](../../libraries/catalog.json).
- Titles are searched word by word in any script, so write both languages ("সরল দোলক · Simple pendulum") to
  make an item findable in either.

[`examples/library-seed.json`](../../examples/library-seed.json) fills a library with this repository's sample
media and both example labs.
