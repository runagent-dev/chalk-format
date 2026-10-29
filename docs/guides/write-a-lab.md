# Write a lab

A lab is a small interactive simulation placed on a book page: a pendulum to time, a screw gauge to read, a
circuit to wire. This guide covers writing one, testing it, describing it in a manifest, and putting it in a
library so book designers can find and place it.

Specs: [1.1 Labs](../../spec/1.1/README.md), the [Host API](../../spec/1.1/host-api.md),
[1.5 Lab libraries and manifests](../../spec/1.5/README.md).
Examples: [`examples/labs/pendulum.html`](../../examples/labs/pendulum.html) (2D canvas, no libraries) and
[`examples/labs/screw-gauge.html`](../../examples/labs/screw-gauge.html) (3D, on the shared three.js).

## 1. One HTML file

A lab is **one HTML file**, UTF-8, starting with `<!doctype html>`. Everything it needs at start is inline:
scripts, styles, fonts and small images (`data:` URLs). It has no `<script src>`, no `<link href>` and no
`import` of another file of its own. Larger media (a `.glb` model, a texture, a sound) is a separate asset of the
book, listed in `lab.assets` and fetched through the Host API.

The one exception is **libraries** such as three.js (§4): the lab imports them by name, and the reader supplies
them.

## 2. The sandbox: what a lab cannot do

