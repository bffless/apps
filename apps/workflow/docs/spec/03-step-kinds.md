# 03 — Step kinds

A step's `uses` selects one of four kinds. Everything in a run that *does* something is one of
these; there is no fifth. The runner treats each kind as an adapter with the same contract:
given evaluated `with`, produce `outputs` (validated against the step's declared map, 02) or
fail with `{ code, message, status? }`.

| kind | runs where | waits on | produces outputs from |
|---|---|---|---|
| `pipeline` | BFFless (server), called from the browser | HTTP + optional `poll` | `response` via `outputs` expressions |
| `island` | sandboxed iframe in the harness (04) | the user (or `headless: auto`) | `workflow.submit` |
| `form` | the harness | the user | submitted field values |
| `script` | a Worker in the harness | the module's promise | the module's return value |

## `pipeline`

Calls a proxy-rule endpoint **on the harness host**. `path` is **relative to the implementation**
(`transcribe` → `/api/<alias>/transcribe`, 01 *Paths*); an absolute `/api/workflow/...` reaches
harness-provided pipelines. Credentials are the user's session cookie (same-origin, 06);
the browser never holds secrets.

```yaml
- id: transcribe
  uses: pipeline
  with:
    path: transcribe                       # relative → /api/<alias>/transcribe; absolute /api/… allowed
    method: POST                           # default POST; GET sends `query` only
    query: { }                             # URL query, values may be expressions
    body: { audioPath: "${{ steps.audio.outputs.wav.path }}", diarize: true }
    headers: { }                           # rarely needed; Content-Type is JSON by default
  poll:
    path: job
    query: { id: "${{ response.jobId }}" }   # `response` here = the initial response
    until: ${{ response.status == 'done' }}
    fail:  ${{ response.status == 'error' }}
    every: 3s
    timeout: 15m
  retry: { max: 3, delay: 5s, if: "${{ error.code == 'FFMPEG_BUSY' }}" }
  outputs:
    words: { type: json, value: "${{ response.result.words }}", render: transcript }
```

Rules:

- **Body size.** Edge nginx caps request bodies at 1 MB; bodies carry paths and JSON, never
  file bytes (06). Pass `ref.path` for one file and `pluck(list, 'path')` for a list; the
  linter warns when a whole File ref (or list of refs) is placed in a `body`.
- **Success** = 2xx and JSON (or empty) body. Non-2xx → failure with `error.status` and
  `error.code` from the body's `code`/`error` field when present; network failure →
  `NETWORK`. Non-JSON 2xx → the raw text is exposed as `response` (string).
- **`poll`** starts after a successful initial response. Each tick evaluates `fail` then
  `until` against the tick's response. `timeout` → `error.code == 'POLL_TIMEOUT'`. The
  initial response stays readable as `steps.<id>.response.initial`; `response` in `outputs`
  is the final (last poll) response.
- **`retry`** re-runs the whole step (request + poll) after `delay`, at most `max` **extra**
  times (`max: 3` ⇒ up to 4 runs), while `if` holds (default: any failure). Each attempt is
  recorded on the run row (`attempt` counter) so the UI can show "retry 1 of 3".
- **Cancel** aborts the in-flight fetch and stops polling; enqueued server jobs keep running
  (annotated on the run, 01).
- **`outputs` omitted** → `outputs.response` (type `json`) — handy for a quick first pass,
  discouraged in shipped workflows (the linter warns).

Studio's async pattern (`enqueue → {jobId} → poll /api/studio/job`) is the canonical use of
`poll`; synchronous pipelines just omit it.

## `island`

A custom micro-UI the implementation ships as a self-contained HTML file in the **MCP Apps**
format; the harness renders it in a sandboxed iframe and speaks the MCP Apps JSON-RPC dialect
to it. The step is `waiting` until the island calls `workflow.submit` with outputs matching
the declared map. Full contract in [04-islands.md](04-islands.md).

```yaml
- id: trim
  uses: island
  with:
    src: islands/cut-editor.html             # relative → /w/<alias>/islands/cut-editor.html
    title: Trim to the screen
    display: inline                          # inline (default) | fullscreen — see 04 "Display modes"
    clip: ${{ steps.cut.outputs.clip }}      # every other key is delivered as tool-input arguments
    words: ${{ needs.per-video.outputs.words[strategy.job-index] }}
  outputs:
    spans: { type: json, schema: { type: array, items: { type: object, required: [start, end] } } }
  headless: { mode: auto }                   # or skip + outputs; none → fails fast headless (07)
```

- The island can call pipelines through the bridge (`tools/call` → `/api/<impl>/...`,
  same-origin, same session) — it has no cookies or network of its own.
- Islands may also **render outputs** read-only (`render: island`, 02); same file format,
  the harness passes `{ value }` and never expects a submit.

## `form`

The built-in schema-driven form, the same renderer as the kickoff form, used mid-run.

```yaml
- id: pick-cover
  uses: form
  with:
    title: Pick a cover
    description: Four covers were drawn from the brief. Pick one or edit the brief and redraw.
    fields:
      cover: { type: choice, options: "${{ steps.draw.outputs.covers }}", required: true }
      brief: { type: markdown, default: "${{ steps.brief.outputs.prompt }}" }
    submit: Use this cover
  headless: { mode: skip, outputs: { cover: "${{ steps.draw.outputs.covers[0].path }}" } }
```

Outputs **are** the field values, typed by their definitions (no separate `outputs` map on a
`form` step). A `choice` over File refs outputs the chosen **ref**, not its path (02). `default` values may be expressions — that is how an upstream output becomes an
editable field.

## `script`

An ES module from the implementation, executed **in a Worker** in the harness page. The *page*
fetches it (same-origin via `/w/<impl>/...`, so the member's session reaches the private
bundle) and hands the text to the sandbox, which spawns the Worker; see the opaque-origin
bullet below for why it is never a plain `new Worker(url, {type: 'module'})`. This is
GitHub's `run:`; it exists because real work happens client-side (Studio's contact sheets,
filmstrips, blog-bundle zip, ffmpeg.wasm).

