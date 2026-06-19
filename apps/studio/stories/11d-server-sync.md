# 11d — Server-side project sync

> Read `00-architecture-and-state.md` first. This is the **final** story of the
> `studio/projects` initiative (11a–11d): 11a introduced the keyed project
> collection; 11b made projects deep-linkable; 11c nested every upload under a
> per-project GCS prefix; 11d makes the **server** the durable home for the
> project records themselves.
> Design: `docs/superpowers/specs/2026-06-16-studio-server-sync-design.md`.
> Plan: `docs/superpowers/plans/2026-06-16-studio-server-sync.md`.

**Status:** ✅ shipped (2026-06-16, branch `studio/projects`, live-verified).

## Why

Through 11a–11c projects were first-class, deep-linkable, and stored their
assets under a per-project bucket prefix — but the **project records themselves
lived only in localStorage**. That meant: clearing the browser (or using a
different one) lost every project; there was no cross-device access; and the
whole index competed for the browser's ~5 MB localStorage budget. 11d makes the
server the durable home for projects so they survive a cleared browser and follow
the user across devices, while the active project still works fast against local
state.

## What shipped

**New `studio_projects` data-table schema** (`d183deed-…`, rule set `studio`)
plus the CRUD rules that operate on it:

| Route | Method | Rule id | Does |
|-------|--------|---------|------|
| `/api/projects` | POST | `25fc934e` | **create** a record |
| `/api/projects` | GET | `d48bca6d` | **list** (metadata only — **no `data` field**) |
| `/api/projects/get?id=` | GET | `9f8c5a94` | **get one** (parses `data` string → object) |
| `/api/projects/save` | POST | `1b510d2d` | **save/update** (last-write-wins) |
| `/api/projects/delete` | POST | `67359cca` | **delete** — extended from 11c to also `data_delete` the record (was bucket-prefix-only) |

Key server contract details, learned live:

- **Records are addressed by a `projectId` field FILTER**, not by the table's row
  id — the client's project id is a column we filter on, never the primary key.
- **Timestamps are stored as `createdMs` / `updatedMs`** columns to avoid a
  collision with the table's own row-level `createdAt`/`updatedAt`; the rules map
  them back to `createdAt`/`updatedAt` in the response so the client shape is
  stable.
- `list` deliberately omits the heavy `data` blob; `get` returns it parsed to an
  object. Both `data` string (on write) and `data` object (on read) are handled.

**Pure sync core — `src/lib/projectSync.ts`.** Reconcile logic (merge the server
index with whatever is local, last-write-wins by `updatedAt`, never clean-slate —
local-only projects get **pushed up**, not dropped) plus the record round-trip
helpers (project ↔ server record, `data` as string|object). Unit-tested next to
source.

**Slice actions** (`src/store/studioSlice.ts`): `hydrateProject` (drop a fetched
project into `working`), `evictWorking`, `evictOthers` (keep only the active
project's heavy working state local), and `reconcileServerIndex` (fold the server
list into the local index).

**RTK Query CRUD endpoints** (`src/store/studioApi.ts`) for create/list/get/save/
delete, with matching **MSW mocks** (`src/mocks/handlers.ts`) returning the
identical shape (list = no `data`; get = parsed `data`).

**`useProjectAutosave`** — debounced save of the active project, **flush-on-exit**
(pagehide/unmount), and **evict-others-on-mount** so only the active project's
working state stays resident. StrictMode-safe (no double-fire / no dispatch in a
setState updater).

**List + guard wiring.** The Projects list loads from the server and reconciles
into the local index; create writes the record to the server; the
`StudioProjectGuard` **hydrates the opened project from the server (or redirects)**
before the workspace mounts; a save-status indicator surfaces autosave state.

**Sync model (resolved):** server is home; only the **active** project is held
locally in full; **last-write-wins by `updatedAt`**; **no clean-slate** (local-only
projects are pushed up); no offline queue beyond keep-local-and-retry.

## Scope guard — NOT in 11d

- **Unscoped (no per-user) until story 07.** The CRUD routes — especially the
  destructive `save`/`delete`/create paths — are flagged for `auth_required`
  restoration in story 07 (same deferral as the rest of the studio pipeline).
  Don't "fix" the open auth early.
- **`savedVoices` stays local** — the shared voice library is not synced in 11d.
- **Last-write-wins only** — no real-time merge / CRDT / conflict UI.
- **No offline queue** beyond keep-the-project-local and retry the save.

## File / rule map

### Client

| File | Change |
|------|--------|
| `src/lib/projectSync.ts` | **New** — pure reconcile (last-write-wins, push-up local-only) + project↔record round-trip (`data` string\|object) |
| `src/store/studioSlice.ts` | `hydrateProject` · `evictWorking` · `evictOthers` · `reconcileServerIndex` |
| `src/store/studioApi.ts` | RTK CRUD endpoints: create / list / get / save / delete |
| `src/components/Studio/useProjectAutosave.ts` | **New** — debounced save · flush-on-exit · evict-others-on-mount (StrictMode-safe) |
| `src/components/Studio/StudioProjects.tsx` | List loads from server + reconciles; create writes server record |
| `src/components/Studio/StudioProjectGuard.tsx` | Hydrate-on-open from server (or redirect) before workspace mounts |
| `src/mocks/handlers.ts` | MSW mocks for all five CRUD routes (list = no `data`, get = parsed `data`) |

### BFFless rules (rule set `studio`)

| Rule id | Route | Change |
|---------|-------|--------|
| `d183deed-…` | — | **New** `studio_projects` data-table schema (`createdMs`/`updatedMs` cols; `projectId` filter column) |
| `25fc934e` | POST `/api/projects` | **New** — create record |
| `d48bca6d` | GET `/api/projects` | **New** — list (metadata only, no `data`) |
| `9f8c5a94` | GET `/api/projects/get?id=` | **New** — get one (parse `data` → object) |
| `1b510d2d` | POST `/api/projects/save` | **New** — save/update (last-write-wins) |
| `67359cca` | POST `/api/projects/delete` | **Extended (from 11c)** — now also `data_delete`s the record, not just the bucket prefix |
