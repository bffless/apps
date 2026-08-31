# 01 — Workflow YAML reference

A workflow is one YAML file under `.bffless/workflows/` in an implementation repo. The shape is
deliberately GitHub-Actions-faithful: someone who reads Actions YAML should read this cold.
Where we deviate it is called out with **Deviation**. The machine-checkable form is
[`workflow.schema.json`](workflow.schema.json); this document is the prose.

```yaml
spec: 1                                   # optional, default 1
name: Long recording to published short   # required, shown in the UI
description: …                            # optional, markdown

on:
  manual:                                 # the only trigger in v1
    inputs:                               # the kickoff form — see 02 for types
      recordings: { type: file, accept: video/*, list: true, required: true, label: Recordings }
      target_length: { type: string, default: "8 minutes" }
      note_to_director: { type: string, format: textarea }

jobs:
  <job-id>: …                             # see Jobs

outputs:                                  # optional headline outputs of the run
  short: ${{ jobs.stitch.outputs.short }}
```

## Identifiers

`job-id`, step `id`, input/output names: `^[a-z][a-z0-9_-]*$`, unique within their scope.
**Deviation:** step `id` is **required** (GitHub makes it optional) — it keys run rows and the UI.

## Triggers — `on`

Only `on.manual` exists in v1 (mirrors `workflow_dispatch`). Its `inputs` map declares the
kickoff form; each entry is an *input definition* (02). A workflow with no inputs still has a
Start button. `on.schedule` / `on.webhook` are out of scope: the runner is a browser (07 covers
unattended runs).

## Jobs

```yaml
jobs:
  per-video:
    name: For each video                  # optional display name
    needs: [upload]                       # string | string[]; jobs without needs start at once
    if: ${{ inputs.recordings != null }}  # default success()
    strategy:
      matrix:
        video: ${{ inputs.recordings }}   # expression yielding a list, or a literal list
      max-parallel: 3                     # default: unlimited
      fail-fast: true                     # default true
    timeout-minutes: 30
    steps: [ … ]                          # sequential; at least one
    outputs:
      stored: ${{ steps.upload.outputs.path }}          # expression, type inferred
      transcript: ${{ steps.transcribe.outputs.words }}
```

Semantics, as GitHub unless noted:

- A job starts when every job in `needs` has **succeeded** (or per its `if` when that uses
  `always()` / `failure()`). Jobs with no `needs` start immediately and concurrently.
- `strategy.matrix` fans the job out: one *matrix item* per combination of the listed
  variables (single variable = one item per element). Inside: `matrix.<var>`,
  `strategy.job-index`, `strategy.job-total`. `include`/`exclude` are not in v1.
- **Deviation:** a matrix job's `outputs` **collect into lists**, in matrix order (GitHub
  keeps only the last writer). `needs.per-video.outputs.transcript` is therefore a list; a
  list-typed output of a matrix job becomes a list of lists (no implicit flattening).
- `fail-fast: true` cancels the job's remaining matrix items when one fails.
- Job `outputs` are the **only** cross-job channel (`needs.<job>.outputs.<name>`). Their
  type is inferred when the value is a direct reference to a typed step output (or an input /
  matrix variable); any other expression is typed `json` unless you declare the object form
  `{ type: …, value: "${{ … }}" }` (the linter suggests it).

## Steps

```yaml
steps:
  - id: transcribe                        # required
    name: Write the transcript            # optional
    uses: pipeline                        # pipeline | island | form | script  (03)
    if: ${{ … }}
    continue-on-error: false
    timeout-minutes: 15
    with: { path: transcribe, … }         # kind-specific (03); relative path → /api/<alias>/transcribe
    poll: { … }                           # pipeline only
    retry: { … }                          # pipeline only  — Deviation
    outputs:                              # typed map (02); see per-kind rules in 03
      words: { type: json, value: "${{ response.result.words }}", render: transcript }
    summary: |                            # markdown template, evaluated after the step
      Transcribed **${{ length(steps.transcribe.outputs.words) }}** words.
    annotations:
      - { level: warning, if: "${{ response.result.confidence < 0.9 }}", message: "Low confidence ${{ response.result.confidence }}" }
    headless: { mode: skip, outputs: { … } }   # island/form only (07)
    auto-accept: ${{ inputs.accept_cuts }}     # island/form only, needs headless: (07 "Per step")
```

