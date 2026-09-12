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
| `/<impl>/<workflow>` | **Workflow** — the graph (below) in *definition* mode, a picked job's **declared rows** under it + "Start a run" + recent runs |
| `/<impl>/<workflow>/run` | **Kickoff** — the form from `on.manual.inputs`; Start creates the run and navigates to it. `?from=<runId>` prefills it for Re-run; `?auto=1&inputs=<base64url(JSON)>` is the headless entry (07) — no form at all, a `kickoff-auto` notice while the run starts, or a `kickoff-invalid` list of the values it refused |
| `/<impl>/<workflow>/runs` | **Past runs** — table: status (a running run parked on a step says "waiting on <step>" beside its pill, linked to that step; a dispatched run nobody has picked up yet reads **Queued**), started by/at, duration, annotations count, outputs summary; filter by status, Queued included; Re-run |
| `/<impl>/<workflow>/runs/<runId>` | **Summary** — the jobs-only graph in *run* mode + the run card: its inputs, then its results (folded into rows, unlike the kickoff inputs beside them, which stay open), its annotations and a summary section per job. An old `?step=` here redirects (replace) to the step's job page |
| `/<impl>/<workflow>/runs/<runId>/job/<job>` | **Job page** — the job head, the job's inputs disclosure, the step rows, then the **Job output** section; `?step=<key>` names the row that is open. A matrix job with no index is the **collect view**: the collected outputs and one link per item |
| `/<impl>/<workflow>/runs/<runId>/job/<job>/<index>` | **Matrix item** — the same page for one leg of a matrix job |
| `/<impl>/<workflow>/file` | **View workflow file** — YAML with lint results (also linked from a run: the snapshot) |

Outside a run the left rail is the implementation → workflow tree. On **every run route** the
**run rail** takes its place (`nav[aria-label="Run"]`) — one left column, never both: `←
Workflow` back to the workflow (`rail-back`), **Summary** with the run's status glyph
(`rail-summary`), the eyebrow `JOBS` and one row per job in scheduling order
(`rail-job[data-job]`: glyph, label, duration), a matrix job as a group (`rail-matrix`) whose
row carries `N of M` and a chevron over its items (`rail-job[data-job][data-index]`, each
labelled `who: world` / `Item 3` as the item is), then `RUN DETAILS` — **Past runs** and
**Workflow file** (the run's own snapshot). Every row is a link, so a click on one is a
person's navigation and **pins** the selection. The current row is highlighted the way the
implementation tree highlights the open workflow. The top bar shows the breadcrumb and the
signed-in user.

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
  once"). The run bar above carries the run's own elapsed, "6 of 6 done" and Cancel (below).
  A job's status is the **engine's** result (Task 17b), not the worst of its rows: a step that
  failed under `continue-on-error` is absorbed — its own row still reads `failed`, but the job
  it is in does not — and a job whose step is parked on a form or an island reads `waiting`.
  The rail row, the node and the job head all print that one reading, so they cannot disagree.
- **Definition mode** (`/<impl>/<workflow>`): the status line is instead the job's step count
  (`N steps`), and the node adds one `OUT name · type` line per output the job declares.
  Clicking a node lists that job's **declared rows** under the graph (below); in run mode the
  whole node is the job's handle onto its own page.
- **Edges** = `needs` (structural) and **data-flow** edges derived from expressions
  (`needs.x.outputs.y`, `steps.x.outputs.y`), read at job granularity: hovering a payload chip
  highlights the job it came from (a solid ring) and every job that reads it (a dashed outline),
  even though the chip itself lives in a step row's body, off the graph. The same hover marks
  the **step rows** of the job page in front of the person (`data-flow` on the row head);
  highlighting across pages is not attempted.
- **Edge dots** are unchanged in meaning: the two dots on a node's edges are "jump straight to
  one side" — the left one opens the job on Input (what it waited on), the right one on Output
  (what it hands on). Since the two sides became two places (above), `?tab=Input` opens the
  inputs disclosure and `?tab=Output` scrolls to the **Job output** section with its values
  already expanded — either way the dot lands on the thing it was clicked for.

## The job page

A job is its own page (2026-09-08 redesign) — `/job/<job>[/<index>]`, `job-page[data-job]`,
GitHub's job screen. A head saying which job this is, the job's own values behind a
disclosure, and the job's steps as **rows that expand in place**: there is no step route and
no step card any more, so the page around an open step never goes away.

1. **Job head** (`job-head`): the eyebrow `RUN › JOB` (`› ITEM` on a matrix leg) — `Run` is
   the one climb out of a job, the rail's Summary row being the other — the job's label, its
   id in mono, the status pill, the duration, the matrix note when there is one, and on a leg
   `item i+1 of N · <item label>`. On the right, the two actions that belong to the job rather than to any
   one step: **Re-run from this job** (`job-fork`) and **YAML** on the job block. The fork is
   05's: a new run under the current definition, this job and everything downstream of it run
   again, every other job copied from this run — offered only on a terminal run this tab is
   not driving, and only for a job whose upstream all ended `success`/`skipped`.
2. **Job inputs** (`job-io`): a collapsed disclosure holding **Show raw**. What the job
   waited on — each `needs` job's evaluated outputs, and on a matrix leg its **matrix
   bindings** as the first entries. `?tab=Input` opens it, and it stays open underneath a row
   the person then expands.

   The job's **outputs** are no longer the other side of a toggle here: since the 2026-09-09
   UX review they are their own **Job output** section (`job-output`) *below* the step rows,
   because a job's result comes after the work that produced it. Its content is unchanged —
   the job's own declared `outputs:` **evaluated** (aliases over step outputs; a matrix job's
   collect into lists), with `goes to …` chips. Job outputs are derived, never persisted (05)
   — this is still the one place they are shown.
