# 05 — Runs and persistence

The runner is the browser; the **record** of a run is server-side, written through harness
pipelines on every transition. That is what makes "Past runs" real, lets anyone on the
project open a run somebody else started, and makes **Resume** possible after the driving tab
goes away.

## Tables (harness rule set, BFFless Data Tables)

`workflow_runs`

| column | notes |
|---|---|
| `id` | `run_<ulid>` |
| `impl`, `workflow` | alias of the implementation; workflow file name (`long-to-short`) |
| `workflow_name` | the YAML `name` at start |
| `workflow_version` | the implementation deployment id + commit sha the alias pointed at when the run started |
| `definition` | **parsed** definition (JSON) snapshotted at start — the run page, Resume and the linter-at-runtime read this, never the alias (D16) |
| `yaml` | the YAML text, for "View workflow file" on the run page |
| `inputs` | kickoff values (File refs, not bytes) |
| `status` | `running \| succeeded \| failed \| cancelled` |
| `headless` | bool |
| `started_by`, `started_at`, `finished_at` | |
| `lease_owner`, `lease_until` | the tab currently driving the run; heartbeat every 15 s sets `lease_until = now + 60 s` (see Resume) |
| `outputs` | top-level `outputs` map, filled at completion |
| `annotations` | run-level annotations (cancel notice, headless fail-fast, …) |

`workflow_run_steps` — one row per (job, matrix index, step); **the step key is
`<job>/<index>/<step>`** (index `0` for non-matrix jobs).

| column | notes |
|---|---|
| `id`, `run_id`, `key` | |
| `job`, `index`, `step`, `kind` | denormalised for listing |
| `status` | `queued \| running \| polling \| waiting \| succeeded \| failed \| skipped \| cancelled` |
| `attempt` | retry counter, 1-based |
| `inputs` | evaluated `with` (File refs, expressions resolved) — what the Input pane shows |
| `response` | pipeline: `{ initial, last }`; trimmed to 256 KB with a `truncated` flag |
| `outputs` | validated, typed outputs — what the Output pane shows |
| `error` | `{ code, message, status? }` |
| `summary` | rendered markdown (template already evaluated) |
| `annotations` | `[{ level, title?, message }]` |
| `started_at`, `finished_at`, `heartbeat_at` | |

Job-level state is **derived** (a job is the fold of its step rows + the definition); it is
not stored, which keeps the write path to one table per transition.

Payloads are inline JSON; files are always refs (06), so rows stay small. A `table`/`json`
output over 1 MB is stored as a file under the step's prefix and the row holds
`{ "$file": <File ref> }` in place of the value — renderers (and expressions) fetch it
transparently.

## The write path

The engine (09) produces events; every event is persisted as **one row write** before the
engine proceeds (write-ahead: a transition that fails to persist is retried, then the run is
paused with an error banner rather than continuing unrecorded).

| event | persisted as |
|---|---|
| `run.started` | insert `workflow_runs` (status `running`, lease set) |
| `step.queued` / `step.started` / `step.polling` / `step.waiting` | upsert step row status (+ `inputs` on start) |
| `step.succeeded` | row: status, `outputs`, `response`, `summary`, `annotations`, `finished_at` |
| `step.failed` / `step.skipped` / `step.cancelled` | row: status, `error`, `finished_at` |
| `step.retrying` | row: `attempt++`, status `queued` |
| `run.heartbeat` | `workflow_runs.lease_until`, active rows' `heartbeat_at` (every 15 s) |
| `run.finished` | `workflow_runs.status`, `outputs`, `finished_at`, lease cleared |

Harness pipelines (paths are examples; ids go in query/body because path segments are not
readable in pipeline expressions):

- `POST /api/workflow/runs` create · `GET /api/workflow/runs?impl=&workflow=&status=&limit=&before=` list
- `GET /api/workflow/run?id=` run + all step rows · `PATCH /api/workflow/run` `{ id, patch }`
- `PUT /api/workflow/run-step` `{ runId, key, patch }` upsert · `POST /api/workflow/run/cancel` `{ id }`
- `POST /api/workflow/run/lease` `{ id, owner, takeover? }` — acquire/heartbeat/release

All `auth_required`; rows carry the project; members read everything (06 access).

## Resume

A run stays `running` when its tab closes; nothing server-side notices. When someone opens it:

1. Rows load; the engine **replays** them into run state (`rows → state` is the same reducer
   the live run uses, 09). Completed steps are shown with their recorded outputs.
2. If the lease is held by a live owner (`lease_until` in the future — i.e. a heartbeat within
   the last 60 s) the page is **read-only live view** (it polls the rows) with "Take over"
   behind a confirm.
3. Otherwise **Resume** is offered. On resume: `queued`/`running` pipeline steps restart
   their request (idempotency is the pipeline's business — Studio's enqueue pattern is safe to
   re-enqueue; the definition can mark a step `resume: poll-only` … *open: decide at M1 with
   the hello implementation whether a `resume:` hint is needed*); `polling` steps resume polling
   with their recorded `response.initial`; `waiting` steps re-mount the island/form;
   `succeeded` rows are not re-run.
4. The heartbeat restarts; `lease_owner` becomes this tab.

Headless runs never resume (a failed CI step re-runs the workflow).

## Summaries and annotations

Both are **declared in YAML** on the step (`summary:` markdown template, `annotations:` list
of `{ level, if, title, message }`), evaluated by the harness after the step reaches a
terminal state, and stored on the step row. Islands and scripts can add to them dynamically
via `workflow/annotate` (04) / `ctx.annotate` (03) — appended to the same columns. Run-level
annotations (cancel notice, headless fail-fast) live on `workflow_runs.annotations`.

The run page shows: a badge count per level in the header, each step's summary in its card,
and a **Run summary** section concatenating step summaries in job order (GitHub's job summary
page). Summaries are markdown; HTML is not interpreted (rich output → `render: island`, 02).

## Completion and outputs

When no job can start and none is active: `succeeded` if all jobs succeeded or were skipped
by `if`; `failed` if any job failed; `cancelled` if cancelled. Top-level `outputs` are
evaluated and stored; the run page lists them first, then every job's outputs, each with its
renderer and — for files — Download.

## Retention & deletion

Deleting a run deletes its rows and its **run prefix** (`workflows/<impl>/<workflow>/runs/<run>/`,
06); kickoff inputs live outside the run prefix and are kept (other runs / Re-run may reference
them) unless "also delete its uploaded inputs" is ticked and no other run references them.
Owner or admin only. No automatic retention in v1 (a `keep: 30d` per workflow is a follow-up).

## Not in v1

Attestations (a signed digest of the record — the schema above is sufficient for adding it),
live multi-viewer presence, run comparison/diff, re-run single job (run again from the kickoff
form with the same inputs **is** v1: "Re-run" copies `inputs`).
