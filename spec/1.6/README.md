# Chalk 1.6: The floating window

Status: draft · `formatVersion` 11 (no model change) · builds on [1.3](../1.3/README.md)

Presentation (1.3) lets an author say what a tap on a piece of media does: play it where it is (`inline`), open it in a
dialog (`popup`), or take the whole screen (`fullscreen`). A dialog hides the page behind it, so a student cannot read
the text, look at the figure and work the lab at the same time. 1.6 adds the missing middle: a **window** that floats
over the page and leaves it usable.

## 1. The `window` value

`presentation.open` gains one value:

| Value | A tap on the card, icon or image |
|---|---|
| `window` | Opens the media in a **floating window** over the page: it plays or runs there, and the page behind it stays readable and usable (the student can scroll, turn pages and take notes while it is open) |

Everything else in 1.3 §1 is unchanged: `window` applies to images and embeds (video, audio, model3d, labs, plugins), on the
page (`displayMode: full`) and as an icon (`displayMode: icon`). Unlike `inline`, it is not turned into `popup` for an icon.
There is no schema change: `open` has always been a string, and `formatVersion` stays 11.

```json
{ "id": "lab1", "type": "embed", "embed": "plugin", "plugin": "chalk.lab", "x": 120, "y": 200, "width": 800, "height": 500,
  "lab": { "id": "org.example.physics.pendulum", "version": "1.0.0", "title": "Pendulum", "entry": "c1:…" },
  "presentation": { "open": "window" } }
```

## 2. Older readers

A reader that predates 1.6 does not know the value and, as 1.3 §1 requires, uses the default: `inline` for media on
the page, `popup` for an icon, `none` for an image on the page. The book still opens and the media still works; it
just opens where a 1.3 reader would open it. Authors who need the window and cannot accept that SHOULD say so in their
documentation. A book that carries `open: window` is valid for every reader (`conformance/valid/presentation-window.chalk`).

## 3. What a reader does

A reader that knows `window`:

- MUST open the media in a window that **does not cover the whole page and does not dim it**, and MUST leave the page
  behind it scrollable and operable;
- MUST give the window a title (the object's label, else the kind's name), a visible close control, a role of
  `dialog` with `aria-modal="false"`, and close it on `Escape` when focus is inside it;
- SHOULD let the student move and resize it (by pointer, touch and keyboard), keep it inside the reader, and open it where it
  does not cover the object that opened it, when it can tell;
- SHOULD show at most one window at a time (opening another replaces it), and at most one live lab or 3D model overall (1.3 §1);
- SHOULD size it by the media's own proportions (a lab's `size` in its manifest, an image's natural size, the object's width
  and height) and keep them while resizing, unless the host asks otherwise;
- on a narrow screen (a reference reader threshold: 640 px) SHOULD show it as a sheet across the bottom of the reader,
  without dragging;
- MUST keep a lab in the window running as it would in a dialog: it is visible, so the Host API reports `visible: true` and its
  animation frames run (1.1 §4);
- MUST NOT remember the window's place between sessions or books.

How the window **looks** (its frame, colours, whether it is a free window or a panel docked to one side, its aspect rule) is
the reader's, and a host app may change it, as for the card and the icon (1.3 §5). The reference reader's options are in
[its README](../../packages/reader/README.md#floating-window).

## 4. Conformance

`conformance/valid/presentation-window.chalk`: `open: window` on an image, an icon image, a model, a video and a lab.
A reader MUST accept it.
