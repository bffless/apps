# Workflow

Workflow is a browser-driven workflow runner for BFFless, inspired by GitHub Actions: a generic
**harness** app renders and runs **workflows** declared in YAML by separate **implementation**
repos, dispatching the implementation's BFFless pipelines and pausing on custom UI where a
person is needed. This glossary is the vocabulary; the design is in `docs/spec/`.

## Language

### The parties

**Harness**:
The Workflow app itself, installed once per project. It owns the UI, the runner, run history,
run storage and the headless driver, and carries no workflow of its own.
_Avoid_: runner app, shell, host app, engine (for the app)

**Implementation**:
A separate repo deployed to its own alias inside the harness's project, shipping workflow
definitions, the pipelines they call, and any islands or scripts.
_Avoid_: workflow repo, plugin, extension, provider

**Project member**:
A BFFless user with any role on the project; the only kind of person who can start or view
runs.

### Definitions

**Workflow**:
One YAML file under an implementation's `.bffless/workflows/`: a name, a kickoff form and a
set of jobs. The unit a person picks to run.
_Avoid_: process, pipeline (that word is taken), app (when meaning the definition)

**Job**:
A unit of a workflow that starts once its `needs` are satisfied; jobs with no `needs` run
concurrently. A job may fan out over a matrix.
_Avoid_: stage, phase, group

**Matrix item**:
One instance of a fanned-out job, e.g. "per-video for take-2.mov". A matrix job's outputs
collect into lists, one element per item.
_Avoid_: iteration, shard, branch

**Step**:
One action inside a job; steps run in order. A step `uses` exactly one step kind.
_Avoid_: task, action, node (UI-only word)

**Step kind**:
What a step does: `pipeline` (call a BFFless rule), `island` (custom UI), `form` (built-in
schema form) or `script` (browser Worker). The closed set.
_Avoid_: step type, handler

**Kickoff form**:
The input form shown to start a run, generated from `on.manual.inputs`.
_Avoid_: start form, dispatch form, run settings, parameters

**Expression**:
A `${{ … }}` reference or computation evaluated by the harness against the run's contexts
(`inputs`, `needs`, `steps`, `matrix`, `response`, …).

### Values

**Payload**:
A typed value flowing between steps; its type is one of the closed vocabulary (`string`,
`number`, `boolean`, `choice`, `file`, `table`, `markdown`, `json`), optionally a list.
_Avoid_: artifact, data, result, blob

**File ref**:
The payload shape of a `file`: `{ path, name, contentType, size, url }`. Bytes never travel in
payloads; only refs do.
_Avoid_: file object, upload, attachment

**Renderer**:
The viewer or editor the harness picks for a payload from its type, overridable per
definition with `render` (e.g. `transcript`, `images`, `island`).
_Avoid_: widget, component, viewer (as the concept name)

**Run storage**:
The harness-owned storage area for a workflow: a per-workflow `inputs/` area for uploads
(reused across runs) and a per-run prefix for everything a run produces; pipelines read and
write paths, never choose prefixes.
_Avoid_: bucket, uploads folder

### Running

**Run**:
One execution of a workflow, started from the kickoff form in a browser and recorded
server-side step by step.
_Avoid_: execution, job (taken), session

**Run record**:
The server-side rows of a run (`workflow_runs` + one row per job/item/step) — the truth that
history, the run page and Resume are rebuilt from.
_Avoid_: log, history entry, event log (as the user-facing name)

**Resume**:
Continuing a run whose driving tab closed: finished steps are replayed from their rows,
in-flight pipeline steps re-poll, interactive steps re-prompt.
_Avoid_: restart, retry (taken), recover

**Lease**:
The claim the driving tab holds on a running run (heartbeat-renewed) so two tabs can't both
drive it; an expired lease is what makes Resume or Take-over offered.

**Summary**:
Markdown a step contributes to the run page, declared as a template on the step.
_Avoid_: attestation, report, note, annotation (different thing)

**Annotation**:
A levelled (notice / warning / error) message a step or the run pins to the run page.
_Avoid_: warning (as the concept), log line, summary

**Headless run**:
A run driven by a headless browser (Playwright) rather than a person; the same harness page,
auto-started by URL, with interactive steps skipped, auto-submitted, or failing fast.
_Avoid_: server-side run, CI run (as the concept), background run

**Island**:
A custom micro-UI shipped by an implementation as a self-contained HTML resource in the MCP
Apps format, rendered by the harness in a sandboxed iframe as a step or as an output viewer.
_Avoid_: widget, component, micro-app, plugin UI, iframe (as the concept)

**Script**:
An implementation's ES module the harness runs in a Worker as a step; the browser-CPU step
kind.
_Avoid_: task, function, worker (as the concept)

### Publishing

**Publish**:
Deploying an implementation to its alias with `.bffless/workflows/` + `index.json` in the
bundle and its rule set attached to both its alias and the harness alias. A deploy *is* the
publish; there is no registration.
_Avoid_: register, install (that's the harness), sync (the rules half only)

**Discovery**:
How the harness finds implementations: listing the project's aliases and probing each for
`/.bffless/workflows/index.json`.
