# 09 — State management and the run engine

Decision D10 / ADR-0003: **Redux Toolkit + RTK Query**, with the run engine as a pure,
framework-free module. XState was evaluated and not adopted for v1 (the eval is in the ADR).

## Three kinds of state

| state | where | notes |
|---|---|---|
| Server data — implementations, workflows, runs, step rows, files | **RTK Query** (`workflowApi`) | cache + invalidation; mock-first with MSW like Studio (every `/api/workflow/*` and the discovery fetches have a mock; real and mock go through one `toX()` coercer) |
| The live run — what is running in *this* tab | `lib/runner` state held in a Redux slice `run`, mutated only by the runner's reducer | the same reducer rebuilds state from rows (Resume) |
| UI — the selected step | the run page URL (`?step=<key>`, 08) | linkable; Back climbs out of a step; a navigation to another run drops it |
| UI — hover highlight, theme, filters | Redux slice `ui` + React local state for transient bits | persisted: theme only |

## `lib/runner` — pure, tested, no React

```
lib/runner/
  definition.ts    parse YAML → Definition (validated against workflow.schema.json)
  expressions/     the ${{ }} parser + evaluator (shared with the linter/CLI)
  graph.ts         job DAG: topo order, readiness, matrix expansion
  reducer.ts       (RunState, RunEvent) → RunState      ← the state machine
  transitions.ts   per-step allowed-transition table; illegal transition throws
  next.ts          nextActions(RunState, Definition) → Action[]   (what to start/poll/mount)
  replay.ts        rows → RunEvent[] → RunState        (Resume, read-only views)
  rows.ts          RunEvent → the row writes that persist it (05)
  contexts.ts      the run's `inputs`/`needs`/`steps`/`matrix` scopes, and job outcome
  headless.ts      `headless:` and `timeout-minutes` read off `step.raw`: mode, budgets,
                   and what a `skip` stands in for (`evaluateSkipOutputs`)
  adapters/        pipeline.ts (fetch+poll+retry), island.ts (AppBridge), form.ts, script.ts
```

The wait clock those budgets feed (`store/waitClock.ts`) lives with the side effects, not here:
a step that is `waiting` has no work of its own to hang a timer off, so the timer belongs to
whoever owns the step's lifecycle — the middleware. It measures from the step's recorded
`startedAt`, never from when it was armed, so a run cannot wait forever by being adopted
repeatedly.

- **Events** are the vocabulary in 05 (`run.started`, `step.queued`, `step.started`,
  `step.polling`, `step.waiting`, `step.succeeded`, `step.failed`, `step.skipped`,
  `step.retrying`, `step.cancelled`, `run.finished`, …). Each event is (a) applied by the
  reducer, (b) persisted as one row write — the persisted rows *are* the event log
  materialised, which is why `replay.ts` can rebuild state.
- **Transitions** are explicit: a table `allowed[kind][fromStatus] = Set<toStatus>` guards the
  reducer. This is the "state-machine rigor" without an actor runtime; illegal transitions
  are bugs and throw in tests.
- **Scheduling** is a pure selector: given state + definition, `nextActions` returns which
  jobs are ready (`needs` satisfied, `if` true), which matrix items may start under
  `max-parallel`, which step in each active job is next. Deterministic; exhaustively unit-tested
  with small synthetic definitions (diamond DAG, matrix fan-in, fail-fast, continue-on-error,
  skipped-by-if).
- **Side effects** live in one RTK **listener middleware**: on state change it calls
  `nextActions`, dispatches each action to its adapter, and the adapter emits events back
  through `dispatch`. Adapters are the only code that touches the network/iframes/Workers,
  each behind a small interface so tests use fakes.

## Why not XState (summary; full eval in ADR-0003)

XState's statecharts fit a *single step's* lifecycle well, but a run is a dynamic tree of N
jobs × matrix items; the scheduler becomes an orchestrator of spawned actors (XState's least
ergonomic area), and Resume means rehydrating an actor tree instead of replaying rows. The
event-sourced reducer is the native shape of both "record every transition" (05) and Redux.
If one step kind's lifecycle grows hairy (islands with multi-phase handshakes), XState can be
adopted *inside that adapter* without touching the engine.

## The linter shares the engine

`@bffless/workflow-lint` (bin `workflow`: `workflow lint <file…>`, and `workflow index` — the
publish step `bffless/publish-workflow` runs) = `definition.ts` + schema + expression parse +
static checks (upstream references only, unknown `render`, interactive steps without `headless`,
`file` refs passed whole into bodies, absolute paths into another implementation's API,
`headless: skip` missing a value for a referenced output, and `rule-missing` — every relative
`with.path`/`poll.path` held to the rule directory that serves it, when the rule set is
visible). No React, no network — runs in CI and in the harness's "View workflow file" screen
alike.

## Testing stance

- `lib/runner` is the bulk of the unit tests (reducer, transitions, next, replay, expressions).
- Adapters are tested against MSW + fake AppBridge/Worker.
- One Playwright smoke per milestone drives the real harness against the `hello`
  implementation (mock-backed), and from M3 the headless CLI *is* the e2e.