- Steps run **in order**; a failed step fails the job unless `continue-on-error: true`
  (then `steps.<id>.outcome == 'failure'` but `conclusion == 'success'`, the job continues,
  and `success()` in later steps is still true — GitHub semantics; the job result is `success`).
- `steps.<id>.outputs.<name>` is readable by later steps of the **same job** only.
- `outputs` for a `pipeline` step is a typed map whose `value` expressions read `response`.
  If omitted, the step exposes `outputs.response` of type `json`. For `island`/`form`/`script`
  the map declares the **contract** the step must fulfil (no `value`; the step produces it) and
  the runner validates what comes back against it.
- `summary` and `annotations` are templates evaluated by the harness after the step reaches
  a terminal state; they never live inside pipeline responses (05).

## Paths — relative to the implementation

Everything an implementation ships is addressed **relative to its alias**, so the same YAML
works on `studio` and on a preview `studio-pr-12` without edits:

- `with.path: transcribe` (pipeline) → `/api/<alias>/transcribe`; `with.src: islands/cut-editor.html`
  (island/script, `render: island`) → `/w/<alias>/islands/cut-editor.html`.
- An **absolute** path (`/api/workflow/…`, `/api/other-impl/…`) is allowed and used verbatim —
  that is how a workflow calls harness pipelines. The linter warns on absolute paths into
  another implementation.
- `impl.api` / `impl.base` expose the resolved prefixes for the rare hand-built URL.

## Expressions — `${{ }}`

GitHub's grammar, as a subset, evaluated by one parser shared by the harness and the linter
(no `eval`):

- Literals: `null`, booleans, numbers, single-quoted strings. Property access `a.b`, index
  `a[0]`, `a['k']`, `a[expr]` (dynamic index, as GitHub). A missing property or out-of-range
  index evaluates to `null` — never throws (GitHub semantics); `null.x` is `null`. Operators `( ) ! == != < <= > >= && ||`. Comparison rules as GitHub
  (loose, case-insensitive strings).
- Functions: `contains`, `startsWith`, `endsWith`, `format`, `join`, `toJSON`, `fromJSON`;
  status functions `success()`, `failure()`, `always()`, `cancelled()` (valid in `if` only).
  **Deviations:** `length(x)` (list/string) — GitHub cannot count, summaries and `if`s need
  it; `pluck(list, 'key')` — projects a list of objects to a list of one property (the common
  case: a list of File refs → a list of paths for a pipeline body). Both are pure and tiny.
- A value that is **exactly** one expression keeps its type (object/list/number); anything
  else is string interpolation.
- Any YAML scalar may contain expressions; keys may not. **YAML gotcha (same as GitHub):**
  inside a flow mapping/sequence (`{ … }`, `[ … ]`) an expression must be quoted —
  `body: { id: "${{ response.jobId }}" }` — because `{{` opens a nested mapping. Block style
  needs no quotes. The linter reports the resulting parse error with this hint.

Contexts:

