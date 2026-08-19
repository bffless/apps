---
status: accepted
date: 2026-08-19
---
# Redux Toolkit + a pure event-sourced run engine; XState not adopted

The harness must schedule a DAG of jobs (with matrix fan-out, `max-parallel`, poll loops,
steps waiting on people), record every transition server-side, and rebuild a run from those
records (Resume). The question was XState vs Redux; the answer had to be about fit, not
familiarity.

**Decision:** Redux Toolkit + RTK Query for app/server state, and the run engine as a pure,
framework-free module: a reducer over run events (`step.started`, `step.succeeded`, …) with
an explicit per-step transition table, a pure `nextActions(state, definition)` scheduler, and
side effects in one RTK listener. The persisted rows are those events materialised, so Resume
is `rows.reduce(runReducer)`.

**Why not XState (v5):** a single step's lifecycle is a textbook statechart, but a run is a
dynamic tree of N jobs × matrix items — spawned child actors coordinated by an orchestrator
machine (XState's least ergonomic area), and Resume becomes rehydrating an actor tree instead
of replaying rows. Event-sourced reducers are the native shape of "record every transition";
they are also what Studio already uses (RTK), and they keep "state-machine rigor" by making
illegal transitions throw in tests.

**Consequences:** no free statechart visualiser (the transition table is the doc); if one step
kind's lifecycle grows hairy, XState may be adopted inside that adapter without touching the
engine.
