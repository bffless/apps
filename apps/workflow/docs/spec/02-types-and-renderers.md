# 02 — Types and renderers

One closed vocabulary describes **every** value that flows through a workflow: kickoff-form
inputs, `form` step fields, step outputs, job outputs, run outputs. The same definition
object is an input control on one side and a viewer on the other, so an output can be wired
straight into a later `form` as a pre-filled, editable field with no mapping.

Two ideas are kept apart: the **type** says what the value *is* (and how it validates); the
**renderer** says how it is *shown or edited*. The renderer is chosen from the type and can
be overridden per definition with `render:`.

## The vocabulary

| `type` | value | form control | default viewer | extra keys |
|---|---|---|---|---|
| `string` | string | text field (`format: textarea` → multiline; `url`, `email`, `date`, `datetime`, `password`) | plain text (url → link); `format: path` → basename, full path on hover, Copy | `format`, `pattern`, `minLength`, `maxLength` |
| `number` | number | number field | number; `format: seconds` → `m:ss.s` | `format`, `min`, `max`, `step` |
| `boolean` | boolean | toggle | ✓ / ✗ | — |
| `choice` | string (or string[] with `list: true`) | select / radio (`list: true` → checkboxes); options with `preview` render as a tile picker | chip(s) | `options: [a, {value, label, preview?}]` — `options` may be an expression; a list of File refs is shorthand for `{value: path, label: name, preview: ref}` — a tile is picked by its ref's `path`, and the field's **output is the ref itself**, so the file's name, size, content type and url survive downstream |
| `file` | **File ref** `{ path, name, contentType, size, url }` | upload control (prepare → PUT → register, 06); an `image/*` upload shows a thumbnail beside its name, a `video/*` / `audio/*` upload an inline player (`controls`, `preload="metadata"`, never autoplaying — the local file while uploading, the ref's serve url once registered) with its duration beside name and size; `list: true` collapses each player behind a Play control | viewer by `contentType`: `video/*` player, `audio/*` player (both with duration), `image/*` image, `application/pdf` PDF, else download card; **always** a Download action | `accept`, `maxSize` |
| `table` | `{ columns: [{key,label?,type?}], rows: object[] }` | editable grid | table | `columns` |
| `markdown` | string | markdown editor with preview | rendered markdown | `images` (outputs only) |
| `json` | any JSON | schema-driven form (from `schema`) or JSON editor | by **shape** (below), else JSON tree; `format: table` (+ `columns`), `list`, `seconds` | `schema` (JSON Schema), `render`, `mapping`, `format`, `columns` |

`list: true` on any definition makes the value a **list** of that type (`file` + `list` is
the multi-upload, `choice` + `list` is multi-select; a matrix job's outputs collect into lists
automatically, 01). There is no separate `multiple` key.

Common keys on every definition: `label`, `description`, `list`, `render`; inputs add
`required`, `default`.

**Chip or block.** The plain-text viewer (`string`, `choice`, a bare path under `file`) draws
a value as a **chip** — a small pill — unless it is long: `format: textarea` declared, a
newline in the value, or more than **120 characters**. Any one of those makes it a **block**
(pre-wrapped, card corners, same mono face). `number` and `boolean` are always chips. The
rule is applied per item under `list: true`, so a list of prompts is a column of blocks and a
list of tags a row of chips.

## Inferred shapes

The JSON tree can show anything, so it stays the fallback for every value — but it is the
**drill-in**, not the first thing a person sees. A `json` value with no `render` is first
read for its *shape*, and so is every node inside the tree, so a shaped value nested three
levels down in a step's `body` still gets its viewer under its key. The harness recognises
**shapes**, never subjects: nothing here knows what a scene, a cut or a clip is.

| shape | recognised as | shown as |
|---|---|---|
| a File ref, or an array of nothing but File refs | the harness's own `{ path, name, url, … }` (06) | file card(s), exactly as `type: file` (+ `list`) renders |
| an array of **homogeneous flat rows** | every item a plain object with the *same* keys, every value a scalar (null, boolean, number, or a string that would be a chip), at most **8** keys | a table: columns in the first row's key order; numbers right-aligned to a sensible precision (two decimals, trailing zeros dropped); the exact value on hover; 40 rows, then "show all" |
| an array of numbers, or of chip-length strings | — | a compact inline list `1.68, 5.03, 8.39 … (120)` — chips for strings — 12 items, the count, "show all" |
| a **storage path** | a string with no whitespace and no scheme, at least 3 `/`-separated segments and 32 characters (06's own paths always are) | the basename, the full path on hover, a Copy |

A value that matches none of these — a ragged array, a mixed list, an object — renders as it
always did, and so does a declared `type: table`, whose cells print as they are. Inference is strict on purpose (a viewer must never hide part of a value); the
declared formats below are lenient.

**Times in a table.** A numeric cell whose column *name* says it is a time in seconds — its
last word is `start`, `end`, `duration`, `offset` or `time` (`startTime`, `clip_end`), or a
seconds unit after another word (`start_s`, `durationSec`), or `seconds` — is shown as
`m:ss.s` (`0:08.5`, `2:05.3`, `1:02:05.3`), with the raw number on hover. That is the one
thing a key name is read for. `list: true` on any type folds past 24 items the same way.

### Declared formats

Where inference cannot know, the declaration can say. All optional; each is read by one
type's viewer and is a lint error (`format-type`) anywhere else:

| `format` | on | shows |
|---|---|---|
| `table` | `json` | a table over an array of objects however ragged — columns from `columns: [start, end]` / `[{key, label?}]` when given, else the union of every row's keys |
| `list` | `json` | a compact inline list over any array of scalars, mixed kinds included |
| `seconds` | `number`, `json` | `m:ss.s` — on `json`, every number in the value (a list of times, a table's cells) |
| `path` | `string` | basename + Copy, whatever the string's length |

```yaml
outputs:
  cuts:   { type: json, value: "${{ response.result.cuts }}", format: table, columns: [start, end] }
  times:  { type: json, value: "${{ response.result.times }}", format: list }
  source: { type: string, value: "${{ response.result.source }}", format: path }
  at:     { type: number, value: "${{ response.result.at }}", format: seconds }
```

### Raw, one click away

Every value that is *drawn* rather than printed — a declared renderer, a table, markdown, a
file, an inferred shape, a formatted number — carries a `json` flip to the raw JSON its row
holds, and back. The run, job and step panes also carry a pane-level **Show raw** that makes
every value on every tab the raw tree at once; it is one switch for the browser, remembered
in local storage, and a value's own flip still overrides it either way.

Every definition compiles to one JSON Schema; validation (kickoff form, `form` submit, island
`workflow.submit`, script return, pipeline `outputs` coercion) is one function over that
schema. A pipeline `outputs` value that does not match its declared type fails the step with
`error.code == 'OUTPUT_TYPE'` — better to fail at the step than render garbage downstream.

### The File ref

```json
{ "path": "workflows/studio/long-to-short/run_01J…/per-video/0/upload/take-2.mov",
  "name": "take-2.mov", "contentType": "video/quicktime", "size": 3328599040,
  "url": "/api/uploads/workflows/studio/…/take-2.mov" }
```

`path` is the storage key (what pipelines take and return); `url` is the same-origin
serve route the harness mints (06). Pipelines may return a bare `path` string where a `file`
is declared — the runner registers it and fills the rest. Files never travel as bytes inside
step payloads; scripts return `Blob`s which the runner stores (03).

### Image maps on `markdown`

A `markdown` **output** (step, job or top level) may declare `images`: a map from each
image `src` *exactly as it appears in the markdown* to the uploads-relative path (or File
ref, whose `path` is used) the harness should draw it from. It is an expression or a
literal map, evaluated by the harness once the step is done — at the step's own
`summary` site, so the step's own outputs are visible and `response` is not — and the
viewer rewrites every `![alt](src)` whose `src` is a key to the same-origin serve url
`/api/uploads/<path>`, with the alt as its caption. Any other `src` renders as it would
without the map. A value that does not name a file under the serve route is dropped, not
drawn.

```yaml
outputs:
  post: { type: markdown, images: "${{ steps.frames.outputs.srcs }}" }   # { "frame:78": "workflows/…/frame-01.jpg" }
```

The keys are opaque to the harness — a placeholder token a writer step invents, a
relative path an archive uses — so a workflow's own steps decide what the markdown
says and what each src maps to, and the Output tab shows the images either way while the
markdown itself stays what a later step needs. `images` on any other type is a lint error.

## Renderers

| `render` | applies to | shows |
|---|---|---|
| (default) | any | the default viewer from the table above |
| `transcript` | `json` shaped `[{ text, start, end, speaker? }]` (a bare word/segment list — Studio's `words`) | time-coded transcript viewer (click → seek the nearest `file` video in the same step if present) |
| `chart` | `json`/`table` + `mapping: { x, y, kind: bar\|line }` | small chart |
| `images` | `file` list of images | grid of tiles |
| `code` | `string` + `mapping: { language }` | highlighted code |
| `island` | any | a custom viewer: `src: /w/<impl>/islands/x.html`, rendered read-only through the island contract (04) with the value delivered as `tool-input.arguments.value` |

Unknown `render` values are a lint error, not a runtime fallback.

## Examples

```yaml
on:
  manual:
    inputs:
      recordings:   { type: file, accept: "video/*", list: true, required: true, label: Recordings }
      length:       { type: choice, options: [{value: short, label: "≈ 3 min"}, {value: medium, label: "≈ 8 min"}], default: medium }
      direction:    { type: string, format: textarea, label: Note to the director }
      write_blog:   { type: boolean, default: true }

# a pipeline step's outputs
outputs:
  words:      { type: json, value: "${{ response.result.words }}", render: transcript }
  chapters:   { type: table, value: "${{ response.result.scenes }}", columns: [{key: title}, {key: start, type: number}, {key: end, type: number}] }
  clip:       { type: file, value: "${{ response.result.clipPath }}" }      # bare path → File ref
  post:       { type: markdown, value: "${{ response.result.markdown }}" }

# an island step's contract
outputs:
  spans:      { type: json, schema: { type: array, items: { type: object, required: [start, end] } } }

# a custom output viewer
outputs:
  cuts:       { type: json, render: island, src: islands/cut-viewer.html }   # relative → /w/<alias>/islands/…
```

## Out of scope (v1)

Custom *types* (the vocabulary is closed on purpose — extend with `json` + `schema` +
`render`), binary values inline, streaming values, references between values (`$ref`).
