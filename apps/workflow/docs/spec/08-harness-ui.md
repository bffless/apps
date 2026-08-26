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
| `/<impl>/<workflow>/run` | **Kickoff** — the form from `on.manual.inputs`; Start creates the run and navigates to it; `?auto=1&inputs=` is the headless entry (07) |
| `/<impl>/<workflow>/runs` | **Past runs** — table: status, started by/at, duration, annotations count, outputs summary; filter by status; Re-run |
| `/<impl>/<workflow>/runs/<runId>` | **Run** — the graph in *run* mode + step panes + run summary + outputs |
| `/<impl>/<workflow>/file` | **View workflow file** — YAML with lint results (also linked from a run: the snapshot) |

The left rail is the implementation → workflow tree; the header shows the project and user.

## The graph

One view, two modes, same layout:

- **Nodes** = jobs; a matrix job renders as a **group card** ("For each video · 3 at once")
  containing its steps as a vertical sequence; a plain job renders as its steps stacked under
  the job name (a one-step job is one card). Node order/layout is derived from `needs`
  (topological, left→right), not hand-placed.
- **Edges** = `needs` (structural) and **data-flow** edges derived from expressions
  (`needs.x.outputs.y`, `steps.x.outputs.y`): hovering a payload chip highlights where it came
  from and where it goes (the prototype's "from … / goes to …" labels).
- **Definition mode** (`/<impl>/<workflow>`): every card shows kind icon, name, declared
  inputs/outputs (types), `headless` badge; clicking shows the step's declaration.
- **Run mode**: cards carry status (`queued running polling waiting succeeded failed skipped
  cancelled`), duration, attempt, and for matrix jobs a progress fraction ("7 of 9") with an
  item selector; the header shows elapsed, "7 of 14 done", Cancel, Resume/Take-over when
  applicable.
- **Loop depth**: one level of group nesting is designed for; deeper matrices (a matrix job
  whose `needs` a matrix job) render as sibling groups with the fan-out noted, not nested
  boxes.

## Step panes (run mode)

Selecting a card (or one of its edge dots — left opens Input, right opens Output) opens the
pane under the graph with the prototype's **Input | Output** toggle and payload chips:

- **Input** — the evaluated `with` (File refs as file cards, expressions resolved to values),
  each chip labelled "from `<job>/<step>`" when it came from a data-flow edge.
- **Output** — each declared output with its renderer (02): table, transcript, markdown, file
  viewers with Download, JSON tree, `render: island` viewer; chips labelled "goes to …". Every
  value that is *drawn* rather than printed carries a `json` flip to the raw value the row holds
  (and back), so a chart or a table can always be read as its exact data. The
  audit trail rides here too (the separate Details tab was folded in on 2026-08-26): started /
  finished / took, attempt, kind, the pipeline path, the error (`code`, message; the raw
  response behind a disclosure), the step's `summary` rendered, its annotations, and a live
  script's log.
- Interactive steps in `waiting`: the pane **is** the island (inline) or the form; `display:
  fullscreen` islands take over the main area with the graph collapsed to a strip.

## Run page sections

1. Header: workflow name, run id, status pill, started by/at, elapsed/duration, annotation
   badges (notice/warning/error counts), actions (Cancel · Resume · Re-run · Delete · View
   workflow file).
2. The graph (run mode), the navigator.
3. **One card under it, one level of the taxonomy at a time** (decided 2026-08-26). With no
   step selected, the **run card** — the run as the outermost step, in the step pane's own
   shape: eyebrow `WORKFLOW`, the workflow name, the run id, the same **Input | Output**
   toggle. *Input* is the kickoff form's values; *Output* is the **results** (the workflow's
   declared `outputs`, each with renderer + Download), then the **summary** (step summaries
   concatenated in job order — the GitHub job-summary page) and the **annotations**, each
   linking into the graph. Selecting a step **replaces** the run card with that step's pane
   (`← Run` / Esc / the pressed chip climb back out). A live run returns to the run card the
   moment it finishes. The selection is the URL: `?step=<job>/<index>/<step>` (linkable; the
   browser's Back button climbs out of a step). Step outputs are never listed at the run level.

## Kickoff form

Generated from `on.manual.inputs` (02 controls). `file` inputs upload on select (prepare → PUT
→ register, progress per file) so Start is instant; the form is valid only when uploads are
registered. Re-run pre-fills from a previous run's `inputs` (file refs reused, no re-upload).

## Past runs

Table with status, started by, started at, duration, outputs (count + first file name),
annotations; row click → run; "Re-run" per row; filters: status, started by, date.

## Empty/error states (first-class, not afterthoughts)

- No implementations found → how to publish one (link to 06 / `publish-workflow`).
- Implementation reachable but a workflow fails validation → the workflow appears with the
  lint error and no Start.
- Run row exists but the definition snapshot is missing (should not happen) → read-only record.
- Run held by another tab → live read-only view with Take over.

## Headless-visible contract

`data-testid`s: `run-status`, `step`, `run-outputs`, `kickoff-form`, `kickoff-start`,
`implementations`, `workflow-list`; `data-state` as in 07. Treated as a contract (Studio
rule): rename in the driver only with a matching harness change.

## Not in v1

Editing YAML in the harness (author in the repo; the harness is read-only over definitions),
a visual workflow builder, multi-user presence cursors, dark-mode-specific assets (theme
tokens only).
