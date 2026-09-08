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
| `/<impl>/<workflow>/runs/<runId>` | **Run** — the graph in *run* mode + step panes + run summary + outputs |
| `/<impl>/<workflow>/runs/<runId>/job/<job>` | **Job** — the job's Input | Output panes, the step trail, Re-run from this job |
| `/<impl>/<workflow>/runs/<runId>/job/<job>/<index>` | **Matrix item** — a job index + `?step=<key>` to select a step pane |
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
  even though the chip itself lives on a step's pane, off the graph.
- **Edge dots** are unchanged: the two dots on a node's edges are "jump straight to one side" —
  the left one opens the job on Input (what it waited on), the right one on Output (what it
  hands on).

## Step panes (run mode)

Selecting a card (or one of its edge dots — left opens Input, right opens Output) opens the
pane under the graph with the prototype's **Input | Output** toggle and payload chips:

- **Input** — the evaluated `with` (File refs as file cards, expressions resolved to values),
  each chip labelled "from `<job>/<step>`" when it came from a data-flow edge. A `form` step
  records its evaluated `with` too (title, fields with `default`/`options` resolved, submit) —
  on `step.waiting`, since a form never emits `step.started`; what the person typed is its
  *Output*.
- **Output** — each declared output with its renderer (02): table, transcript, markdown, file
  viewers with Download, JSON tree, `render: island` viewer; chips labelled "goes to …". Every
  value that is *drawn* rather than printed carries a `json` flip to the raw value the row holds
  (and back), so a chart or a table can always be read as its exact data; a bare `json` value
  is read for its shape first (02 "Inferred shapes") and the tree is the drill-in. The pane
  head's **Show raw** (run, job and step panes alike) flips every value on both tabs to the raw
  tree, remembered per browser. The
  audit trail rides here too (the separate Details tab was folded in on 2026-08-26): started /
  finished / took, attempt, kind, the pipeline path, the error (`code`, message; the raw
  response behind a disclosure), the step's `summary` rendered, its annotations, and a live
  script's log.
- **YAML** — a third control in the pane head, beside Input | Output, opens the workflow
  source **in place**: a drawer over the run page (no navigation), scrolled to the selected
  block with its lines marked in the gutter — `jobs.<job>.steps[<n>]` for a step, the job
  block for a job card, and for a matrix leg the step plus the job's `strategy`. The source
  is the run's own `yaml` snapshot (05, D16), not the file the implementation publishes now,
  and the drawer's head says so ("as run · `<workflowVersion>`"); the current file is a link
  away. Esc, a click outside or Close returns to exactly the same pane — the selection
  (`?step=`), the tab and the page's scroll are untouched — and focus goes back to the control.
- Interactive steps in `waiting`: the pane **is** the island or the form. An island always opens
  inline; one that declared `display: fullscreen` offers **Expand**, which overlays the same
  pane over the page with the graph collapsed to a strip (Esc / Exit returns) — the iframe is
  not remounted either way (04 "Display modes"). There is no per-step accept control: the
  island's own Done is on screen, and skipping the hand-edit is decided at kickoff (07).
- An island that drives itself (07: a `headless: auto` island on an unattended run, or a step
  whose `auto-accept:` is on) still has to be mounted to do so — the pane is the only thing
  that mounts an island (04, Decision 11) — but must not take the pane from whatever the
  person is looking at. While the selection is elsewhere it is mounted **backstage**: the same
  frame, in the document but visually hidden and inert, where it loads, submits and finishes
  exactly as it would in the pane. Only a self-driving island goes backstage; one that waits
  for a person is left to its chip, which mounts it on click.

## Run page sections

1. Header: workflow name, run id, status pill, started by/at, elapsed/duration, annotation
   badges (notice/warning/error counts), actions (Cancel · Resume · Re-run · Delete · View
   workflow file).
2. The graph (run mode), the navigator.
3. **One card under it, one level of the taxonomy at a time** (decided 2026-08-26): **run ›
   job › step**, three cards of one shape — eyebrow · name · key | **Input | Output** | pill |
   kind — and the selection is the **route**: the Summary, `/job/<job>[/<index>]` (job), and `?step=<key>` on a job route (step); an old `?step=` on the Summary URL redirects (replace) to where it lives now. (phases 1–2 of the 2026-09-08 redesign render the job card and the step pane together on the job page; phase 3 replaces both with step rows)
   - **Run card** (nothing selected): *Input* is the kickoff form's values; *Output* is the
     **results** (the workflow's declared `outputs`, each with renderer + Download), then the
     **summary** (step summaries in job order — the GitHub job-summary page) and the
     **annotations**, each linking into the graph. A live run returns here when it finishes.
   - **Job card** (a graph card's header strip, or an edge dot): *Input* is
     what the job waited on — each `needs` job's evaluated outputs; *Output* is the job's own
     declared `outputs:` **evaluated** (aliases over step outputs; a matrix job's collect into
     lists), with `goes to …` chips; the trail lists the job's steps, each a way down. Job
     outputs are derived, never persisted (05) — this is the one place they are shown.
     The card carries the one per-job action, **Re-run from this job** — a fork (05): a new
     run under the current definition, this job and everything downstream of it run again,
     every other job copied from this run. Offered only on a terminal run this tab is not
     driving, and only for a job whose upstream all ended `success`/`skipped`.
   - **Step pane** (a chip): as below.
   Every card's head carries the breadcrumb `Run › <job> › <step>`; each segment above the
   current one is a way up. Esc and the pressed chip/strip climb one level. Step outputs are never listed at the run level.
4. **Follow or pinned.** The selection starts out **following** the run: a waiting form opens
   as its pane, a loading island claims it (once per island), and a live run that finishes
   returns to the run card. It is **pinned** the moment a person picks something — a chip, a
   strip, an edge dot, a crumb, Esc, a `?step=` they arrived with, typed, or stepped Back to —
   and from then on nothing moves it but them. A fresh load with no `?step=` follows; one with
   a `?step=` is pinned there. The run bar carries a **Follow run** toggle (`run-follow`,
   `data-state` `on`/`off`) while the run is in flight: off pins the selection where it is; on
   clears it and lets the following rules pick the step the run is at. Following writes the
   URL with `replace` (Back leaves the run, never steps through auto-opens); a person's pick
   pushes. A finished run leaves a pinned selection alone — nothing moves anyway — and offers
   no toggle. The mode is per run: navigating to another run starts over from its URL.

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

`data-testid`s: `run-status`, `run-follow`, `step`, `run-outputs`, `island-backstage`,
`kickoff-form`, `kickoff-start`, `kickoff-auto`, `kickoff-invalid`, `implementations`,
`workflow-list`; `data-state` as in 07.
Every run page also publishes `window.__workflow` (07's page contract). Treated as a contract
(Studio rule): rename in the driver only with a matching harness change.

## Not in v1

Editing YAML in the harness (author in the repo; the harness is read-only over definitions),
a visual workflow builder, multi-user presence cursors, dark-mode-specific assets (theme
tokens only).