```yaml
- id: bundle
  uses: script
  with:
    src: scripts/blog-bundle.js              # relative → /w/<alias>/scripts/blog-bundle.js
    markdown: ${{ steps.write.outputs.post }}
  outputs:
    zip: { type: file }
```

Module contract (`@bffless/workflow-script` types, zero runtime):

```ts
export default async function run(ctx: {
  inputs: Record<string, unknown>;          // `with` minus `src`, evaluated; File refs as-is
  files: { fetch(ref: FileRef): Promise<Response> };   // same-origin GET of ref.url
  log(msg: string): void;                   // shows in the step card
  annotate(a: { level; message; title? } | { summary: string }): void;
  signal: AbortSignal;                      // cancel / timeout
}): Promise<Record<string, unknown>>;       // outputs; Blob/File values where a `file` is declared
```

- A returned `Blob` for a `file` output is stored by the runner under `step.prefix` (06) and
  becomes a File ref — scripts never do uploads themselves.
- Every declared output must be present in the return value, but "present" is not "truthy": a
  missing key or an explicit `undefined` is refused, while `''`, `null`, `0`, `false`, and `[]`
  are all accepted answers (unlike a `form`/`island` field's `required`).
- `files.fetch` only accepts the harness's file-serve urls (`/api/uploads/…`) — a script,
  like an island, cannot reach other routes.
- The Worker has an **opaque origin** (spawned from `data:` URLs inside a sandboxed iframe,
  the same sandbox islands get): no cookies, a relative `fetch` throws, an absolute one is
  refused by CORS — `ctx.files.fetch` is the only way to bytes. COOP/COEP stays undecided;
  nothing in M3 needs threads.
- Failure = rejected promise (`error.code` from `err.code` or `SCRIPT`), or `timeout-minutes`.

## Choosing

- Calls a BFFless rule? `pipeline`. Needs a person with custom UI? `island`. Needs a person
  with plain fields? `form`. Needs the browser's CPU? `script`.
- Uploading a file is **not** a step: it is the `file` type's control on the kickoff form or a
  `form`, or a `script` returning a Blob.
