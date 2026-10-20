# Chalk Host API, version 1

**Status:** Draft, part of [Chalk 1.1](README.md). How a lab and the reader that runs it (the **host**) talk.
Reference implementation: [`packages/lab`](../../packages/lab) (`createLabHost` for hosts, `connectLab`
for labs). A lab does not need it: the protocol is small enough to write by hand
([example](../../examples/labs/pendulum.html)).

## 1. Model

The lab runs in a sandboxed frame (1.1 §3.3) and the host in the page around it. They exchange JSON
messages. The lab asks (**requests**, answered by **replies**) and reports (**notices**); the host tells the
lab about its surroundings (**events**). Nothing else crosses the frame.

Only the handshake uses the window (`postMessage` between the frame and its parent). `init` hands the lab
one end of a private `MessageChannel`, and everything after it travels on that channel. A document the frame
is navigated to never has that port, so it can say `hello` but gets nothing (1.1 §3.3).

```
lab                                      host
 │── hello ─────────────── window ─────▶│
 │◀──────────── init + port ─ window ───│   params, locale, theme, visible, granted, state
 │══ ready ════════════════ channel ═══▶│   first frame drawn: host hides the poster
 │══ state.save {state} ═══ channel ═══▶│   (request: replied)
 │◀═══════════ reply {ok} ═ channel ════│
 │══ progress {step, completed} ═══════▶│   (notice: not replied)
 │◀═════ visibility {false} ═ channel ══│   (event)
 │── gone ──────────────── window ─────▶│   (from the host's guard script, if the lab's document goes away)
```

## 2. Messages

Every message is a plain object (structured-cloneable) with:

| Field | Meaning |
|---|---|
| `chalk` | The protocol marker, always `1`. Messages without it MUST be ignored. |
| `type` | What the message is (§3–§5). |
| `id` | Requests only: an integer chosen by the lab, unique among its pending requests. |

A reply is `{ chalk: 1, type: "reply", id, ok: true, result }` or
`{ chalk: 1, type: "reply", id, ok: false, error: { code, message } }`. Error codes: `denied` (capability
not granted or not allowed), `not_found`, `too_large`, `invalid` (malformed request), `unknown` (request
type the host does not know), `failed` (anything else).

- **On the window** there are three messages: `hello` and `gone` (lab → host) and `init` (host → lab).
  The lab sends to `window.parent` with target origin `"*"` (it runs at an opaque origin and cannot know the
  host's) and MUST accept `init` only where `event.source === window.parent`, taking the channel from
  `event.ports[0]`. The host MUST accept `hello` and `gone` only where `event.source` is the lab frame's
  `contentWindow`, and MUST ignore every other window message, whatever it claims.
- **On the channel** go all requests, replies, notices and events. Each side posts on its port with
  `port.postMessage(message, transfer)`.
- Both sides MUST ignore message types they do not know (that is how the protocol grows). A host answers an
  unknown *request* (one with an `id`) with error `unknown`.
- A host SHOULD reply to every request within 10 s; a lab SHOULD treat a longer silence as `failed`.

## 3. Start

1. The lab, once its script runs, sends **`hello`**: `{ api: [1], lab: { id, version } }`. `api` lists
   the protocol versions it speaks. It MAY resend `hello` every 500 ms until `init` arrives (the host may
   attach its listener late).
2. The host answers with the event **`init`**, once, on the window, transferring the lab's end of a new
   `MessageChannel` (`postMessage(init, "*", [port])`):

   | Field | Meaning |
   |---|---|
   | `api` | The version chosen, from the lab's list. A host that shares none sends `init` with `api: 0` and stops. |
   | `params` | `lab.params` from the book, or `{}`. |
   | `locale` | The reader's UI language, BCP 47 (`"bn"`, `"en"`). |
   | `theme` | `"light"` or `"dark"`. |
   | `reducedMotion` | The user's reduced-motion preference. |
   | `granted` | The capabilities granted (§2.1 of 1.1), a subset of those asked for. |
   | `state` | The state saved last time (§4.1), or `null`. Only when `state` is granted. |
   | `mode` | `"interactive"`, or `"preview"` (no input expected: thumbnails, print). |
   | `visible` | Whether the lab is on screen now. While `false` the lab MUST NOT render (§5). A host that is told the lab is hidden before the handshake says so here, since events cannot be sent before it. |

   A host MUST check `hello.lab.id` against the book's `lab.id`; on a mismatch it SHOULD stop the lab.
   If the host cannot load the saved state it MUST still send `init`, with `state: null`.
3. When its first frame is on screen the lab sends the notice **`ready`**. Until then the host keeps the
   poster visible; a host MAY give up and keep the poster if `ready` does not come within 20 s.

## 4. Requests and notices (lab → host)

### 4.1 `state.save` (request, capability `state`)

`{ state }`: any JSON value up to 64 KiB serialised; the host replies `too_large` beyond that. The host
stores it for this book, page object and learner, keyed also by the `lab.id` and its major version
(`1.2.0` → `1`), and hands it back in `init.state` next time. Latest save wins. A lab SHOULD save when
something worth keeping changes (a reading taken, an answer entered), not on every frame, and at most
once a second.

### 4.2 `progress` (notice, capability `progress`)

`{ step?: { done, total }, score?, completed? }`: `done` and `total` integers, `score` a number from 0
to 1, `completed` true once the lab's task is finished. Fields are cumulative (each notice says where the
student is now, not what changed). Hosts use it for progress bars and records; they SHOULD batch what they
send to a server. Without the capability, notices are ignored.

