# Workflow — product context

## Register

product

## Target users

Project members of a BFFless instance who start, watch and inspect runs of workflows an
implementation repo published: the person who recorded the footage, the teammate checking why a
run stopped, the operator re-running last week's job with one input changed. Mostly technical,
often mid-task, rarely here for its own sake.

## Product purpose

A browser-driven workflow runner (GitHub-Actions-shaped, but the runner is the page). The
harness renders a workflow as a graph, drives its pipelines, pauses on the steps that need a
person, and keeps every run as a durable, resumable record. The UI exists to answer three
questions fast: *where is the run*, *what went into this step*, *what came out of it*.

## Brand personality

Quiet, exact, trustworthy. Reads like a well-kept lab notebook, not a dashboard: near-black ink
on off-white paper, hairlines instead of shadows, mono type for anything that is an identifier
or a measurement (ids, durations, sizes, timestamps), one weight of sans for everything a person
reads. Status is carried by a single small glyph — green ✓, red ✕, an amber pulse — never by
washes of colour. Cool-tinted neutrals (hue 265) throughout; no brand accent competes with
status. Source of truth: the Claude Design prototype "Workflow Graph A" (bffless-workflow-builder-ui).

## Anti-references

- The violet-accent SaaS default the first harness shipped with (accent used for selection,
  links and buttons alike).
- GitHub Actions' own run page density — the prototype is airier and names payloads, not jobs.
- Node-editor chrome (n8n / Zapier): draggable canvases, coloured ports, bezier spaghetti. The
  graph here is derived from `needs`, laid out left→right, drawn with straight connectors.
- Cream/parchment "editorial" warmth. Paper here is cool and near-white, not beige.

## Strategic design principles

1. **The tool disappears into the task.** Familiar affordances (buttons, tabs, tables); no
   invented controls. Selection is a hairline ring and a tint, not a colour.
2. **Identifiers are mono, prose is sans.** If a person would copy it, it is mono; if they read
   it, it is sans. Durations, run ids, paths, sizes and timestamps are always mono.
3. **Status is a glyph, not a wash.** One 15px circle per step/run carries ✓ / ✕ / pulse / ring.
   Nothing else in the UI is green, red or amber.
4. **Payloads are the unit of inspection.** Every step pane is *Input | Output*; every value
   says where it came from (`from …`) and where it goes (`goes to …`).
5. **Derived layout, never measured.** The graph's geometry is a function of the definition so it
   renders identically in jsdom, headless Chromium and a person's browser.
6. **Contracts stay put.** `data-testid`, `data-state` and `data-key` are the headless driver's
   API; visual passes restyle around them.

## Accessibility & Inclusion

WCAG 2.1 AA as the floor: body text ≥ 4.5:1 (muted ink is `oklch(0.5 …)`, not lighter), every
status glyph carries an `aria-label`, focus rings are visible on every control, the running
pulse respects `prefers-reduced-motion`, and the graph is keyboard-reachable (every step is a
`<button>`). Colour is never the only carrier of state — the glyph shape and `data-state`
always accompany it.
