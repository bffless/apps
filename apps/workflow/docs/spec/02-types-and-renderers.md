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
| `string` | string | text field (`format: textarea` → multiline; `url`, `email`, `date`, `datetime`, `password`) | plain text (url → link) | `format`, `pattern`, `minLength`, `maxLength` |
| `number` | number | number field | number | `min`, `max`, `step` |
| `boolean` | boolean | toggle | ✓ / ✗ | — |
| `choice` | string (or string[] with `list: true`) | select / radio (`list: true` → checkboxes); options with `preview` render as a tile picker | chip(s) | `options: [a, {value, label, preview?}]` — `options` may be an expression; a list of File refs is shorthand for `{value: path, label: name, preview: ref}` — a tile is picked by its ref's `path`, and the field's **output is the ref itself**, so the file's name, size, content type and url survive downstream |
| `file` | **File ref** `{ path, name, contentType, size, url }` | upload control (prepare → PUT → register, 06); an `image/*` upload shows a thumbnail beside its name | viewer by `contentType`: `video/*` player, `audio/*` player, `image/*` image, `application/pdf` PDF, else download card; **always** a Download action | `accept`, `maxSize` |
| `table` | `{ columns: [{key,label?,type?}], rows: object[] }` | editable grid | table | `columns` |
| `markdown` | string | markdown editor with preview | rendered markdown | — |
| `json` | any JSON | schema-driven form (from `schema`) or JSON editor | JSON tree | `schema` (JSON Schema), `render`, `mapping` |

`list: true` on any definition makes the value a **list** of that type (`file` + `list` is
the multi-upload, `choice` + `list` is multi-select; a matrix job's outputs collect into lists
automatically, 01). There is no separate `multiple` key.

Common keys on every definition: `label`, `description`, `list`, `render`; inputs add
`required`, `default`.

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
