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
- **Graph**: cards 260px wide, 8px radius, `--line-strong`; single-step job = one 60px row
  (`CHIP.single`), otherwise a 40px header strip (+20px matrix line, +34px item selector) over
  42px rows (`CHIP.row`); definition mode adds 20px `OUT name · type` lines. Geometry constants
  live in `src/components/graph/geometry.ts` and must match the CSS. Connectors are straight
  (`H`) on the same row, one cubic bend across rows. Edge dots: 15px, 2px white ring, in = grey,
  out = ink. Selection: ink ring (`box-shadow: inset 0 0 0 1px`) + `--surface-dim`; the whole
  card's border turns ink. Data-flow hover: solid inset ring on the source, dashed outline on
  targets.
- **The pane under the graph** — one level of the taxonomy at a time. The **run card**
  (`.run-pane`, no step selected: eyebrow `RUN` · workflow name · run id | Input/Output | pill |
  `WORKFLOW`) and the **step pane** (`.step-pane`: job eyebrow · step · key | Input/Output |
  pill | kind) share one shape: header row with the `.segmented` toggle (selected = ink), a body
  of values, then a `.pane-trail`. The step pane's head opens with `.pane-back` (`← Run`); Esc
  and the pressed chip do the same. The selection is the URL (`?step=`).
- **Value**: `.value-head` = label 600 13px + `.chip.value-origin` ("from …" / "goes to …") +
  `.value-tag` (mono type · renderer, right-aligned); body per renderer — file row with the
  striped 34×24 thumbnail slot, table with a mono uppercase head, transcript rows, 16:9 image
  grid, markdown box, code box on paper, JSON tree with hairline guides.
- **Forms**: labels 600 13px, controls 1px `--line` 6px radius 10×12 padding, focus = ink
  border + 1px ring, file inputs dashed, tiles ring on check, submit = primary.
- **Badges** `.badge`: mono 10.5px pill, severity tints the ink and border only.

## Layout

- Shell: sticky 56px top bar (brand dot + name · mono breadcrumb · mono whoami), 15rem sticky
  rail, content padded 30×28. Under 900px the rail stacks above the content and the breadcrumb
  wraps to its own line.
- Page head: title + sub on the left, `.page-actions` on the right, 1px rule beneath.
- Run page: head → one-line run bar (pill · mono progress/elapsed · badges) → graph panel →
  legend → the run card *or* the selected step's pane (full width, below the graph). The run
  card's Output holds the results, then the trail (summary, annotations).
- Lists max out at 1080px; forms at 760px; prose at 70ch.

## Motion

150ms `cubic-bezier(0.22, 1, 0.36, 1)` on hover/selection colour changes; the only animation
is the 1.6s running pulse. `prefers-reduced-motion: reduce` disables all of it.

## Z-index

`--z-sticky: 10` (top bar, rail) · `--z-overlay: 40` (fullscreen island).
