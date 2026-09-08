# Workflow: the run page in GitHub's shape — a jobs-only graph, a job page, step rows

**Date:** 2026-09-08 · **App:** `apps/workflow` · **Source:** the 2026-09-08 capture run
`run_01M209NB29MASK71R2B6D5WD2F` (4:00 of narration over the harness and a GitHub Actions run)
**Status:** design approved in conversation; awaiting spec review, then an implementation plan.

## Context

Spec 08 gave the run page one graph and one card under it, and put **every step inside its
job's card** on the graph. Selecting a chip swaps the card under the graph for that step's
pane; the three levels of the taxonomy (run › job › step) all live under one URL as `?step=`.

The recording faults exactly that. GitHub's run page shows a graph of **jobs**; the job is
what you click; a job page lists the job's **steps as rows you expand in place**, and the
step's detail lives inside the expanded row. The harness instead draws every step on the
diagram and then shows the step's detail on a separate card underneath, so a person reads
"diagram up here, output down there" and never gets a job-level view at all. The Summary
level is right and should stay the home. The matrix concept should read the way GitHub's
"Matrix: bundles · 1 job completed · Show all jobs" does. The summary's annotations and
per-job summaries should follow GitHub's Summary page more closely.

This design reshapes the run page to GitHub's three screens without changing what a run *is*:
no row, event, or engine change; the same step pane bodies, value renderers, follow logic and
island machinery, re-homed.

## What already exists (the design leans on all of it)

