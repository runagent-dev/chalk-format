# Chalk 1.9: Printed marks and the page's own number

Status: draft · `formatVersion` 12 · builds on [1.0](../1.0/README.md) (pages, §3.2) and [1.4](../1.4/README.md) (streamed books, labels, the text file)

A book made from a printed one carries the printer's marks in its page pictures: page numbers, a forme line at the foot
of every sixteenth page ("ফর্মা-২, পদার্থবিজ্ঞান, ৯ম-১০ম শ্রেণি"), an edition year down the margin. Once pages are added,
removed or reordered, the printed numbers are wrong, and the other marks never meant anything to a reader. 1.9 lets a
page hide such marks and say where the reader writes the page's own number instead.

## 1. Terms

- **Hidden area:** a box of the page, in page units, that the reader paints over.
- **Number slot:** where on the page the reader writes the page's number.
- **Page number:** the page's `label` (1.4 §3) when the book gives one, else its position in the book counted from 1.

## 2. Hidden areas

A page (1.0 §3.2) may list `hidden`:

```json
"hidden": [
  { "x": 121, "y": 96, "width": 41, "height": 24, "fill": "#e3e8f4" },
  { "x": 118, "y": 1495, "width": 296, "height": 32, "fill": "#ffffff" }
]
```

| Field | | |
|---|---|---|
| `x`, `y` | required | The top left corner, page units |
| `width`, `height` | required | At least 0 |
| `fill` | required | The colour painted, a CSS colour: the paper's colour there |

A reader:

1. Paints each area with its `fill` above the background and below everything else on the page (text layer, objects,
   annotations), so the page's own content is never covered.
2. Leaves out of selection, copying and search every text layer run (1.0 §3.2) whose centre (`x + width / 2`,
   `y + fontSize / 2`) is inside an area.

A writer of a streamed book leaves those runs out of the text file (1.4 §4) too, so a search finds nothing a reader hides
before the page itself is loaded. The page file keeps its full text layer: removing an area brings the text back.

## 3. The number slot

A page may give a `numberSlot`:

```json
"numberSlot": { "x": 128, "y": 116, "fontSize": 22.6, "align": "start", "color": "#4d5861" }
```

| Field | | |
|---|---|---|
| `x` | required | Page units. Which part of the number it is depends on `align` |
| `y` | required | The number's baseline, page units |
| `fontSize` | required | Greater than 0 |
| `align` | required | `start`: `x` is the number's left end; `end`: its right end; `center`: its middle |
| `color` | optional | A CSS colour. Absent: the reader's choice of a quiet grey |

A reader writes the page number there, in the digits of the book's `locale` (Bengali digits for `bn`), in its text
font, above the hidden areas and below the text layer. The number is worked out when the page is drawn, never stored:
add, remove or move a page and every page after it shows its new number, the same number the reader shows for the page
in its own controls ("পৃষ্ঠা ১০০").

A page without a `numberSlot` shows no number (a chapter opener, a full-page picture).

## 4. Making them

Both are data a person or a tool writes. A tool for scanned books can find the marks from the text layer (a run of only
digits near the top or bottom edge is a page number; a run matching the publisher's pattern is a printer's line; digits
recorded narrower than they could be side by side are turned on their side) and take each box and colour from the page
picture: inside a window around the run, the commonest colour is the paper and pixels far from it are the ink. The
reference tool is `tools/chalk-marks.ts`.

## 5. Compatibility

`formatVersion` 12; the migration from 11 changes nothing (both fields are optional). A reader that does not know 1.9
shows the printed marks as before and numbers pages in its own controls by position.
