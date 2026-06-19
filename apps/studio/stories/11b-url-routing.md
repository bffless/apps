# 11b — URL-driven routing

> Read `00-architecture-and-state.md` first. This is the 2nd story of the
> `studio/projects` initiative (11a–11d): 11a introduced the keyed project
> collection; 11b makes every project + phase deep-linkable; 11c migrates GCS
> paths; 11d adds server persistence.
> Design: `docs/superpowers/specs/2026-06-16-studio-url-routing-design.md`.
> Plan: `docs/superpowers/plans/2026-06-16-studio-url-routing.md`.

**Status:** ✅ shipped (2026-06-16, branch `studio/projects`).

## Why

After 11a, project selection and the active phase lived exclusively in Redux
(`activeProjectId`, `revisitPrep`, `inExport`). That meant:

- No deep links — you couldn't share or bookmark a specific project in a specific
  phase.
- Back/Forward did nothing — the browser saw a single-page app with one URL; navigating
  between projects or phases left no history entries.
- Reload dropped context — refreshing "Build of project X" landed on the project list
  with no way to restore where you were.

## What shipped

**URL scheme.** Three routes cover the whole workspace:

| URL | Purpose |
|-----|---------|
| `/studio` | Project list (landing page) |
| `/studio/project/:id` | Redirect to the resumable phase for that project |
| `/studio/project/:id/:phase` | Workspace (`phase` ∈ `prep` \| `build` \| `export`) |

**`StudioProjectGuard`.** A wrapper component that sits between the router and
`Studio.tsx` and handles three concerns in one render cycle:

- *Unknown-id redirect* — if `:id` is not in the Redux `working` collection, redirect
  immediately to `/studio` (the project list), preventing a blank workspace.
- *Active-sync effect* — dispatches `openProject(id)` to keep `activeProjectId` in
  sync with the URL. A one-render gate prevents the workspace from mounting before
  the slice is consistent.
- *Phase clamp / resume* — calls `resolvePhase(working, phase)` (see below) and redirects
  if the requested phase is ahead of what the project has unlocked.

**`resolvePhase` / `maxPhaseFor` in `src/lib/studioRoute.ts`.** Two small pure
helpers that reuse `phaseOf` from `src/lib/projects.ts` (the same function that
drives the metadata middleware):

- `maxPhaseFor(project)` — returns the furthest phase the project has reached.
- `resolvePhase(project, requested)` — clamps `requested` to `maxPhaseFor`; if
  `requested` is undefined (bare `/studio/project/:id`), resolves to the furthest
  reached phase, falling back to `'prep'`.

**Workspace keyed by `projectId`.** The guard renders `<Studio key={projectId} … />`.
React remounts the workspace whenever the active project changes, resetting all transient
clip state (`useState`, object URLs, in-memory `File` handles) without any explicit cleanup.

**`revisitPrep` / `inExport` removed.** These Redux flags had driven phase navigation
via dispatch. They are replaced entirely by `navigate()` calls that update the URL,
which the guard then reads on the next render. The slice no longer carries any phase
flag.

**`Studio.tsx` takes `{projectId, phase}` props.** Phase navigation inside the workspace
is now `navigate(\`/studio/project/${projectId}/${nextPhase}\`)` — no Redux dispatch
needed for phase transitions.

**`StudioProjects.tsx`.** A standalone list-page component (was previously inlined).
Rendered at `/studio` when no project is selected; clicking a card navigates to
`/studio/project/:id`.

## Scope guard — NOT in 11b

- **No GCS changes** — bucket paths are unchanged; per-project prefixes come in 11c.
- **No server sync** — projects still live in localStorage only (11d).
- **`activeProjectId` stays in Redux** — the guard syncs it from the URL on mount;
  the slice's `active()` write-routing depends on it and is intentionally left in
  place. It is not removed until (at minimum) 11d.

## File map

| File | Change |
|------|--------|
| `src/lib/studioRoute.ts` | **New** — `maxPhaseFor`, `resolvePhase` (pure helpers, reuse `phaseOf`) |
| `src/pages/StudioProjects.tsx` | **New** — standalone `/studio` list page |
| `src/pages/StudioProjectGuard.tsx` | **New** — unknown-id redirect · active-sync effect + gate · phase clamp/resume |
| `src/App.tsx` | Route tree updated: `/studio` → `StudioProjects`; `/studio/project/:id` and `/studio/project/:id/:phase` → `StudioProjectGuard` → `Studio` |
| `src/pages/Studio.tsx` | Now accepts `{projectId, phase}` props; phase nav via `navigate()`; `← Projects` links to `/studio` |
| `src/store/studioSlice.ts` | `revisitPrep` and `inExport` fields + reducers removed |
