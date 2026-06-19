# 11a — Projects as a first-class entity

> Read `00-architecture-and-state.md` first. This is the first story of the
> `studio/projects` initiative (11a–11d): 11a introduces the keyed project
> collection; 11b adds URL routing; 11c migrates GCS paths; 11d adds server
> persistence. The ID minted here is the stable anchor every downstream story
> hangs off.
> Design: `docs/superpowers/specs/2026-06-15-studio-projects-entity-design.md`.
> Plan: `docs/superpowers/plans/2026-06-15-studio-projects-entity.md`.

**Status:** ✅ shipped (2026-06-15, branch `studio/projects`).

## Why

`/studio` was one-and-done: "Start over" wiped the only project and there was no
way to keep or revisit past work. Every pipeline run, voice clone, and assembled
scene was ephemeral once a new recording was imported. Projects make each recording
its own durable, named entity — and give the stable `projectId` (a client-minted
UUID) that 11b (URL routing), 11c (GCS per-project storage layout), and 11d (server
sync) all hang off.

## What shipped

**Keyed slice shape.** The Redux `studio` slice was restructured from a flat bag of
fields into a normalized collection:

```ts
{
  index:           Record<string, ProjectMeta>,  // denormalized metadata for the list
  working:         Record<string, StudioProject>, // full project state keyed by id
  activeProjectId: string | null,
  savedVoices:     SavedVoice[],                 // hoisted from per-project to shared library
}
```

**Client-minted UUIDs.** Each project gets an `id` at creation time via
`crypto.randomUUID()` (pure client, no server round-trip). All downstream stories
can treat this as stable.

**`active(state)` helper.** A one-line selector re-points all existing reducers to
`state.working[state.activeProjectId]` — every reducer that previously wrote to
`state.someField` now writes to `active(state).someField`. Dispatch sites in
`useScenePipeline.ts`, `useAutoBuild.ts`, and the rest of the codebase are
unchanged.

**Project-management reducers.** `createProject` (mints id, sets as active),
`openProject` (sets `activeProjectId`), `renameProject`, `deleteProject` (removes
from both `working` and `index`). Deleting a project orphans its bucket assets for
now — GCS cleanup is deferred to 11c.

**`projectMetaSync` middleware.** A Redux middleware (not a reducer) listens for
every action and, after dispatch, derives a lightweight `ProjectMeta`
(`{ id, name, phase, thumbnailUrl, updatedAt }`) from the active project's slice
and writes it to `index[id]`. The list view never has to read deep project state.

**Selectors.** `selectActive` returns the active working state, or a stable
`EMPTY_WORKING` (a frozen empty reference) when no project is open — never `null`;
`selectProjectList` returns `Object.values(index)` sorted by `updatedAt` descending.

**`ProjectList` / `ProjectCard` UI.** A landing page that renders when no project
is active. Each card shows the project name, phase badge, thumbnail, and last-edited
time. Inline rename (double-click / pencil icon), delete (with confirm prompt), and
a prominent **+ New project** button. `Studio.tsx` branches on `activeProjectId`:
null → `<ProjectList>`, non-null → the existing workspace, with a `← Projects` nav
link that clears `activeProjectId`.

**`savedVoices` hoisted.** Previously each project carried its own `savedVoices`
array. It is now a top-level field on the slice, shared across all projects — a
cloned voice remains available for any new project without re-cloning.

**Clean-slate persist key bump.** The redux-persist key changed from `studio` to
`studio-projects`. Old localStorage state (the flat single-project shape) is
discarded on first load — no migration, by design. Projects are local-only until
11d; a hard reset is acceptable at this stage.

## Scope guard — NOT in 11a

- **No URL changes** — active project is still slice-only state; deep-linking and
  browser history are 11b.
- **No GCS path changes** — all bucket paths remain as before; deleting a project
  orphans its bucket assets (11c will introduce per-project prefixes and add a
  cleanup step).
- **No server sync** — all projects live in localStorage only (11d).
- **No Duplicate action** — copy-a-project is not in scope for this story.

## File map

| File | Change |
|------|--------|
| `src/lib/projects.ts` | `ProjectMeta` type, `phaseOf` / `deriveProjectMeta` / `nextUntitledName` / `DEFAULT_PROJECT_NAME` (no ID minting — `crypto.randomUUID()` happens in the page/reducer) |
| `src/store/studioSlice.ts` | Restructured state shape; `active()` helper; all project-management + existing reducers updated; `selectActive`, `selectProjectList` |
| `src/store/projectMetaSync.ts` | Redux middleware — derives + writes `ProjectMeta` to `index` after every action |
| `src/store/index.ts` | Middleware wired; persist key bumped to `studio-projects` |
| `src/components/Studio/ProjectList.tsx` | Landing page (sorted card grid, + New project) |
| `src/components/Studio/ProjectCard.tsx` | Card (name, phase badge, thumbnail, timestamp, rename, delete) |
| `src/pages/Studio.tsx` | Branch on `activeProjectId`; mounts `ProjectList` or workspace; `← Projects` nav |
| `src/components/Studio/useScenePipeline.ts` | Reads `selectActive`; dispatch sites unchanged |
| `src/components/Studio/useAutoBuild.ts` | Reads `selectActive`; dispatch sites unchanged |
