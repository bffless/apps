# Workflow Studio

Workflow Studio re-authors `apps/studio`'s video-cutting pipeline (upload → transcribe →
scene director → per-scene cut editor → export) as a **Workflow-harness implementation** —
see `apps/workflow/CONTEXT.md` for the harness vocabulary (workflow, job, step, island,
script, run). It ships no harness of its own: it deploys to its own alias inside the
`bffless/workflow` project (like `bffless/workflow-hello`) and is discovered the same way.

It reuses `apps/studio`'s pure logic and cut editor as a **workspace dependency** —
`studio/lib/*` and `studio/components/Studio/CutEditor` — rather than forking the source
(see `apps/studio/CLAUDE.md` → "Public surface (consumed by workflow-studio)"). Everything
Studio-specific that isn't pure (the Redux store, the RTK Query API layer, the app shell) is
re-authored here against the harness's step/payload model instead.

## Status

Scaffold only (M3 Task 18): package, tsconfigs, Vite build configs and the empty
`workflow-studio` rule set. No workflow YAML, rules, islands or scripts yet — those land in
Tasks 19–23; the stager/CI/deploy that turn this into a publishable implementation land in
Task 24.