| context | available in | contents |
|---|---|---|
| `inputs` | everywhere | kickoff form values (files as `{path,name,contentType,size,url}`) |
| `needs` | job `if`, steps, job `outputs` | `needs.<job>.outputs.<name>`, `needs.<job>.result` |
| `steps` | steps after the referenced one (or the step itself in its own `summary`/`annotations` and a `markdown` output's `images` map, 02), job `outputs` | `steps.<id>.outputs.<name>`, `steps.<id>.outcome` (`success\|failure\|skipped\|cancelled`, the raw result), `steps.<id>.conclusion` (as `outcome`, but `success` when the failure was tolerated by `continue-on-error`), `steps.<id>.error`, `steps.<id>.response` (pipeline: `{ initial, last }`) |
| `matrix`, `strategy` | inside a matrix job | `matrix.<var>`, `strategy.job-index`, `strategy.job-total` |
| `response` | a pipeline step's `poll`, `retry`, `outputs`, `summary`, `annotations` | the **most recent** response of this step: the initial response when `poll.query/body` are evaluated, the latest poll response in `poll.until/fail`, the final one in `outputs` |
| `error` | a pipeline step's `retry.if`, `annotations`; any later step of the same job | `{ code, message, status }` — inside a step: its own last failure; in later steps: the **last failed step of this job** (prefer `steps.<id>.error` when you mean a specific one) |
| `step` | inside a step | `key` (`<job>/<index>/<id>`), `prefix` (`run.prefix` + `/<job>/<index>/<id>` — where this step's produced files go), `attempt` |
| `run` | everywhere | `id`, `prefix` (run storage prefix, 06), `started_by`, `started_at`, `headless` (bool) |
| `impl` | everywhere | `alias`, `base` (`/w/<alias>`), `api` (`/api/<alias>`) |
| `jobs` | top-level `outputs` only | `jobs.<id>.outputs.<name>`, `jobs.<id>.result` |

Upstream rule (linted and enforced at run time): `steps.<id>` may only reference a step that
appears earlier in the same job — or itself, inside its own `summary`/`annotations` (and a
`markdown` output's `images` map, which is read at the same time);
`needs.<job>` may only reference a job listed in `needs`. Outputs of a job that was skipped
(`if` false) or failed evaluate to `null`; top-level `outputs` referencing them are `null`.

## Control flow & failure

- `if` on a job or step: default `success()`. `always()` runs regardless; `failure()` runs
  only if a dependency failed; `cancelled()` if the run was cancelled.
- Job result: `success | failure | skipped | cancelled`. Run status: `running → succeeded |
  failed | cancelled`; a run **fails if any job failed** (after all reachable jobs finish).
- **Cancel** (UI button, headless SIGINT): in-flight polls stop, waiting interactive steps are
  torn down, no new steps start, run → `cancelled`. Server-side pipeline jobs already enqueued
  cannot be killed; the run gets an annotation saying so.
- `timeout-minutes` on job/step → the step fails with `error.code == 'TIMEOUT'`.
- **Deviation — `retry`** (pipeline steps only): re-runs the whole step (request + poll) on
  failure while `if` holds, at most `max` **extra** attempts (so `max: 3` = up to 4 runs),
  waiting `delay` between attempts; the UI shows "retry 1 of 3":
  ```yaml
  retry: { max: 3, delay: 5s, if: "${{ error.code == 'FFMPEG_BUSY' }}" }
  ```

Durations (`poll.every`, `poll.timeout`, `retry.delay`): `500ms`, `3s`, `10m`, `1h`.

## Not in v1

`env`, `defaults`, `concurrency` groups, `secrets` context (secrets never reach the browser),
`permissions`, reusable workflows (`uses: ./x.yaml`), `matrix.include/exclude`, `services`,
`container`, `on.schedule`, `on.webhook`.

## Worked examples

- [`examples/hello.workflow.yaml`](examples/hello.workflow.yaml) — the M1 test implementation.
- [`workflows/workflow-studio/.bffless/workflows/studio.workflow.yaml` in `bffless/workflow-implementations`](https://github.com/bffless/workflow-implementations/blob/main/workflows/workflow-studio/.bffless/workflows/studio.workflow.yaml) —
  the Studio port, every step kind exercised. Ships with its implementation rather than the
  spec's examples, so it's checked against a real rule set in that repo's CI.