3. **Steps** (`job-steps`): the step rows, below.

A **matrix collect view** (`/job/<matrix>`, no index) is the same page with `MATRIX · N ITEMS`
as its kind, the *collected* outputs in the **Job output** section, and — instead of step rows — an
**Items** list (`job-items`): one row per item (`job-item[data-index]`: glyph, item label,
`item i+1`, and its duration once the leg is over, `N of M done` while it is not), each a link
to that item's page. Deliberately no rows: 2 items × 3 steps is a list whose rows say
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
    …". Every value that is *drawn* rather than printed carries a `Rendered | JSON` switch —
    two segments, the filled one the view on screen — so a chart or a table can always be read
    as its exact data; a bare `json` value is read for its shape first (02 "Inferred shapes")
    and the tree is the drill-in. **Show raw** flips every value on both sides to the raw tree,
    remembered per browser.

    Since the 2026-09-09 UX review every value with a body is a **row** (`value-row`), a
    disclosure closed by default, whose closed line carries the name, what the value *is*
    (`video/mp4 · 268.7 MB`, `8,681 items`) and its type — a pane is a list to scan rather than
    a mile to scroll. A `values-expand-all` bar above the list opens or closes all of them, and
    is absent when nothing in the pane folds. Two values never fold: an `island`, which is a
    live surface a closed row would remove, and anything the closed line already prints whole.
    A closed row's body is hidden, not unmounted, so a `transcript` seek into a player inside
    one **opens that row** rather than moving a player nobody can see. The audit trail rides here too (the separate Details tab was folded in on
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

## The workflow page: declared rows

`/<impl>/<workflow>` is the same shape before any run exists (2026-09-08 redesign, Task 17).
Clicking a job on the definition graph lists that job's steps **under the graph**, as the same
`job-page` / `job-head` / `job-steps` / `step` markup the run's job page draws — one reading of
a workflow serving both screens — in their *declared* reading:

- The head is the job's name, its id, its kind (`matrix` without a count: how many items it
  fans out into is a fact only a run has) and its matrix note — four things the *file* says.
  Nothing that reads an *attempt* is guessed at — no status pill, no duration, no `Run ›`
  crumb, no fork, no YAML control.
- A row's head carries the **kind glyph** in place of the status glyph, the step's id, its
  `uses` word and its `headless: …` badge when it declares one; `data-state="declared"`.
- The body is the declaration: **Inputs** — the declared `with`, entry by entry, through the
  same renderers, an expression shown as the string it is (a promise about a value is not the
  value); **Outputs** — the same `OUT name · type` lines the graph's node draws; and the raw
  block behind a closed **Declaration** disclosure (`step-declaration`). The per-step side
  panel the graph used to open went with them: a step's declaration belongs in the step's own
  row, not beside the diagram.
- Which rows are open is local and nothing else — there is no run to address, so no `?step=`
  and no selection worth putting in a URL — and picking another job starts its list fresh.

## Run page sections

1. Header: workflow name, run id, started by/at, then the run bar — status pill, mono
   progress ("6 of 6 done"), elapsed/duration, annotation badges (notice/warning/error
   counts) and the **Follow run** toggle while the run is in flight. Its actions are Past
   runs · View workflow file · Copy diagnostics · Attach to run · Re-run, plus Cancel while
   this tab drives a running run and Delete where the person may. Resume and Take over are
   the banners' (05), not the header's. It is the run's, so it is the same on every page
   below.
