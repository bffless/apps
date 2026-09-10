# Workflow — design system

The harness's visual system, as shipped in `src/index.css` after the 2026-08-26 visual pass
(matched to the Claude Design prototype "Workflow Graph A"). PRODUCT.md holds the *why*; this
file holds the *what*. Tokens are OKLCH; every value below is the one in `:root`.

## Visual theme

Quiet lab-notebook: near-black ink on cool off-white paper, hairlines instead of shadows, one
sans for prose and one mono for anything a person would copy. Status is the only colour.
Light only (`color-scheme: light`); dark mode is out of scope (08 "Not in v1").

## Color

| Token | Value | Use |
|---|---|---|
| `--paper` | `oklch(0.975 0.006 265)` | page background |
| `--surface` | `oklch(1 0 0)` | panels, cards, the top bar |
| `--surface-dim` | `oklch(0.968 0.006 265)` | card header strips, table heads, selected rows |
| `--surface-tint` | `oklch(0.99 0.012 90)` | the running step's warm wash (prototype) |
| `--rail` | `oklch(0.94 0.009 265)` | the rail's own column (1.11:1 off paper) |
| `--line-strong` / `--line` | `oklch(0.86 / 0.88 0.008 265)` | card / panel borders |
| `--hairline` / `--hairline-faint` | `oklch(0.94 / 0.95 0.006 265)` | row separators |
| `--edge` | `oklch(0.82 0.01 265)` | graph connectors (1.5px) |
| `--ink` | `oklch(0.17 0.015 265)` | text, primary buttons, out-dots, selection rings |
| `--ink-2` / `--ink-soft` | `oklch(0.3 / 0.4 0.012 265)` | body prose, secondary text |
| `--ink-mute` | `oklch(0.5 0.012 265)` | mono metadata (≥ 4.5:1 on paper) |
| `--ink-faint` | `oklch(0.58 0.012 265)` | de-emphasised *states* only (queued rows) |
| `--ok` / `--busy` / `--bad` | `oklch(0.58 0.12 150)` / `oklch(0.72 0.15 70)` / `oklch(0.55 0.17 25)` | status glyphs |
| `--bad-ink` / `--warn-ink` | `oklch(0.45 0.17 25)` / `oklch(0.5 0.13 70)` | severity text and borders |
| `--idle` | `oklch(0.85 0.01 265)` | the hollow ring of a step not reached |
| `--dot-in` / `--dot-out` | `oklch(0.62 0.012 265)` / `--ink` | graph edge dots |

Rule: nothing outside `.glyph`, `.badge[data-severity]`, `.step-error`, `.banner`, `.lint` and
`.field-error` uses `--ok`/`--busy`/`--bad`. No accent colour exists.

## Typography

- `--font-sans`: **Public Sans** 400/500/600/700 (Google Fonts, system-ui fallback) — prose,
  labels, buttons, headings.
- `--font-mono`: **Roboto Mono** 400/500 (ui-monospace fallback) — ids, durations, sizes,
  timestamps, paths, breadcrumbs, table heads, eyebrows, JSON, code, YAML.
- Fixed rem/px scale: body 14 · sub 14.5 · row title 15 · pane title 15.5 · section 15 ·
  page title 28 (700, −0.02em) · file title 22 mono. Mono metadata 11–12, eyebrows 10 tracked
  0.1em uppercase.
- Headings `text-wrap: balance`; markdown prose `text-wrap: pretty`, max 70ch.

## Components

- **Buttons** `.button` (hairline), `.button.primary` (ink fill), `.button.danger` (red ink):
  6px radius, 600 13px, 8×14 padding. Links that act as actions carry the same classes.
- **Status glyph** `.glyph[data-state]`: 15px circle — ✓ green, ✕ red, `–` grey (skipped),
  amber pulse (running/polling), amber ring pulse (waiting), grey ring (queued/declared).
  `.pill` = glyph + word. `data-state` is the headless contract; never restyle it away.
- **Panel** `.panel` / `.cards` / `.rows` / `.step-pane` / `.graph-scroll`: white, 1px
  `--line`, 10px radius. Rows inside separate with `--hairline`, hover to `--paper`.
