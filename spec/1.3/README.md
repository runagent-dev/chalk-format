# Chalk 1.3: Presentation

Status: draft · `formatVersion` 10 · builds on [1.0](../1.0/README.md), [1.1](../1.1/README.md), [1.2](../1.2/README.md)

The author decides how each piece of media is presented on the page: shown live, as a card to tap, or as a small
icon; what a tap opens; its label, icon and colour; whether it plays by itself. Before 1.3 the only choice was
`displayMode` (`full` or `icon`) and everything else was up to the reader, so the same book looked and behaved
differently from app to app.

What the book says is what the author **wants**. How it **looks** (icon artwork, colours of the theme, the card's
style) is the reader's, and a host app may restyle it (see §5). The book never carries CSS, scripts or icon
artwork, only names and values from fixed lists.

## 1. The `presentation` object

`image` and `embed` objects MAY carry `presentation`. Every field is optional; an absent field means the
default below, which is what 1.2 readers already did.

```json
{ "id": "m1", "type": "embed", "embed": "model3d", "x": 900, "y": 120, "width": 520, "height": 400,
  "assetId": "c1:…", "poster": "c1:…",
  "presentation": { "show": "live", "autoRotate": true, "label": "স্ক্রু গজ", "icon": "ruler", "accent": "#2f6f4e" } }
```

| Field | Type | Applies to | Default | Meaning |
|---|---|---|---|---|
| `show` | `card` · `live` | embeds, `displayMode` `full` | `card` | `card`: the poster with the icon, until tapped. `live`: the content itself as soon as its page is in view (the player, the turning model, the running lab) |
| `open` | `inline` · `popup` · `fullscreen` · `none` | images and embeds | embeds `full`: `inline`; `icon`: `popup`; images: `none` | What a tap on the card, icon or image does: play or run it where it is, in a dialog over the page, or full screen. `none` (images only): nothing, it is part of the page |
| `label` | string, 1–200 characters | both | the kind's name | The caption on a card; the accessible name of everything; shown next to an icon on hover or focus |
| `icon` | an icon name (§2) | both | the kind's icon | The icon on the card or marker |
| `accent` | `#rrggbb` | both | the reader's colour | The colour of the marker and the card's icon disc |
| `autoplay` | boolean | video | `false` | Starts by itself, without sound, while on screen. A tap then plays it as authored (with sound unless `muted`). Readers MUST NOT start sound the student did not ask for, so audio objects ignore `autoplay` |
| `loop` | boolean | video, audio | `false` | Starts again at the end |
| `muted` | boolean | video | `false` | Starts without sound |
| `autoRotate` | boolean | model3d | `false` | Turns slowly until touched |

Rules for readers:

- **`show: live` is a request, not a promise.** A reader MAY show the card instead: on a small screen, with
  data saving on, when the host turned live media off, or because another live object already runs (a reader
  SHOULD run at most one live 3D model or lab at a time). Tapping the card then does what `open` says.
- **`open: inline`** for an object too small to use on this screen (a reference reader threshold: 240 × 180
  screen px for a model, 440 × 260 for a lab) MAY open in a popup instead.
- **`open` on an icon** (`displayMode: icon`): `inline` means `popup`, since an icon has no room.
- **Unknown values** (a `show`, `open` or `icon` from a later version) mean the default. A reader MUST NOT
  refuse the book over them.
- **`label`** is the book's language, like its other text. Readers MUST NOT translate or alter it.
- **`accent`** is applied with a readable foreground: the reader picks light or dark ink by contrast. A host
  MAY ignore authors' accents to keep its own branding (§5).
- Snips are always icons and have no `presentation`.

## 2. Icon names

A fixed vocabulary, so a book can say *which* icon and every reader can draw its own version of it. Readers
MUST know all of them; a name they do not know (from a later list) means the kind's default icon.

| Group | Names |
|---|---|
| Media | `play`, `film`, `music`, `speaker`, `image`, `cube` |
| Science | `flask`, `atom`, `magnet`, `lightning`, `thermometer`, `drop`, `planet`, `globe`, `leaf`, `dna` |
| Maths and tools | `ruler`, `calculator`, `gear` |
| Notes | `info`, `question`, `lightbulb`, `star`, `eye`, `book` |

Kind defaults: video `play`, audio `music`, model3d `cube`, lab `flask`, image `image`, other plugins: a
package (no name; a reader's own).

## 3. Compatibility

- 1.0–1.2 readers open 1.3 books: `presentation` is an extra field. They draw every embed as a card, as before.
  A 1.2 reader keeps `presentation` on embeds when it saves (embeds are loose since 1.1) but drops it from
  images (1.0 images are not), so a book saved by an older app can lose image presentation. Authoring apps
  SHOULD be updated before teachers use image presentation.
- The 9 → 10 migration is the identity: nothing older has `presentation`.

## 4. Conformance

- `conformance/valid/presentation.chalk`: every field on every kind they apply to, an unknown icon and an
  unknown `show` value (both MUST be accepted and fall back to defaults).
- `conformance/invalid/presentation-accent.chalk`: an `accent` that is not `#rrggbb` (e.g. `url(…)`). Books
  carry colour values, never CSS.
- `conformance/invalid/presentation-label.chalk`: an empty `label`.

## 5. For hosts (informative)

The reference reader (`@chalk-fmt/reader`) lets a host app decide how presentation looks, without changing
what the author chose: its own icon for every name, colours per kind, defaults for objects whose author set
nothing, whether to honour authors' accents and `show: live`, and its own renderer for a kind. See the
reader's README.
