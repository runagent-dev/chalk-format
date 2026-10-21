# Chalk 1.1: Labs

**Status:** Draft. Extends [Chalk 1.0 Core](../1.0/README.md); everything there still applies. Model
`formatVersion` 8. A file valid under 1.0 is valid under 1.1 unchanged.

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## 1. What 1.1 adds

A **lab** is an interactive simulation placed on a page: a pendulum the student pushes, a titration they
run, a 3D heart they cut open. It is one self-contained HTML file carried in the book like any other
asset, run by the reader in a sandbox, and talking to the reader only through the
[Host API](host-api.md) (saved state, progress, the book's own assets).

Labs are what make a `.chalk` book more than annotated pages, and they have to work:

- **in every app that reads `.chalk`**, including those written before labs existed (§4);
- **offline**, from a book downloaded once (a lab cannot fetch anything, §3.3);
- **on cheap phones** (§3.4);
- **safely**: a lab is untrusted code from whoever made the book (§3.3), confined to what it is given.

## 2. The lab object

A lab is an `embed` object (1.0 §3.4) with `embed: "plugin"`, `plugin: "chalk.lab"` and a `lab`
descriptor:

```json
{ "id": "o12", "type": "embed", "embed": "plugin", "plugin": "chalk.lab",
  "x": 120, "y": 300, "width": 960, "height": 540, "poster": "sha256:…",
  "lab": {
    "id": "org.pathshalax.physics.pendulum", "version": "1.2.0", "title": "Simple pendulum · সরল দোলক",
    "entry": "sha256:…",
    "assets": ["sha256:…"],
    "params": { "length": 0.8, "showTimer": true },
    "capabilities": ["state", "progress", "assets"]
  } }
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `plugin` | string | yes | `"chalk.lab"`. In general a namespaced plugin id (§2.2). |
| `poster` | asset id | SHOULD | An image of the lab's opening view. What every reader shows before the lab starts, and all a reader without lab support ever shows. |
| `width`, `height` | number | yes | The lab's box on the page (page units). The lab fills it; readers MAY offer a larger view. |
| `lab.id` | string | yes | Stable identity of the lab, reverse-DNS style (`org.example.subject.name`). Same lab in many books, same id. |
| `lab.version` | string | yes | The lab's own version (semver recommended). Saved state is keyed by `lab.id` + major version. |
| `lab.title` | string | yes | Human-readable name. Used as the accessible name of the frame and on the fallback card. |
| `lab.entry` | asset id | yes | The lab's HTML file (§3). MUST be a content-addressed (`sha256:`) id. |
| `lab.assets` | asset ids | no | Other assets of this book the lab may load (3D models, images, audio) through the Host API. Only these. |
| `lab.params` | object | no | JSON configuration handed to the lab at start (which variant, which constants). At most 16 KiB serialised as UTF-8 JSON. One lab file, many configurations. JSON Schema cannot state a byte limit (the schema only annotates it, `x-chalk-max-bytes`), so readers MUST check it themselves. |
| `lab.capabilities` | strings | no | Host API capabilities the lab asks for (§2.1). Absent means none. |

The embed's own `assetId` and `url` fields are not used by labs and SHOULD be absent.

### 2.1 Capabilities

| Capability | Grants |
|---|---|
| `state` | Save and restore the lab's own state (the student's settings, readings, answers). |
| `progress` | Report progress and completion (steps done, score). |
| `assets` | Load the assets listed in `lab.assets`. |

A host grants a subset and tells the lab which (Host API §3). A lab MUST work, with less, when a capability
is not granted: without `state` it starts fresh every time, without `assets` it shows what it can without
them. Readers MUST ignore capability names they do not know; later versions add more (reserved: `data`
for querying host-provided datasets).

### 2.2 Plugin ids and the must-ignore rule

`plugin` names what runs an `embed: "plugin"` object. Ids are namespaced: `chalk.*` is reserved for
types defined by this specification (`chalk.lab` is the only one in 1.1); anyone else uses a reverse-DNS
id they control (`org.example.widget`). Lowercase letters, digits, `-`, separated by `.`, at least two
parts.

A reader that does not support an object's `plugin` id MUST still accept the page and MUST draw the object
as its **fallback card**: the `poster` scaled to cover `width` × `height` (or a neutral tile if there is no
poster), with `lab.title` when present. It MUST NOT reject the book. Writers MUST preserve objects whose
plugin they do not support, including fields they do not know: the reference model keeps unknown fields of
embeds and of the `lab` descriptor through a parse and write.

## 3. The lab file

### 3.1 One self-contained HTML file

- The entry asset is an HTML document, UTF-8, starting with `<!doctype html>` (an optional BOM and
  whitespace may precede it), declared with type `text/html`. HTML is **not** part of the media set: an
  app that sniffs uploads to decide what it accepts as images, video, audio or models MUST keep rejecting
  it (accepted as media and served from the app's origin, HTML is stored XSS). It is recognised only where
  a lab is being placed (reference: `isLabEntryBytes`, separate from `sniffMediaType`), and readers MUST
  NOT render `text/html` assets in any way other than as a lab in the sandbox.
- Everything the page needs at start, scripts, styles, fonts and small images, is inline (`<script>`,
  `<style>`, `data:` URLs). There is no `<script src>`, `<link href>` or `import` of another file:
  nothing outside the document resolves (§3.3).
- Larger media (a `.glb` model, a texture, a sound) is a separate asset of the book, listed in
  `lab.assets` and loaded with `asset.get` (Host API §4.3). Labs that are geometry from code, as most
  physics and chemistry labs are, need none.
- The same lab file is shared by every placement that uses it: being content-addressed, a book stores it
  once however many pages embed it.

### 3.2 What the lab is told

At start the lab receives (Host API §3) its `params`, the reader's language (`bn`, `en`, …), light or dark
theme, whether the user prefers reduced motion, the capabilities granted, and its saved state if any.
It is never told who the student is: hosts keep identities, labs keep physics.

### 3.3 Sandbox (normative for hosts)

A host MUST run every lab:

- in an `<iframe>` with `sandbox="allow-scripts"` and **without** `allow-same-origin`, so the lab has an
  opaque origin: no cookies, no storage of the host, no access to the host page. Hosts MAY add
  `allow-pointer-lock`; fullscreen goes through the Host API, not `allow-fullscreen`;
- with this Content Security Policy, either as an HTTP header or as a `<meta http-equiv>` element inserted
  as the first child of `<head>` before any of the lab's own markup:

  ```
  default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; style-src 'unsafe-inline';
  img-src data: blob:; media-src data: blob:; font-src data: blob:; connect-src 'none';
  worker-src blob:; form-action 'none'; base-uri 'none'
  ```

  `connect-src 'none'` is the point: a lab cannot fetch, post or open sockets. Everything it shows comes
  from the book. (`'unsafe-eval'` is allowed because shader compilers and some simulation libraries
  need it; it grants nothing beyond the sandbox.)
- with a **guard script** inserted right after the CSP `<meta>`, before any of the lab's markup, that reports
  the lab's document going away (`pagehide`) to the host as `gone` (Host API §4.6), carrying a random nonce
  made for this one mount. It registers first, in the capture phase, and keeps its own reference to the
  parent, so the lab cannot silence it. Reference: `labGuard(nonce)` in `packages/lab`;
- only from bytes whose SHA-256 matches `lab.entry`. A host MUST NOT run a lab whose entry bytes do not
  match its id.

Hosts accept window messages only from the lab's own frame, and after the handshake talk to it only on the
private channel `init` hands over (Host API §2).

**Navigation.** No sandbox flag or CSP directive that browsers support stops a frame from navigating
itself (`location.href = …`, `<meta http-equiv="refresh">`), and a document loaded that way runs without
this CSP. Hosts therefore MUST stop a lab for good as soon as its document goes away (the guard's `gone`)
and SHOULD also stop it, and empty its frame, if the frame loads a second document. The page the lab
navigated to never has the channel, so it can neither call the Host API nor receive replies. What this
cannot prevent is a lab carrying out, in the URL it navigates to, data it already holds: its `params`, its
own saved state, and assets listed in `lab.assets` that it has loaded. So `connect-src 'none'` stops a lab
from using the network for anything else, but **a lab is not a container for secrets**: a book author lists
in `lab.assets` only what they are willing to hand to the lab's author.

A frame loaded through `srcdoc` or a `blob:` URL inherits the host page's own CSP as well. A host whose
page forbids inline scripts therefore serves labs from a separate origin (with the policy above as an HTTP
header) instead.

### 3.4 Budgets

Labs SHOULD keep within these, measured on a mid-range Android phone; hosts MAY warn on or refuse larger.

| | Budget |
|---|---|
| Entry HTML | ≤ 2 MiB (≤ 300 KiB recommended) |
| Each asset in `lab.assets` | ≤ 8 MiB; ≤ 20 MiB in total per lab |
| Saved state | ≤ 64 KiB (enforced by hosts) |
| Frame rate target | 30 fps; render on change where possible |
| Draw calls / triangles | < 120 / < 150 k on phones |

A lab MUST stop its render loop while hidden (Host API `visibility`), so a book with a lab on every page
costs nothing on pages the student is not looking at. Hosts SHOULD start a lab only when its page is
visible and the student starts it (a tap on the poster), and SHOULD run at most one lab at a time on
phones.

## 4. Compatibility with 1.0 readers

The encoding above was chosen so that books with labs open in readers that predate them:

- `embed: "plugin"` is a 1.0 embed kind, and 1.0 readers ignore object fields they do not know. A 1.0
  reader therefore opens the page and draws the lab as a media card with its `poster`. It cannot run the
  lab. (Verified against the 1.0 reference reader: `conformance/valid/lab.chalk` opens with every page
  and asset.)
- A 1.0 reader receiving `formatVersion: 8` applies no migration and validates the document as it is,
  which succeeds for the reason above.
- The entry asset is an ordinary manifest asset; 1.0 readers carry its bytes without interpreting them.
- **Caveat:** a 1.0 *editor* that re-saves such a book drops the fields it does not know (`plugin`,
  `lab`), leaving a plain plugin card with a poster. Readers are safe; round trips through old editors
  are not. Writers from 1.1 on MUST preserve unknown fields (§2.2).

Migration from `formatVersion` 7 to 8 is the identity: a 7 document contains no labs.

## 5. Conformance additions

- A 1.1 **reader** accepts `conformance/valid/lab.chalk`, and either runs its lab under §3.3 and the Host
  API or shows its fallback card. It rejects the `invalid/lab-*` cases.
- A 1.1 **host** (a reader that runs labs) additionally passes the Host API behaviours in
  [host-api.md §7](host-api.md#7-conformance) (the reference implementation's tests in `packages/lab` are
  the executable form).
- A **lab** conforms if it runs under the §3.3 sandbox, completes the handshake, works with no capability
  granted, and stops rendering while hidden.

## 6. Still on the roadmap

(Where thin books' external assets come from is now [Chalk 1.2: asset stores](../1.2/README.md).)

1.1 compatibility for *other* new object types (a general fallback on every object, `requires` in the
manifest), host-provided data queries (the reserved `data` capability), learner-state packages (saved
lab state travelling with an overlay), navigation, reflowable text and the rest of
[1.0 §7](../1.0/README.md#7-roadmap-not-part-of-10).