2. **Three screens under it, one per level of the taxonomy** (decided 2026-08-26; routed
   2026-09-08): **run › job › step**, and the level is the **route** — the Summary, `/job/<job>[/<index>]` (job), and `?step=<key>` on a job route (step). An old `?step=` on the Summary URL redirects (replace) to where it lives now.
   - **Summary** (`/runs/<runId>`): the **graph** in run mode, the navigator — one node per
     job — and under it the run card, the run's own values. *Input* is the kickoff form's
     values; *Output* is, in this order, the **results** (the workflow's declared `outputs`,
     each with renderer + Download), the **Annotations** panel (`annotations`) and then one
     **summary section per job** (`run-summary`). A live run returns here when it finishes.
     Step outputs are never listed at the run level.
     - The **Annotations** panel is GitHub's: a disclosure headed by the run's counts
       ("Annotations · 1 warning, 1 notice"), closed unless the run carries an `error`, listing
       run-level annotations then each step's, each linking to the step it came from —
       `/job/<job>/<i>?step=<key>`, which arrives with that row open.
     - The **summary sections** are GitHub's per-job summary blocks: the step summaries a job
       wrote, grouped under **"<job label> summary"** ("<job label> (<item label>) summary" for
       a matrix leg) in scheduling order, each heading a link to that job's own page — a
       matrix leg's, to the item's. A job that wrote none is omitted; none at all reads "No
       step wrote a summary."
   - **Job page** (a graph node, an edge dot, a rail row): above.
   - **Step**: a row of the job page, expanded — above.
   The way up is the head's eyebrow (`Run`), the rail, and Esc. Esc **layers**: inside an
   expanded row's body it collapses that row — **except while a live form or island holds
   it**, where the row is the person's to resolve and Esc is the body's (a fullscreen island
   spends it on **Exit fullscreen**); on a job page with nothing expanded (the collect view
   included) it goes up to the Summary; on the Summary there is nothing above, so it does
   nothing. The layering is structural, not a special case: `StepBody` returns the
   `FormStepPane`/`IslandStepPane` before it reaches its own `onKeyDown` wrapper, and the job
   page's window listener is off while any row is open.
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
join and one exception.

The exception is a row that has no run behind it yet (apps#671, spec 11 §Attribution): a run
that was **dispatched and not picked up**, which the list endpoint stands up from its
unconsumed `workflow_run_claims` row as a synthetic `status: 'queued'` entry. It knows only
who asked and when, so duration, annotations and outputs read `—` (not known, not empty) and
**Re-run is hidden** — it prefills a kickoff from a run row that does not exist yet. The run
id still links: it resolves the moment the row lands, and until then reads as the not-found
state an unreachable run already shows. `RunStatus` is untouched; `Queued` joins the status
filter, second, in lifecycle order.

The join is that a **running** run whose steps include one in `waiting` says **"waiting on \<step\>"** in
its Status cell, under the pill (`run-waiting`). The list endpoint attaches the keys of the
run's `waiting` step rows to each run record (`waitingOn`, joined at list time, never
persisted); the step's name is the one the run page gives it (`name`, else its id), resolved
from the definition snapshot the row already carries. Several steps can wait at once
(parallel matrix items, independent jobs): the first in scheduling order is named and the
rest counted, "waiting on review +2". The name links to that step's own URL —
`/job/<job>/<index>?step=<key>` — which arrives pinned there, its row open. A finished run never says it — its rows are a record, whatever status
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
3) and on the workflow page's declared rows (`data-state="declared"`, phase 5) — `job-page`,
`job-head`, `job-io`, `job-steps`, `job-items`, `job-item[data-index]` are that page's own
testids, `job[data-job][data-state]` is a graph node, and `rail-back` / `rail-summary` /
`rail-job[data-job][data-index]` / `rail-matrix` are the run rail's rows for reaching it.

A driver waits on `window.__workflow.steps`, never the DOM. **How it reaches a step depends on
what the tab is**: one that only *observes* a run may load the step's own URL,
`/job/<job>/<index>?step=<key>` — a fresh load simply re-hydrates it. The tab **driving** the
run must not: a full navigation demotes it to an observer ("Another tab is driving this run.
Take over…") and races the record it just wrote, so it navigates **in-page** the way a reader
would — the rail's job (or matrix item) row, then the step's own row head, which expands in
place (07 §contract; `packages/workflow-live`'s `openStep`).
Every run page also publishes `window.__workflow` (07's page contract). Treated as a contract
(Studio rule): rename in the driver only with a matching harness change.

## Not in v1

Editing YAML in the harness (author in the repo; the harness is read-only over definitions),
a visual workflow builder, multi-user presence cursors, dark-mode-specific assets (theme
tokens only).