### 4.3 `asset.get` (request, capability `assets`)

`{ assetId }`: one of the ids in `lab.assets`. The result is `{ type, bytes }`, `bytes` an `ArrayBuffer`
(transferred, not copied) whose SHA-256 matches the id, `type` the sniffed media type. An id not in
`lab.assets` gets `denied`; one whose bytes the host cannot obtain gets `not_found`. The lab turns the
bytes into what it needs, for example `URL.createObjectURL(new Blob([bytes], { type }))` for a GLTF
loader, which the CSP allows (`blob:`). It SHOULD keep one URL per asset and revoke it when done, rather
than making a new one on each use: on a phone, every un-revoked URL keeps its bytes alive.

### 4.4 `ui.fullscreen` (request)

`{ on }`: asks the host to show the lab full screen (or to leave). The host decides; the result is
`{ on }`, the state after the request. Hosts SHOULD honour it only during a user gesture in the lab.

### 4.5 `ready` (notice)

See §3.

### 4.6 `gone` (window, from the guard)

`{ nonce }`: posted by the guard script the host puts ahead of the lab's code (1.1 §3.3) when the lab's
document is unloaded, which is when the frame navigates. The host MUST then stop the lab for good: close
the channel, answer nothing more, and send no `init` to anything that says `hello` in that frame afterwards.

A message posted by a document that is unloading does not arrive with the frame as its `event.source`
(browsers give no source, or a dead one). The host therefore recognises `gone` by the nonce it made for this
mount, and accepts it from the lab's frame or from a source that is no longer a live window, never from
another live window. A lab can read its own nonce, but forging `gone` only stops that lab.

## 5. Events (host → lab)

| `type` | Fields | The lab |
|---|---|---|
| `init` | §3 | Starts (on the window, with the channel). |
| `visibility` | `visible` | MUST stop its render loop and timers while `false` and resume on `true`. Hosts send `false` when the lab scrolls out of view, the page changes or the app goes to the background. |
| `theme` | `theme` | Switches colours. |
| `locale` | `locale` | Switches language. |
| `reset` | | Returns to the state `params` describe, as if started fresh. The host has already discarded saved state. |

## 6. Versioning

This is version 1. Later versions add message types and fields, which old peers ignore (§2); a change
that old peers cannot ignore gets a new version number, negotiated through `hello.api`.

## 7. Conformance

A **host** conforms if it:

1. runs the lab under the 1.1 §3.3 sandbox, CSP and guard, and only when the entry's bytes match its id;
2. ignores window messages not from the lab's frame or other than `hello`/`gone`, messages without
   `chalk: 1`, and notices of unknown type, and answers unknown requests with `unknown`;
3. answers `hello` with exactly one `init` carrying the channel, granting only capabilities the lab asked
   for, and sends `init` even when saved state cannot be loaded;
4. enforces capabilities (`denied`), the `lab.assets` list (`denied`) and the 64 KiB state limit
   (`too_large`);
5. hands saved state back in `init.state` for the same lab id and major version, and not otherwise;
6. says in `init` whether the lab is visible, and sends `visibility` when that changes;
7. stops for good on `gone`, and when the frame loads a second document.

A **lab** conforms if it sends `hello` and waits for `init`, then talks only on the channel; works when
`granted` is empty; accepts `init` only from `window.parent`; sends `ready` after its first frame; does not
render while hidden (including from the start, when `init.visible` is false); and ignores events and
notices it does not know.