- `RunPage.tsx` (1023 lines) owns the live-or-replay data path, the `?step=` selection, follow
  or pinned (apps#452), the claim-once island effect, backstage islands, fullscreen, fork,
  delete, diagnostics and the `window.__workflow` publish. Its seams are the ones this design
  cuts along.
- Three panes of one shape: `RunPane` (kickoff inputs | outputs + summary + annotations),
  `JobPane` (needs | evaluated job outputs + step list, **Re-run from this job**), `StepPane`
  (evaluated `with` | declared outputs + audit trail; a waiting `form` or `island` *is* the
  pane while `live`). `PaneCrumbs` gives each its `Run › job › step` head.
- `GraphView` + `JobCard` + `StepChip`: derived layout (`geometry.ts`), one card per job with
  a header strip, matrix note, item selector and one chip per step; edge dots open the job on
  Input or Output; data-flow hover highlights source and target chips.
- `Shell`: a 56px top bar and a 16rem rail holding the implementation → workflow tree.
- The headless contract (07): `window.__workflow` (`steps[key]` → status, `currentSteps`,
  `outputs`), and the `data-testid`s `run-status`, `step[data-key][data-state]`,
  `run-outputs`, `step-pane`, `form-step`, `island-frame`, `script-log`, `island-display`.
- Readers of `?step=`: `RunsPage`'s "waiting on" link, `AnnotationList`'s jump (a button
  through `select`), the live walks (`packages/workflow-live/src/walks/{m1,hello,interactive}.ts`),
  the app's e2e specs, and the fullscreen strip's crumb.

## Decisions (from the design conversation)

| # | Decision |
|---|---|
| 1 | Real routes: the Summary at `/runs/:runId`, a job at `/runs/:runId/job/:job`, a matrix item at `/runs/:runId/job/:job/:index`. `?step=` stays, as the expanded step row on a job page. Old `?step=` links on the Summary URL redirect. |
| 2 | The job page is GitHub's: a rail of jobs on the left, the job's step rows on the right, **no graph**. |
| 3 | The rail replaces the shell's implementation tree while inside a run. One left column. |
| 4 | A waiting island or form renders **inside its expanded step row**; following navigates to it; Expand overlays the page as today. |
| 5 | The graph goes **jobs-only in both modes**. The workflow (definition) page lists a job's steps as declared rows under the graph. |
| 6 | A matrix job's page without an index is the **collect view**: job head, collected outputs, one row per item. |
| 7 | Any number of step rows may be open at once. `?step=` names the row most recently opened; collapsing it clears the param. |
| 8 | The Summary **keeps the graph**. Only the job page trades it for the rail. |

## Routes

| route | screen |
|---|---|
| `/:impl/:workflow/runs/:runId` | **Summary** — run header, jobs-only graph, run card |
| `/:impl/:workflow/runs/:runId/job/:job` | **Job** — a plain job's steps; a matrix job's collect view |
| `/:impl/:workflow/runs/:runId/job/:job/:index` | **Matrix item** — that item's steps |
| `…?step=<job/index/step>` on a job page | that step's row expanded |

Rules:

- The run routes hang off one **layout route** (`RunShell`, below) so moving between the
  Summary and a job never remounts the run.
- **Redirects.** `/runs/:runId?step=<job>` → `/runs/:runId/job/<job>`;
  `/runs/:runId?step=<job>/<i>/<step>` → `/runs/:runId/job/<job>/<i>?step=<job>/<i>/<step>`
  (a plain job's `<i>` is `0` and the URL still carries it — one shape for every step key).
  Other query parameters (`?mocks=`, `?resume=1`) ride along. The redirect is a `replace`, so
  Back leaves the run rather than bouncing.
- **A job page whose `:job` the definition does not declare** shows the job head with "This
  workflow declares no such job" (today's `JobPane` fallback) and the rail. An `:index`
  beyond the fan-out clamps to the collect view with a note.
- Back climbs the way GitHub's does: an expanded step (`?step=`) → the job page → the Summary
  → the workflow. A row toggle is a history entry (a person's pick); the page's own writes
  (following) use `replace`.

## The run shell

A layout route element that renders:

1. The shared **top bar** (brand, breadcrumb, whoami) — `Shell` is split into `TopBar` and a
   rail slot so both layouts share the bar. The breadcrumb reads `job/<job>/<i>` segments
   as `<job> › item <i+1>`.
2. The **run rail** (below) in the rail column.
3. In the content column: `RunHeader` and the run bar exactly as today (title, run id,
   started by/at, forked-from, actions, pill, progress, elapsed, badges, Follow toggle), then
   the banners (delete/diagnostics/fork failures, `PausedBanner`, `ResumeBanner`), then the
   page's `<Outlet>`.

It owns everything the pages share, lifted from `RunPage.tsx` unchanged in behaviour:

- the live-or-replay data path (`isLive`, the slice vs `useGetRunQuery` with the same polling
  rule), `definitionOf` + `replayRun`, `collectAnnotations`;
- `window.__workflow` publish and page states (`invalid` / `parked` / `busy`), `?resume=1`
  adoption, the lease and take-over flow;
- **follow or pinned** (re-mapped below), the claim-once island effect, the finished-run
  return;
- the **backstage** islands (`island-backstage`) — mounted by the shell, so a self-driving
  island keeps its frame while the person moves between the Summary and job pages;
- the **fullscreen** overlay (`ui.islandDisplay`): the content column collapses to the
  `island-strip` and the overlay holds the open island's row body; the strip's crumb reads
  `Run › <job> › <step>` and links up;
- fork (`forkable`, `fork`), delete (`useRunDelete`), diagnostics (`useRunDiagnostics`);
- the `RawRows` fallback when the snapshot cannot be replayed.

Pages read all of it through the layout's outlet context (`useRunContext()`), typed as one
object: `{ def, state, run, steps, isLive, impl, annotations, yamlSource, follow, actions }`.

## The run rail

Replaces the implementation tree on every run route. Top to bottom:

- **← <workflow name>**: back to `/:impl/:workflow`.
- **Summary** (`rail-summary`): `NavLink` to the Summary, `end`, with the run's status glyph.
- Eyebrow **JOBS**, then one row per job in `jobOrder(def)` (`rail-job[data-job]`): status
  glyph (`jobStatus`, the worst of its steps, `queued` before any ran), the job's label, and
  its duration (first `startedAt` to last `finishedAt` of its steps) in mono. A **matrix job**
  is a group row (`rail-matrix`) carrying the fraction `N of M` and a chevron; its items nest
  under it (`rail-job[data-job][data-index]`), each labelled as `JobCard`'s item selector
  labels them today (`itemLabel`: `who: world`, a file's name, `Item 3`), each linking to
  `/job/<job>/<i>`. The group row itself links to the collect view. The group starts expanded
  when the current route is inside it, collapsed otherwise; the chevron toggles it.
- Eyebrow **RUN DETAILS**: **Past runs** (`/runs`) and **Workflow file** (`/file` with the run's
  own `yaml` in navigation state, D16). The run header keeps its own links and actions
  unchanged; the rail's two links are GitHub's placement of the same things.

The current row (Summary, a job, an item) is highlighted the way the implementation tree
highlights the open workflow (white + hairline ring). Under 900px the rail stacks above the
content as the shell's rail does today.

Rail rows are `NavLink`s — a click is a person's navigation, so it **pins** (below).

## The Summary page

1. **The graph, jobs only** (`GraphView mode="run"`, jobs-only in both modes — see *Graph*).
2. **The run card** (`RunPane`), unchanged in shape: eyebrow `RUN` · workflow name · run id |
   **Input | Output** | Show raw | pill | `WORKFLOW`.
   - **Input**: the kickoff values through their declared renderers, as today.
   - **Output**, in this order:
     1. the run's declared **outputs** (`RunOutputs`, `run-outputs`) — the results;
     2. an **Annotations** panel (`annotations`): a disclosure headed by the header's counts
        ("1 warning"), open when any annotation is `error`, listing run-level annotations then
        each step's, each with a link to its step (`/job/<job>/<i>?step=<key>`) — GitHub's
        Annotations panel;
     3. one **job summary** section per job in `jobOrder(def)` that wrote any summary, headed
        **"<job label> summary"** (a matrix item: "<job label> (item label) summary"), holding
        that job's step summaries in step order as markdown, each section's head linking to
        the job page — GitHub's per-job summary blocks. Jobs with no summary are omitted;
        none at all → "No step wrote a summary."
   Step outputs never appear on the Summary (08, unchanged).

A live run that finishes while following returns here (below).

## The graph

`GraphView` draws **one node per job** in both modes; `cardHeight` no longer sums chips.

- **Run mode node** (`job[data-job]`): the header strip as today (label, `job-head` button),
  the matrix note, and under it one **status line**: glyph + status word + mono duration for
  a plain job; for a matrix job the eyebrow `MATRIX · <job>` and `N of M done` in place of the
  status word. No item selector: items live in the rail. The whole node is the job's handle
  (opens `/job/<job>`; a matrix node opens its collect view). The edge dots keep their meaning:
  left opens the job on Input, right on Output (`?tab=Input|Output` on the job page — the
  `paneSide` counter becomes a query the job page reads once).
- **Definition mode node**: the header strip, the matrix note, the step count and the job's
  declared **outputs** (`OUT name · type` lines, lifted from the chips to the job) — the
  payloads the edges carry.
- **Data-flow hover** (`flow.ts`) highlights **jobs** on the graph: the source job and the
  target jobs of the hovered value. On a job page a hovered value highlights the step rows
  of that job it came from or goes to; cross-page highlighting is not attempted.
- Geometry: `CARD.strip` + note + one `CARD.status` (42px) row + border; definition mode
  adds `CHIP.out` per declared job output. `COL_W`, gaps, dots, connectors unchanged.
- `StepChip` leaves the graph and becomes the job page's **step row** head (below).

## The job page

Three variants share one column under the run header:

**Plain job** (`/job/<job>`; `job-page[data-job]`):

1. **Job head** (`job-head`): eyebrow `RUN › JOB`, the job's label, its id in mono, the
   status pill, the duration, the matrix note when any; actions on the right: **Re-run from
   this job** (`job-fork`, when `forkable`), **YAML** (`YamlControl` on the job block).
2. **Job inputs and outputs** (`job-io`): a collapsed `<details>` holding today's `JobPane`
   body — **Input | Output** segmented, Show raw; Input = what it waited on (`needs`, each
   upstream job's evaluated outputs), Output = its declared `outputs:` evaluated with `goes
   to …` chips. Still the one place job outputs are visible (05). Opens automatically when the
   page was reached from an edge dot (`?tab=`), on that side.
3. **Steps** (`job-steps`): the step rows.

**Matrix item** (`/job/<job>/<i>`): the same, with the head's eyebrow `RUN › JOB › ITEM`, the
item's label, `item i+1 of N`, and the item's **matrix bindings** as the first entries of the
Job inputs (`matrix.<var>` values through the same renderers). Job outputs on an item are
element `i` of each collected list (`jobs.<job>.outputs.<name>[i]`, `null` for an item that
never produced), so the item page and the collect view read from the same evaluation.

**Matrix collect view** (`/job/<matrix>`): head as a plain job with `MATRIX · N ITEMS` as its
kind; Job inputs and outputs with the **collected** outputs (lists, exactly as
`buildRunContexts` hands them downstream); then **Items** (`job-items`): one row per item —
glyph, item label, `item i+1`, duration — each a link to its item page. No step rows.

## Step rows

One row per step of the job (or item), in declaration order (`step[data-key][data-state]`,
the same testid and attributes `StepChip` carries today — the contract moves, it does not
change shape):

- **Head** (a `<button aria-expanded>`): status glyph · label (+ id in mono when they
  differ) · kind · `attempt n` when > 1 · mono duration or status word · chevron.
- **Body** (`step-pane`, rendered only while expanded): today's `StepPane` below its head —
  the **Input | Output** segmented, Show raw, **YAML** (the step block), the status pill;
  Input = the evaluated `with` with `from …` origins; Output = declared outputs through
  their renderers with `goes to …`, then the trail (stats, error, summary, annotations,
  script log, raw response). A waiting `form` (`form-step`) or `island` (`island-frame`)
  **is the body** while `live`, with Expand for a `display: fullscreen` island; read-only
  replays fall back to the tabs (the existing `live` gate). `MediaSeekProvider` scopes per
  row.
- **Expansion state** is local to the page (`Set<StepKey>`), seeded from `?step=`. Opening a
  row writes `?step=<key>` (push, pins); collapsing the row that `?step=` names removes the
  param (push); collapsing another row is local only. Arriving with `?step=` opens that row
  and scrolls it into view. A row the run has not reached yet (`queued`, no state row) has a
  head and no body — its chevron is disabled.
- **Following** opens the waiting row through the same path with `replace` and does not
  collapse rows the person opened.
- Rows do not fight the person: a row that is mid-interaction (a live island `running` /
  `waiting`, a form `waiting`) is never collapsed by the page.

## Follow or pinned, re-mapped

The rules of apps#452 hold; what "the selection" means changes from a `?step=` value to a
**location**: `{ page: 'summary' } | { page: 'job', job, index, step? }`.

- **Following** (the default without a `?step=` or a job route on arrival; the run bar's
  `run-follow` toggle): when the run reaches a `waiting` step (first by topo order), or a
  loading island claims the pane (once per island, `claimed` as today), the shell navigates
  with `replace` to `/job/<job>/<i>?step=<key>` — the row opens, the island mounts there.
  A live run whose status leaves `running` while following navigates with `replace` to the
  Summary.
- **Pinned** the moment the person navigates: a rail row, a graph node, an edge dot, a row
  toggle, a crumb, Esc, the browser's Back, or a URL they typed (any route change the shell
  did not write, detected with the same `pageWrote` ref). Arriving on a job route or with
  `?step=` pins. Turning Follow on again clears to the Summary with `replace` and lets the
  rules pick the step.
- **Backstage** (self-driving islands while pinned elsewhere or while the person is inside
  another interactive row) is unchanged, and now also covers "the person is on the Summary
  or another job page".
- **Esc** inside an expanded row collapses it; on the collect view or a job page with nothing
  expanded, Esc goes up to the Summary (the crumb's Back).

`ui.selectedStep` (the read-model tests use) becomes the `?step=` value when on a job page,
`null` otherwise; `ui.follow` is unchanged.

## The workflow page (definition mode)

`/:impl/:workflow` keeps its shape (title, description, Start a run, View workflow file,
Recent runs) with the jobs-only graph. Clicking a job node shows, under the graph, the job's
**declared rows**: the same step-row head in a `declared` state (kind icon instead of the
glyph, `uses` as the meta, the `headless: …` badge), and an expanded body showing the
declaration: declared inputs (`with`) and outputs (`OUT name · type`) as a value list, and
the raw declaration as JSON (what the side panel `graph-panel` shows today). The per-step
side panel goes away. No `?step=` on this page — expansion is local.

## Headless and agent contract

07's page contract is untouched: `window.__workflow` publishes the same shape from the shell
on every run route, and `run-status`, `run-outputs` (Summary only, as today), `kickoff-*`
keep their homes. What moves:

| was | is |
|---|---|
| `step[data-key][data-state]` on the graph, on the run page | on the **job page's rows** (and the workflow page's declared rows, `data-state="declared"`) |
| `step-pane` = the card under the graph | `step-pane` = the **expanded row's body**; `form-step`, `island-frame`, `script-log`, `island-display`, the `Output` tab resolve inside it unchanged |
| clicking a chip to open a step | **navigate** to `/job/<job>/<i>?step=<key>` (the old `?step=` on the run URL still redirects there) |
| waiting on a chip's `data-state` from the run page | wait on `window.__workflow.steps[key]` (07: "the driver never scrapes the DOM for data") |
| `job[data-job]` = a graph card; `job-head` = its strip | unchanged on the graph; the job page adds `job-page[data-job]`, `job-head`, `job-io`, `job-steps`, `job-items`; the rail adds `rail-summary`, `rail-job[data-job][data-index]`, `rail-matrix` |
| `step-pane-back` (the nearest crumb) | the job head's crumb up to the Summary; the fullscreen strip's `island-exit-fullscreen` unchanged |

`packages/workflow-live` walks (`m1`, `hello`, `interactive`) and `apps/workflow/e2e/*` gain
two helpers — `waitStepState(page, key, want)` over the global, and `openStep(page, runUrl,
key)` that navigates — and stop touching `[data-testid="step"]` from the run page.
`packages/workflow-headless` already drives the global and needs no change. The MCP step
view (10, D24) is unaffected.

## Data and state

No persistence, row, event or engine change. `RunState`, `replayRun`, `buildRunContexts`,
`jobOrder`, `firstWaitingStep`, `isLoadingIsland`, `isActiveIsland`, `waitingSteps` are
reused as they are. New pure helpers: `jobStatus` (lifted from `JobPane`), `jobDuration`,
`stepsOfJob(def, state, job, index)` (lifted from `JobPane`'s rows), `parseStepKey` (the three
private copies in `StepPane`, `JobCard`, `RunPage` become one in `lib/runner/types.ts`),
`redirectFor(search)` (the `?step=` → route mapping, unit-tested).

## Error and empty states

- No run / failed fetch / not replayable: as today (`RawRows`, the error card), with the rail
  showing only the back link and Run details.
- A job page for an undeclared job or an out-of-range item: head + note, rail intact.
- A `?step=` on a job page that names a step of another job redirects to that step's job.
- A job with no steps reached: rows with disabled chevrons and `queued` glyphs; the rail row
  reads `queued`.
- A run held by another tab: the same live read-only view with Take over, on every route.

## Testing

- **Unit (vitest):** `redirectFor`; `RunShell` (data path, global publish, banners, outlet
  context); `RunRail` (order, glyphs, matrix group expand/collapse, current highlight,
  responsive stack class); `GraphView` jobs-only geometry in both modes and the edge dots'
  `?tab=`; `SummaryPage` (outputs → annotations panel → per-job summaries, links); `JobPage`
  (plain, item, collect; `job-io` opens on `?tab=`; fork button gating); `StepRow` (expand /
  collapse, `?step=` writes, `Esc`, disabled when unreached, live form/island as body, Expand);
  follow re-map (waiting → navigate replace, claim-once, finish → Summary, every pin
  trigger, Back detection); `WorkflowPage` declared rows. Existing `RunPage.*.test.tsx`
  (follow, live, headless, trust, selection, resume, yaml) split across the shell and the
  pages with their assertions kept.
- **E2e (Playwright, mocks):** `hello`, `interactive`, `headless`, `page-tools` on the new
  contract via the two helpers.
- **Live walks:** `m1`, `hello`, `interactive` updated; the `apps-live-walk` agent runs them
  against the preview before merge.
- **Visual:** headless Chromium shots (`localdev-tools/shot.mjs`) of the capture run's Summary,
  its `plan` job page with `Plan the stills` expanded, the `sheets` matrix collect view and
  item 1, and a hello run parked on its form; `consoleErrors:0, failedRequests:0`.

## Delivery

An epic branch (`epic/run-page-github-shape`) with a draft master PR labelled `epic`, and
stacked PRs merged in order; each PR updates the spec and design docs for the part it
changes (`docs/spec/08-harness-ui.md`, `07-headless.md` §contract, `05` §Summaries wording,
`DESIGN.md` §Graph/§Pane/§Layout):

1. **Routes and shell** — `TopBar` split, `RunShell` layout route with the run rail, the
   Summary and job routes, `redirectFor`; the pages are the existing `RunPane`/`JobPane`/
   `StepPane` re-homed so nothing visible changes yet except the rail and the URLs.
2. **Jobs-only graph** — `GraphView`/`JobCard` node redesign, `flow.ts` at job granularity,
   `?tab=` dots; the Summary's per-job summaries and Annotations panel.
3. **Job page and step rows** — `JobPage` (three variants), `StepRow` over the `StepPane`
   body, `job-io`; live form/island inside a row; Expand; Esc.
4. **Follow re-map and contract** — navigation-level following, pin triggers, backstage
   across routes; `window.__workflow` from the shell; walk and e2e helpers; 07/08 tables.
5. **Definition mode** — declared rows on the workflow page; the side panel removed.

The epic's squash lands with a `BEGIN_COMMIT_OVERRIDE` block in the master PR body naming
the feature for release-please. The `workflow.j5s.dev` harness is deployed from the epic
branch for the live walks; a `main` merge overwrites it.

## Not in this design

Editing YAML in the harness, a visual builder, dark mode (08 "Not in v1"); log search or a
per-step "search logs" box (GitHub's is over raw logs the harness does not keep); nesting
matrices deeper than one level; virtualising very long step lists; changing what a run
persists.