- **Graph**: cards 260px wide, 8px radius, `--line-strong`; every job is one node (`.job-card`,
  a button — the job is the middle level of run › job › step, so it is one keyboard target with
  one pressed state, `aria-pressed`): a 40px header strip (job name, plus a `MATRIX · <id>`
  eyebrow for a matrix job) with a 20px note line under it for the matrix's strategy, over a
  42px status row — run mode's glyph, status word (or `N of M done` for a matrix job) and a mono
  duration; definition mode's step count instead. Definition mode adds one 20px `OUT name ·
  type` line per declared job output, plus 8px pad under the last one. Geometry constants live
  in `src/components/graph/geometry.ts` and must match the CSS. Connectors are straight (`H`) on
  the same row, one cubic bend across rows. Edge dots: 15px, 2px white ring, in = grey, out =
  ink — the left one opens the job on Input, the right on Output. Selection: `aria-pressed`'s
  ink ring (`box-shadow: inset 0 0 0 1px`) over an ink border. Data-flow hover, at job
  granularity (Task 8): a solid ring on the source job, a dashed outline on every job that reads
  the value; `:focus-visible` draws its own 2px ring, outranking both.
- **The job page** — the levels of the taxonomy are **routes**: **run › job › step**. The
  Summary keeps the **run card** (`.run-pane`: `RUN` · workflow name · run id
  | Input/Output | pill | `WORKFLOW`) under the graph. A job is its own page (`.job-page`, a
  16px column):
  - **Job head** (`.job-page > .job-head`: a wrapping row on `--surface` in a card border) —
    `.job-eyebrow` `RUN › JOB` (mono 11px, uppercase, every segment above the current one a
    `.pane-crumb` way up), the job's name 600, its id in `.pane-key` mono, the pill, the mono
    duration, the matrix note, then `.job-head-actions` on the right: **Re-run from this job**
    when the run can be forked there, and **YAML**.
  - **Job inputs** (`.job-io`) — what the job waited on, folded into a `<details>`: a 12×20
    `summary`, then the `.job-io-toolbar` (Show raw) over a body of value rows. The
    Input/Output `.segmented` toggle went with the outputs (2026-09-09 review).
  - **Job output** (`.job-output`) — the job's own outputs, a `.section-title` over a
    `.job-output-card` (`--surface`, card border, 12/20/14 pad) holding the `.values-bar` and
    the value rows, **after** the step rows: a job's result comes after the work that produced
    it. Reached by an out-dot's `?tab=Output`, which opens its rows. The title sits on
    `--paper`; its contents never do (2026-09-10 review) — on this page only a heading is
    allowed to touch the page.
  - **Step rows** (`.step-list` / `.step-row`) — one card-bordered list, hairline between rows.
    The head is a full-width button (glyph · label + mono id · kind word · `attempt n` ·
    right-aligned mono duration · chevron), tinted by `data-state` and ringed by
    `data-flow`; open, it goes ink-on-`--surface-dim` and the `.step-row-body` unfolds beneath
    it — the step pane without its card head: a `.step-toolbar` (Input/Output, Show raw, YAML,
    pill, kind), the values, then a `.pane-trail`. The row itself is the step's identity, so
    the body carries no crumb, name or key.
  - A waiting `form` or a live `island` **is** the row's body (`.form-step-pane` /
    `.island-step-pane`). An island that declared `display: fullscreen` offers `.island-expand`;
    the overlay is the shell's — `.island-fullscreen` fixes the run canvas over the viewport at
    `--z-overlay` and puts the `.island-strip` in the content's place, its crumb reading
    `Run › <job> › <step>` (the first two a way up) over the step's key in mono, with **Exit
    fullscreen** `Esc` on the right. Under the strip the overlay holds that one row and nothing
    else: the job head, the `.job-io` disclosure and every sibling row are hidden, and every box
    from the canvas down to the iframe grows, so the island fills the screen. Nothing is
    unmounted — the row and its iframe are the same elements on both sides of the mode.
  - Esc layers: inside an open row's body it collapses that row — unless a live form or island
    holds it, where the row is the person's to resolve and Esc belongs to the body (fullscreen
    spends it on **Exit fullscreen**); on a job page with nothing open it goes up to the
    Summary, and on the Summary it does nothing. The whole graph node
    is the button onto the job page (pressed = ink ring, above); the edge dots open it on
    Input / Output.
  - **Declared rows** (the workflow page) are the same `.step-list` / `.step-row`, read off
    the file: `.step-kind`'s glyph in the status glyph's place, the `headless: …` `.badge`,
    and a `.step-body.declared-body` — `Inputs`, `Outputs` as `.step-outs` `OUT` lines, and a
    closed `.declaration-details`. Having no `.step-toolbar` or `.pane-body` to supply the run
    body's inset, it carries its own — `padding: 0 20px 24px`, the top left to
    `.section-title`'s `margin: 24px 0 10px`, which already sets `Inputs` off from the row
    head. Its `.job-head` prints four things and no more: the name, the id, the kind and the
    matrix note.
- **Value**: two shapes. On its own, `.value-head` = label 600 13px + `.chip.value-origin`
  ("from …" / "goes to …") + `.value-tag` (mono type · renderer, right-aligned). In a pane that
  lists several, a **row** (`.value-row`, a `<details>` closed by default — 2026-09-09 review):
  `.value-row-head` = `.value-chevron` + label + `.value-brief` (what the value *is*:
  `video/mp4 · 268.7 MB`, `8,681 items`, `3 keys`, or the string on one line to 80 chars) +
  `.value-tag`; open, `.value-row-body` carries the origin chips, the `.value-raw` switch and
  the body. Rows separate with a hairline and no gutter; a closed row's body needs no help to
  cost nothing — `<details>` lays its own contents out at zero size — so it keeps its padding
  and stays findable by find-in-page. `valueSummary`/`isBulky` decide the text and whether a value
  folds at all — an island never does, nor anything the closed row already prints in full.
  Above a list of rows, `.values-bar` = mono count + `.values-expand` (Expand all / Collapse
  all), and it renders nothing when none of the values fold.
  Body per renderer — file row with the striped 34×24 thumbnail slot, table with a mono
  uppercase head, transcript rows, 16:9 image grid, markdown box, code box on paper, JSON tree
  with hairline guides.
- **The raw switch** (`.value-raw`): a mono two-segment control, `Rendered ∣ JSON`, where the
  **filled segment is the view on screen** — the rule `Input`/`Output` follows. It was one
  button labelled with its destination but filled by its state, which read backwards.
- **Forms**: labels 600 13px, controls 1px `--line` 6px radius 10×12 padding, focus = ink
  border + 1px ring, file inputs dashed, tiles ring on check, submit = primary.
- **Badges** `.badge`: mono 10.5px pill, severity tints the ink and border only.

## Layout

- Shell: sticky 56px top bar (brand dot + name · mono breadcrumb · mono whoami), 16rem sticky
  rail on its own `--rail` column with a `--line` right edge, content padded 30×28. The column
  is painted by a gradient on `.shell-body`, not a background on `.rail`: the rail is sticky
  and only as tall as its rows, so a background on it would stop partway down a long page.
  Under 900px it stacks and paints itself. Outside a run the rail is the implementation tree
  (`IMPLEMENTATIONS` eyebrow; each implementation a 600 group head, its workflows as 32px rows
  with the latest run's 11px glyph); inside one it is the **run rail** (`.run-rail`) in its
  place, never both — a mono `← Workflow`, then `.rail-row`s (11px glyph · name · mono meta,
  32px) for Summary, the `JOBS` list (a matrix job a `.rail-matrix` head with a chevron over
  its 18px-indented `.rail-items`) and `RUN DETAILS`. The open row in either = white + hairline
  ring (`.rail-row.active`). Under 900px the rail stacks above the content and the breadcrumb
  wraps to its own line.
- Page head: title + sub on the left, `.page-actions` on the right, 1px rule beneath.
- Run pages: head → one-line run bar (pill · mono progress/elapsed · badges · Follow run) →
  the page. The **Summary** is the jobs-only graph panel → legend → the run card, whose Output
  holds the results, then the trail — the Annotations disclosure, then one summary section per
  job. A **job page** is the job head → the job inputs/outputs disclosure → the step rows (a
  matrix collect view: the item rows instead), full width, no graph.
- The **workflow page** is the definition graph → the picked job's head and declared rows →
  Recent runs. No legend (the edge dots' meaning is a run's), and no side panel.
- Lists max out at 1080px; forms at 760px; prose at 70ch.

## Motion

150ms `cubic-bezier(0.22, 1, 0.36, 1)` on hover/selection colour changes; the only animation
is the 1.6s running pulse. `prefers-reduced-motion: reduce` disables all of it.

## Z-index

`--z-sticky: 10` (top bar, rail) · `--z-overlay: 40` (fullscreen island).