Readers run every lab in an `<iframe sandbox="allow-scripts">` with an opaque origin and this policy
([spec 1.1 §3.3](../../spec/1.1/README.md#33-sandbox-normative-for-hosts)):

```
default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; style-src 'unsafe-inline';
img-src data: blob:; media-src data: blob:; font-src data: blob:; connect-src 'none';
worker-src blob:; form-action 'none'; base-uri 'none'
```

So a lab:

- **cannot use the network**: no `fetch`, no XHR, no WebSocket, no CDN, no web fonts;
- cannot read cookies or storage of the page around it, or reach into that page;
- is never told who the student is;
- runs only if its bytes match its key (`lab.entry`).

Everything it shows comes from the book. A lab is not a place for secrets: whatever it is given, it could leak
in a URL it navigates to.

Budgets (spec 1.1 §3.4): the HTML ≤ 2 MiB (≤ 300 KiB recommended), saved state ≤ 64 KiB, 30 fps, and fewer than
120 draw calls on phones. **Stop rendering while hidden** (the `visibility` event): a book can have a lab on
every page.

## 3. Talking to the reader (Host API)

The lab says `hello`. The reader answers with `init` and a private `MessagePort`, and everything after that goes on
the port. `init` carries:

- `params`: the settings the book designer chose;
- `locale`: `bn`, `en`, …;
- `theme`: light or dark;
- `reducedMotion`;
- the capabilities granted;
- the state saved last time.

**With the client** (`@chalk-format/core/lab/client`; bundle it into your file with esbuild or similar, since the lab
cannot import files):

```js
import { connectLab } from '@chalk-format/core/lab/client';

const lab = await connectLab({ id: 'org.example.pendulum', version: '1.0.0' });
const P = { length: 1, swings: 10, ...lab.params };    // defaults, then the designer's settings
let readings = lab.state?.readings ?? [];               // what the student did last time
draw();
lab.ready();                                            // first frame on screen: the reader hides the poster

lab.on('visibility', (on) => (on ? resume() : pause()));
lab.on('theme', setTheme);
lab.on('locale', setLocale);
lab.on('reset', () => { readings = []; draw(); });

// when something changes
await lab.save({ readings });                                            // capability "state", JSON ≤ 64 KiB
lab.progress({ step: { done: readings.length, total: 3 }, completed: readings.length >= 3 });  // "progress"
```

`connectLab` waits up to 15 s for `init` (`timeoutMs`) and then rejects. A lab that should also run on its own
(§5) catches that and starts with its defaults.

The rest of the session API:

- `getAsset(id)` and `assetUrl(id)`: one of `lab.assets` as bytes or a `blob:` URL (for loaders such as
  GLTFLoader), with capability `assets`;
- `fullscreen(on)`;
- `has(capability)`.

**By hand.** The protocol is small enough to write directly, as both examples do (the Host API section at the
top of their `<script>`). Messages carry `chalk: 1`; requests carry an `id` and get a `reply` on the port.

## 4. Using three.js: `lab.libraries`

A lab that uses three.js does not carry it. It imports it by name and lists it in its `libraries`. The reader
then supplies the shared, verified build, so a book with twenty 3D labs carries three.js once.

```html
<!-- only for opening the file on its own: inside a reader, the reader's import map comes first and wins -->
<script type="importmap">
  { "imports": { "three": "https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js",
                 "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/" } }
</script>
<script type="module">
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
</script>
```

- **Use the shared builds.** [`libraries/catalog.json`](../../libraries/catalog.json) lists them with their
  keys: three 0.185.1 and its OrbitControls, GLTFLoader and CSS2DRenderer add-ons. Build the files with
  `npx tsx tools/lab-libraries.ts` (into `libraries/build/`). The builds are reproducible: the same version gives
  the same bytes and so the same keys on any machine, and CI checks it (`--check`).
- **Name exactly the specifiers you import.** `three/addons/controls/OrbitControls.js` is its own specifier, with
  its own entry in `libraries`.
- **Keep your own import map at the same version**, so the file runs when opened on its own.
- **Say so when the libraries are missing.** A reader older than 1.5 does not supply them, and the sandbox
  blocks the CDN. Catch the failed import and show a message (see the `error` listener near the top of
  `screw-gauge.html`).

Import maps need Chrome 89+, Firefox 108+ or Safari 16.4+.

## 5. Runnable on its own

Open the HTML file directly in a browser, or serve the folder with any static server, and it should work. That
needs two things:

1. its own import map for any libraries (above), and
2. starting with default settings when no reader answers. The examples wait about 300 ms for `init`, and if
   `window.parent === window` they start with defaults.

## 6. The lab manifest

A manifest describes a lab to a store (`application/vnd.chalk.lab+json`, schema
[`schema/lab-manifest.schema.json`](../../schema/lab-manifest.schema.json)). With it, a designer can find the lab,
place it at the right size, and get its libraries with it. Trimmed from
[`examples/labs/screw-gauge.lab.json`](../../examples/labs/screw-gauge.lab.json):

```json
{
  "format": "chalk.lab", "manifestVersion": 1,
  "id": "org.chalk-format.examples.screw-gauge", "version": "1.0.0",
  "title": { "bn": "স্ক্রু গজ", "en": "Screw gauge" },
  "description": { "bn": "…", "en": "Turn the thimble onto the wire, read the main and circular scales, and enter the diameter." },
  "subject": "physics", "classes": ["9", "10"], "tags": ["measurement", "least count", "screw gauge"],
  "entry": "c1:d2qouiwvb7uk7lamo3ye6hpsom",
  "poster": "c1:fylmqzbkwsvx2owkq5kqo6th7q",
  "libraries": [
    { "specifier": "three", "version": "0.185.1", "asset": "c1:tnju7fmkkem7urwcj2quaiihxm" },
    { "specifier": "three/addons/controls/OrbitControls.js", "version": "0.185.1", "asset": "c1:nqdfnh3c3kmjnngrlj4erirjdm" }
  ],
  "capabilities": ["state", "progress"],
  "size": { "width": 960, "height": 600, "minWidth": 480, "minHeight": 320 },
  "params": {
    "type": "object",
    "properties": {
      "pitch": { "type": "number", "title": { "bn": "পিচ", "en": "Pitch" }, "minimum": 0.25, "maximum": 1, "multipleOf": 0.25, "default": 0.5, "x-chalk-unit": "mm" },
      "divisions": { "type": "integer", "title": { "en": "Circular scale divisions" }, "enum": [50, 100], "default": 50 }
    }
  },
  "presets": [ { "id": "zero-error", "title": { "en": "With a zero error" }, "params": { "zeroError": true } } ],
  "license": "Apache-2.0"
}
```

- `id` is yours (reverse domain). Publish a change as a new `version`; books keep the version they were made
  with.
- `entry` and `poster` are the **keys of the files' bytes**. Change one byte of the HTML and the key changes, so
  update the manifest after every edit. To print keys:

  ```bash
  npx tsx --eval "import('./packages/model/src/index.ts').then(async ({ assetKey }) => { for (const f of process.argv.slice(1)) console.log(await assetKey(new Uint8Array(require('node:fs').readFileSync(f))), f); })" \
      examples/labs/screw-gauge.html examples/labs/screw-gauge-poster.png
  ```

  In code: `await assetKey(bytes)` from `@chalk-format/model`.
- `libraries[].asset` comes from `libraries/catalog.json`.
- `params` is a small JSON Schema of the settings a designer may change: `number`, `integer`, `boolean` or
  `string`, with `default`, `minimum`/`maximum`/`multipleOf`, `enum`, and `x-chalk-unit`. The values arrive in
  the lab as `params`. `checkLabParams(manifest, params)` in `@chalk-format/core` validates settings, and
  `labObjectFromManifest(manifest, …)` builds the object a tool places on a page.
- `size` is the box to place it in, and the smallest it is usable at.

**The poster** is the picture readers show before the lab starts (and what readers without lab support show).
Use the lab's opening view: open the file on its own, take a screenshot at the `size` proportions, and save it
as PNG or WebP. Keep the text in it in the language of the books it is for.

## 7. Test it

- **On its own:** open the file in Chrome, Firefox and Safari.
- **In the reader:** run the showcase (`pnpm --filter @chalk-format/reader-app dev`, http://localhost:5190),
  switch to **Author**, and drop the `.html` file onto a page (or **+ › Lab**). Switch to **Read** and tap it. A
  lab added from a file is placed **without** a manifest, so it gets no `libraries`. A three.js lab must be
  placed from a library (§8) to get them.
- `pnpm check` runs the repository's tests. `tools/reader-media-e2e.mjs` shows how a lab is driven with real
  clicks in a browser.

## 8. Put it in a library

Authors place labs from a **library**: the gallery under **+ › Lab** lists the lab manifests in the connected
libraries, and a pick places the lab with its poster, size, libraries and default settings. Library servers
speak the [registry API](../../spec/1.2/registry-api.md); `packages/library-server` is one you can run.

`tools/library-add.ts` uploads everything a lab needs: the HTML, the poster, the shared libraries it names
(taken from `libraries/build/`), and the manifest last. Each file is checked against the key the manifest
gives it. Write a list, as in [`examples/library-seed.json`](../../examples/library-seed.json):

```json
[
  { "lab": "labs/screw-gauge.lab.json",
    "files": { "c1:d2qouiwvb7uk7lamo3ye6hpsom": "labs/screw-gauge.html",
               "c1:fylmqzbkwsvx2owkq5kqo6th7q": "labs/screw-gauge-poster.png" } }
]
```

`files` maps each key in the manifest (`entry`, `poster`, `assets`) to the file holding those bytes. Paths are
relative to the list. Then:

```bash
npx tsx tools/lab-libraries.ts          # once: builds libraries/build/
CHALK_LIBRARY_TOKEN=… npx tsx tools/library-add.ts https://library.example.org my-labs.json
```

Running it again uploads nothing new. The same list can hold plain media too
(`{ "file": "…", "title": "…", "tags": […], "poster": "…" }`).

**A library on your own machine**, to try this without a server:

```bash
DATABASE_URL=pglite:$HOME/chalk-library/db STORAGE=disk DISK_DIR=$HOME/chalk-library/files PORT=8788 TOKENS=me:dev-token \
    npx tsx packages/library-server/src/cli.ts serve
CHALK_LIBRARY_TOKEN=dev-token npx tsx tools/library-add.ts http://localhost:8788 examples/library-seed.json
```

Then, in the showcase's author mode, connect `http://localhost:8788` with the token `dev-token` (sidebar ›
**Connect a library server**). **+ › Lab** lists the screw gauge and the pendulum.

Not built yet: a settings form in the editor for a placed lab's `params` (it is placed with the defaults), and
a tool that checks a lab file and its manifest before upload.
