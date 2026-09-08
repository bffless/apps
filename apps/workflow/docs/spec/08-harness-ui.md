# 08 — Harness UI

What the harness shows, derived from the Claude Design prototype ("Long recording to published
short": 14 cards, loop groups, per-step Input/Output panes with typed renderers, Past runs,
Start a run). This is the information architecture; the visual design landed with the
2026-08-26 `/impeccable` pass (`PRODUCT.md`, `DESIGN.md`, `src/index.css`), matched to the
prototype's "Workflow Graph A" artboard.

## Routes

| route | screen |
|---|---|
| `/` | **Implementations** — every alias that answered discovery (06), with name, version, workflow count, preview badge, last run; invalid `index.json` shown with its error |
| `/<impl>` | **Workflows** of one implementation — list with description, inputs count, jobs count, headless-safe, last run status |
| `/<impl>/<workflow>` | **Workflow** — the graph (below) in *definition* mode + "Start a run" + recent runs |
| `/<impl>/<workflow>/run` | **Kickoff** — the form from `on.manual.inputs`; Start creates the run and navigates to it. `?from=<runId>` prefills it for Re-run; `?auto=1&inputs=<base64url(JSON)>` is the headless entry (07) — no form at all, a `kickoff-auto` notice while the run starts, or a `kickoff-invalid` list of the values it refused |
| `/<impl>/<workflow>/runs` | **Past runs** — table: status (a running run parked on a step says "waiting on <step>" beside its pill, linked to that step), started by/at, duration, annotations count, outputs summary; filter by status; Re-run |
| `/<impl>/<workflow>/runs/<runId>` | **Summary** — the graph in *run* mode + the run's inputs, results, summary and annotations |
| `/<impl>/<workflow>/runs/<runId>/job/<job>` | **Job page** — the job head, the job's Input/Output disclosure, the step rows; `?step=<key>` names the row that is open. A matrix job with no index is the **collect view**: the collected outputs and one link per item |
| `/<impl>/<workflow>/runs/<runId>/job/<job>/<index>` | **Matrix item** — the same page for one leg of a matrix job |
| `/<impl>/<workflow>/file` | **View workflow file** — YAML with lint results (also linked from a run: the snapshot) |

The left rail is the implementation → workflow tree; the header shows the project and user.

## The graph

One view, two modes, same layout — **one node per job** (2026-09-08 redesign, Task 8): a job's
steps are the job page's list now, not the graph's, so a node says only what a person choosing
between jobs needs.

- **Nodes** = jobs, one each in both modes — a matrix job is still one node (no item selector on
  the graph; items live in the run rail), never N. Node order/layout is derived from `needs`
  (topological, left→right via `topoLayers`), not hand-placed; each node's height comes from the
  definition alone (`cardHeight`), so the graph never grows or reflows as a run fans out.
