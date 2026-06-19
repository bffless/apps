# 11c — Per-project GCS storage

> Read `00-architecture-and-state.md` first. This is the 3rd story of the
> `studio/projects` initiative (11a–11d): 11a introduced the keyed project
> collection; 11b made projects deep-linkable; 11c nests every upload under a
> per-project GCS prefix; 11d adds server persistence.
> Design: `docs/superpowers/specs/2026-06-16-studio-per-project-storage-design.md`.
> Plan: `docs/superpowers/plans/2026-06-16-studio-per-project-storage.md`.
> Part B depends on the CE `file_delete` handler:
> `docs/superpowers/specs/2026-06-16-bffless-ce-file-delete-handler.md`.

**Status:** Part A ✅ shipped (2026-06-16, branch `studio/projects`, live-verified);
Part B ✅ shipped (2026-06-16, live-verified).

## Why

Before 11c every upload landed in a flat per-type bucket tree:
`<type>/<date>/<uuid>-<file>`. Assets from different projects were interleaved in
the same folders. There was no way to list, audit, or remove a whole project's
objects in one operation — deleting a project left orphaned blobs scattered across
every upload type.

## What shipped (Part A)

**New layout.** Every studio upload now nests under:

```
uploads/projects/<projectId>/<type>/<date>/<uuid>-<file>
```

`projectId` is the existing 11a UUID — no new identifier. Per-object uniqueness
within the prefix is preserved by the handler's own uuid+filename.

**Dynamic `subDir` on all pipeline rules** (enabled by BFFless CE release
`bffless/ce#324`, which made `subDir` accept `{{...}}` interpolation). The six
prepare rules and six register rules covering every upload type now carry:

```
subDir: "projects/{{request.body.projectId}}/<type>"
```

The narrate rule's `file_upload` step likewise uses the interpolated subDir.

**Upload types covered:**

| Type | prepare rule | register rule |
|------|-------------|---------------|
| `source` | existing | existing |
| `audio` | existing | existing |
| `thumbnails` | existing | existing |
| `voice` | existing | existing |
| `export` | existing | existing |
| `scene-clip` | existing | existing |
| `narrate` | — | `file_upload` step on the narrate rule |

**New serve rule.** `GET /api/uploads/projects/*` (id `30355b6d`, `file_serve
{ subDir: "projects" }`) serves the nested keys. Signed-download requests
(`/api/uploads/sign`) already work because they operate on the raw bucket path
returned by register.

**Client threading.** `presignedUpload(file, basePath, projectId)` in
`src/lib/upload.ts` forwards `projectId` in both the prepare and register request
bodies. The `upload` and `narrate` RTK Query mutations in `src/store/studioApi.ts`
accept and pass it through. `useScenePipeline.ts` injects the active project id via
thin wrapper calls — existing call sites are unchanged.

**MSW mocks** (`src/mocks/handlers.ts`) updated to nest mock assets under
`projects/<id>/` and serve them back from the same path, keeping mock and real
shapes identical.

## What shipped (Part B)

**New `POST /api/projects/delete` rule** (id `67359cca-d1bc-48ab-9330-7ffca633069f`,
rule set `studio`). A `function_handler` step builds
`prefix = "projects/<projectId>/"` and throws `"projectId required"` if the id is
empty or missing (guards against a mass-delete of the entire bucket). A
`file_delete { prefix: {{steps.prep.prefix}} }` step then removes every object
under that prefix atomically. A final response step returns `{ deleted, prefix }`.
Validators are intentionally off — flagged for `auth_required` restoration in
story 07 (same as Part A rules).

**App wiring.** `deleteProjectAssets` RTK mutation in `src/store/studioApi.ts`
posts `{ projectId }` to `api/projects/delete`. `StudioProjects.onDelete` (in
`src/components/Studio/StudioProjects.tsx`) calls it best-effort (errors are
swallowed), then dispatches the local `deleteProject(id)` slice action regardless
— so the UI removes the project instantly whether or not the bucket sweep
succeeds. The confirm() gate remains in `ProjectCard` (unchanged). MSW mock added
to `src/mocks/handlers.ts` returning `{ deleted: 1, prefix: "projects/<id>/" }`.

**Live verification.** Uploaded an object under `projects/deltest/…`, then
`POST /api/projects/delete { "projectId": "deltest" }` returned
`{ deleted: 1, prefix: "projects/deltest/" }` and the object was gone (GCS 403 on
direct access). Re-deleting the same prefix returned `{ deleted: 0 }` (idempotent).
Empty `projectId` body returned `"projectId required"` (no mass-delete possible).

**Cloudflare-cache caveat.** The `GET /api/uploads/projects/*` serve rule fronts
a Cloudflare cache. A deleted object's serve URL may briefly return a cached 200
from the edge until that cache entry expires — authoritative state is the
deletion in GCS. This does not affect the app: the project is removed locally
immediately and the bucket objects will not be re-requested.

## Scope guard — NOT in 11c Part A (and some not in 11c at all)

- **No per-object shape change** — the `attachment_url` / `audio_url` / etc. fields
  returned by register are unchanged; they now just carry the `projects/…` prefix.
- **No migration** — 11a bumped the persist key (clean-slate); any pre-11c
  date-bucketed objects are orphaned in the bucket and untouched. No backfill needed.
- **`contact-attachments`** (`/api/uploads/contact-attachments`) is a non-studio
  route and is intentionally untouched.
- **Validators still off** (story 07). All Part A + B routes (including the
  destructive project-delete) are flagged for `auth_required` restoration in story
  07; don't "fix" it early.
- **Server-side project record sync** is story 11d — projects still live in
  localStorage only.

## File / rule map

### Client — Part A

| File | Change |
|------|--------|
| `src/lib/upload.ts` | `presignedUpload` gains `projectId` param; sends it in prepare + register bodies |
| `src/store/studioApi.ts` | `upload` + `narrate` mutations accept + forward `projectId` |
| `src/components/Studio/useScenePipeline.ts` | Wrapper helpers inject `activeProjectId`; call sites unchanged |
| `src/mocks/handlers.ts` | Mock assets nested under `projects/<id>/`; serve path updated |

### Client — Part B

| File | Change |
|------|--------|
| `src/store/studioApi.ts` | `deleteProjectAssets` RTK mutation (`POST api/projects/delete`) |
| `src/components/Studio/StudioProjects.tsx` | `onDelete` calls `deleteProjectAssets` best-effort, then dispatches `deleteProject(id)` unconditionally |
| `src/mocks/handlers.ts` | Mock handler for `POST /api/projects/delete` returns `{ deleted: 1, prefix }` |

### BFFless rules

| Rule id | Route | Change |
|---------|-------|--------|
| *(6× prepare)* | `POST /api/uploads/*/prepare` | `subDir` → `"projects/{{request.body.projectId}}/<type>"` |
| *(6× register)* | `POST /api/uploads/*/register` | `subDir` → `"projects/{{request.body.projectId}}/<type>"` |
| narrate rule | `POST /api/voice/narrate` | `file_upload` step `subDir` interpolated |
| `30355b6d` | `GET /api/uploads/projects/*` | **New (Part A)** — `file_serve { subDir: "projects" }` |
| `67359cca` | `POST /api/projects/delete` | **New (Part B)** — `function_handler` builds prefix + `file_delete { prefix }` + response |