- **Run mode**: each node's status line carries the folded status glyph and word (`queued
  running polling waiting succeeded failed skipped cancelled`), a mono duration, and — for a
  matrix job — `N of M done` in place of the status word. A matrix job also carries a `MATRIX ·
  <id>` eyebrow over the name and a note line with the strategy ("For each who · max 2 at
  once"). The header shows elapsed, "7 of 14 done", Cancel, Resume/Take-over when applicable.
- **Definition mode** (`/<impl>/<workflow>`): the status line is instead the job's step count
  (`N steps`), and the card adds one `OUT name · type` line per output the job declares.
  Clicking a node opens the job's declaration (its raw block) in a side panel; run mode reports
  the click to the run page instead, which has the evaluated inputs/outputs to show.
- **Edges** = `needs` (structural) and **data-flow** edges derived from expressions
  (`needs.x.outputs.y`, `steps.x.outputs.y`), read at job granularity: hovering a payload chip
  highlights the job it came from (a solid ring) and every job that reads it (a dashed outline),
  even though the chip itself lives in a step row's body, off the graph.
- **Edge dots** are unchanged: the two dots on a node's edges are "jump straight to one side" —
  the left one opens the job on Input (what it waited on), the right one on Output (what it
  hands on).

## The job page

A job is its own page (2026-09-08 redesign) — `/job/<job>[/<index>]`, `job-page[data-job]`,
GitHub's job screen. A head saying which job this is, the job's own values behind a
disclosure, and the job's steps as **rows that expand in place**: there is no step route and
no step card any more, so the page around an open step never goes away.

1. **Job head** (`job-head`): the eyebrow `RUN › JOB` (`› ITEM` on a matrix leg) — `Run` is
   the one climb out of a job, the rail's Summary row being the other — the job's label, its
   id in mono, the status pill, the duration, the matrix note when there is one, and on a leg
   `item i+1 of N`. On the right, the two actions that belong to the job rather than to any
   one step: **Re-run from this job** (`job-fork`) and **YAML** on the job block. The fork is
   05's: a new run under the current definition, this job and everything downstream of it run
   again, every other job copied from this run — offered only on a terminal run this tab is
   not driving, and only for a job whose upstream all ended `success`/`skipped`.
2. **Job inputs and outputs** (`job-io`): a collapsed disclosure holding the **Input |
   Output** toggle and **Show raw**. *Input* is what the job waited on — each `needs` job's
   evaluated outputs, and on a matrix leg its **matrix bindings** as the first entries;
   *Output* is the job's own declared `outputs:` **evaluated** (aliases over step outputs; a
   matrix job's collect into lists), with `goes to …` chips. Job outputs are derived, never
   persisted (05) — this is the one place they are shown. An edge dot opens the page with the
   disclosure already open on its side (`?tab=`), and it stays open underneath a row the
   person then expands.
3. **Steps** (`job-steps`): the step rows, below.

A **matrix collect view** (`/job/<matrix>`, no index) is the same page with `MATRIX · N ITEMS`
as its kind, the *collected* outputs in the disclosure, and — instead of step rows — an
**Items** list (`job-items`): one row per item (glyph, item label, `item i+1`, duration), each
a link to that item's page. Deliberately no rows: 2 items × 3 steps is a list whose rows say
nothing about which leg they belong to, and the item links are the answer to that question.

## Step rows

One row per step of the job (or item), in declaration order. The row **head** is the clickable
unit and the anchor of the headless contract (07) — `step`, `data-key`, `data-state` — which
the graph's step chip used to carry; the graph draws jobs only now, so the row inherits it
verbatim, names and all.

- **Head** (a `<button aria-expanded>`): status glyph · label (+ the id in mono when they
  differ) · kind · `attempt n` when > 1 · a mono duration or status word · chevron. A row the
  run has not reached has nothing to open — its head is `disabled`.
- **Body** (`step-pane`, rendered only while the row is expanded): a `step-toolbar` — the
  **Input | Output** segmented toggle, **Show raw**, **YAML**, the status pill, the kind —
  over the values. It carries no crumb, no name and no key of its own: the row above it
  already says which step this is.
  - **Input** — the evaluated `with` (File refs as file cards, expressions resolved to
    values), each chip labelled "from `<job>/<step>`" when it came from a data-flow edge. A
    `form` step records its evaluated `with` too (title, fields with `default`/`options`
    resolved, submit) — on `step.waiting`, since a form never emits `step.started`; what the
    person typed is its *Output*.
  - **Output** — each declared output with its renderer (02): table, transcript, markdown,
    file viewers with Download, JSON tree, `render: island` viewer; chips labelled "goes to
    …". Every value that is *drawn* rather than printed carries a `json` flip to the raw value
    the row holds (and back), so a chart or a table can always be read as its exact data; a
    bare `json` value is read for its shape first (02 "Inferred shapes") and the tree is the
    drill-in. **Show raw** flips every value on both sides to the raw tree, remembered per
    browser. The audit trail rides here too (the separate Details tab was folded in on
    2026-08-26): started / finished / took, attempt, kind, the pipeline path, the error
    (`code`, message; the raw response behind a disclosure), the step's `summary` rendered,
    its annotations, and a live script's log.
  - **YAML** — the third control in the toolbar opens the workflow source **in place**: a
    drawer over the page (no navigation), scrolled to `jobs.<job>.steps[<n>]` with its lines
    marked in the gutter — plus the job's `strategy` for a matrix leg; the job head's own
    YAML control opens the job block the same way. The source is the run's own `yaml`
    snapshot (05, D16), not the file the implementation publishes now, and the drawer's head
    says so ("as run · `<workflowVersion>`"); the current file is a link away. Esc, a click
    outside or Close returns to exactly the same row — the selection (`?step=`), the side and
    the page's scroll are untouched — and focus goes back to the control.
- **Which rows are open** is the page's own state, seeded from `?step=` and *added to* by it,
  never trimmed by it. Opening a row writes `?step=<key>` and pins; collapsing the row
  `?step=` names drops the parameter; collapsing any other row is a local move. Arriving with
  `?step=` opens that row and scrolls it into view. Any number may be open at once, and only
  the person's own toggle closes one — a row the page yanked shut would take a half-filled
  form's draft with it.
- **Interactive steps in `waiting`: the body *is* the island or the form** — as long as the
  run is the one this tab is driving; a read-only replay falls back to the tabs, because a
  submit from it would land on whatever run the slice holds live. An island always opens
  inline; one that declared `display: fullscreen` offers **Expand**, which fixes that row's
  body over the viewport with the content column collapsed to a strip (`island-strip`) whose
  crumb reads `Run › <job> › <step>` — the first two segments the way up, and Esc or **Exit
  fullscreen** the way back. Under the strip is that row and nothing else: the job head, the
  job's own values and the sibling rows give way for as long as the overlay holds. The iframe
  is not remounted either way (04 "Display modes"), and the overlay holds only while that row
  is on the job page in front of the person. There is
  no per-step accept control: the island's own Done is on screen, and skipping the hand-edit
  is decided at kickoff (07).
- An island that drives itself (07: a `headless: auto` island on an unattended run, or a step
  whose `auto-accept:` is on) still has to be mounted to do so — a row's body is the only
  thing that mounts an island (04, Decision 11) — but must not take the page from whatever
  the person is reading. While the selection is elsewhere, on another job page or on the
  Summary, it is mounted **backstage** by the run shell: the same frame, in the document but
  visually hidden and inert, where it loads, submits and finishes exactly as it would in the
  row. Only a self-driving island goes backstage; one that waits for a person is left to its
  row, which mounts it when it is expanded.
- Rows do not fight the person: a row that is mid-interaction — a live island `running` or
  `waiting`, a form `waiting` — is never collapsed by the page.

## Run page sections

1. Header: workflow name, run id, status pill, started by/at, elapsed/duration, annotation
   badges (notice/warning/error counts), actions (Cancel · Resume · Re-run · Delete · View
   workflow file). It is the run's, so it is the same on every page below.
2. **Three pages under it, one level of the taxonomy at a time** (decided 2026-08-26; routed
   2026-09-08): **run › job › step**, and the selection is the **route** — the Summary, `/job/<job>[/<index>]` (job), and `?step=<key>` on a job route (step). An old `?step=` on the Summary URL redirects (replace) to where it lives now.
   - **Summary** (`/runs/<runId>`): the **graph** in run mode, the navigator — one node per
     job — and under it the run's own values. *Input* is the kickoff form's values; *Output*
     is the **results** (the workflow's declared `outputs`, each with renderer + Download),
     then the **summary** (step summaries in job order — the GitHub job-summary page) and the
     **annotations**, each linking into the graph. A live run returns here when it finishes.
     Step outputs are never listed at the run level.
   - **Job page** (a graph node, an edge dot, a rail row): above.
   - **Step**: a row of the job page, expanded — above.
   The way up is the head's eyebrow (`Run`), the rail, and Esc. Esc **layers**: inside an
   expanded row's body it collapses that row; on a job page with nothing expanded (the
   collect view included) it goes up to the Summary; on the Summary there is nothing above,
   so it does nothing.
3. **Follow or pinned.** The selection starts out **following** the run: the run's waiting
   step opens as its row — the shell navigates (`replace`) to `/job/<job>/<i>?step=<key>`, the
   row expands and the form or island mounts in it — a loading island claims it (once per
   island), and a live run that finishes returns to the Summary. It is **pinned** the moment
   a person picks something — a rail row, a graph node, an edge dot, a row toggle, a crumb,
   Esc, a `?step=` or a job route they arrived with, typed, or stepped Back to — and from
   then on nothing moves it but them. A fresh load on the Summary with no `?step=` follows;
   any other arrival is pinned there. The run bar carries a **Follow run** toggle
   (`run-follow`, `data-state` `on`/`off`) while the run is in flight: off pins the selection
   where it is; on clears it to the Summary and lets the following rules pick the step the
   run is at. Following writes the URL with `replace` (Back leaves the run, never steps
   through auto-opens); a person's pick pushes. A finished run leaves a pinned selection
   alone — nothing moves anyway — and offers no toggle. The mode is per run: navigating to
   another run starts over from its URL.

## Kickoff form

Generated from `on.manual.inputs` (02 controls). `file` inputs upload on select (prepare → PUT
→ register, progress per file) so Start is instant; the form is valid only when uploads are
registered. Re-run pre-fills from a previous run's `inputs` (file refs reused, no re-upload).

Below the inputs, when the workflow has an interactive step that declares `headless:`, a
run-level **"Don't wait for me"** toggle (`kickoff-unattended`) starts the run `unattended`
(07): `auto` islands self-submit, `skip` forms skip, undeclared steps still wait. It is not an
input — it never lands in the run's `inputs`. A narrower version of the same question is an
ordinary input the workflow wires to one step's `auto-accept:` (07 "Per step") — Studio's
"Auto-accept the cut edits" (`accept_cuts`, default on) is declared last so it renders directly
above the toggle as its sibling; it *does* land in `inputs`, which is how Resume remembers it.

## Past runs

Table with status, started by, started at, duration, outputs (count + first file name),
annotations; row click → run; "Re-run" per row; filters: status, started by, date.

Every cell comes from the run row alone — the list endpoint returns no step rows — with one
join: a **running** run whose steps include one in `waiting` says **"waiting on \<step\>"** in
its Status cell, under the pill (`run-waiting`). The list endpoint attaches the keys of the
run's `waiting` step rows to each run record (`waitingOn`, joined at list time, never
persisted); the step's name is the one the run page gives it (`name`, else its id), resolved
from the definition snapshot the row already carries. Several steps can wait at once
(parallel matrix items, independent jobs): the first in scheduling order is named and the
rest counted, "waiting on review +2". The name links to `?step=<key>` on the run page, which
arrives pinned there. A finished run never says it — its rows are a record, whatever status
they were left in.

## Empty/error states (first-class, not afterthoughts)

- No implementations found → how to publish one (link to 06 / `publish-workflow`).
- Implementation reachable but a workflow fails validation → the workflow appears with the
  lint error and no Start.
- Run row exists but the definition snapshot is missing (should not happen) → read-only record.
- Run held by another tab → live read-only view with Take over.

## Headless-visible contract

`data-testid`s: `run-status`, `run-follow`, `run-outputs`, `island-backstage`, `kickoff-form`,
`kickoff-start`, `kickoff-auto`, `kickoff-invalid`, `implementations`, `workflow-list`; `data-state`
as in 07. `step[data-key][data-state]` lives on the job page's step rows (spec 2026-09-08, phase
3) — `job`, `job-head`, `job-io`, `job-steps`, `job-items` and `job-page` are that page's own
testids, and `rail-summary` / `rail-job` / `rail-matrix` are the run rail's rows for reaching it. A
driver waits on `window.__workflow.steps`, not the DOM, and reaches a step by URL
(`/job/<job>/<index>?step=<key>`) rather than a click.
Every run page also publishes `window.__workflow` (07's page contract). Treated as a contract
(Studio rule): rename in the driver only with a matching harness change.

## Not in v1

Editing YAML in the harness (author in the repo; the harness is read-only over definitions),
a visual workflow builder, multi-user presence cursors, dark-mode-specific assets (theme
tokens only).
