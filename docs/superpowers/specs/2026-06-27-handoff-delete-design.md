# Handoff — delete files & folders (v1)

**Status:** ready-for-agent · **Date:** 2026-06-27 · **App:** `apps/handoff`

## Problem

Handoff can upload files, sites, and folders, but there is **no way to delete
anything**. Once a node is created it is permanent. Owners need to remove files,
sites, and whole folder trees they created.

## Decisions (locked)

| Axis | Decision |
| --- | --- |
| Scope | **Files, folders & sites — recursive.** Deleting a folder removes its whole subtree. |
| Permissions | **Write-access only**, ACL-gated. A viewer needs `edit` or `owner` on the node's folder chain. View-only users and share-link viewers get `403`. |
| Storage | **Hard delete** — remove the `handoff_nodes` record *and* purge the underlying stored object(s). No orphaned blobs (see Site caveat). |

## The shaping constraint

BFFless pipelines expose `data_delete` and `file_delete`, but:

- `data_delete` filters by a single `recordId` or `eq`/`ne` only — **no bulk `in`**.
- `file_delete` key-mode deletes **one** object; prefix-mode needs a shared prefix,
  which Handoff's flat `uploads/content/<hash>` keys don't have.

So a single static pipeline **cannot fan out** over an arbitrary-depth subtree.
The recursion therefore lives in the **client**, exactly like the existing
`importFolder` mutation already orchestrates multi-step uploads. The server owns
a clean, safe **single-node** delete; the client owns ordering and recursion.

## Backend — one new rule: `DELETE /api/node?id=<uuid>`

Add to `apps/handoff/bffless/handoff.proxy-rules.json`. Pipeline steps:

1. **`pre`** (`function_handler`) — read `request.query.id`; validate UUID
   (`idOk`). Mirror the existing `Handoff get node` `pre` step.
2. **`query`** (`data_query`, `recordId: request.query.id`, schema
   `1c5d4802-596e-4f50-a08f-c41fb8f9fab0`, `condition: steps.pre.idOk`) — load the node.
3. **`allFolders`** (`data_query`, `nodeType eq folder`, `pageSize 500`) — for the ACL chain.
4. **`children`** (`data_query`, `parentId eq request.query.id`, `pageSize 1`) —
   cheap existence probe so the guard can refuse a non-empty folder.
5. **`gate`** (`function_handler`) — **reuse the existing ACL gate** verbatim but
   change the allow test to require **write**: `rank(level) >= 2` (i.e. `edit` or
   `owner`; admin bypass stays). Build the chain the same way the get-node gate
   does: folders use `folderChain(folders, nodeId)`; files/sites use
   `folderChain(folders, node.parentId)` + self. Emit `allow`, `deny401`,
   `deny403`, plus `isFile`, `storageKey`, `isFolder`, `isSite` for downstream
   conditions.
6. **`guardNonEmpty`** (`response_handler`, `409`,
   `condition: steps.gate.isFolder && steps.children has rows`) — refuse to delete
   a folder that still has children. (The client deletes depth-first, so by the
   time it asks to delete a folder the subtree is already empty; this guard only
   protects against direct/out-of-order calls orphaning a subtree.)
7. **`purgeObject`** (`file_delete`, key-mode, `key` = the file's `storage_path`
   relative to the uploads root, `condition: steps.gate.allow && steps.gate.isFile && steps.gate.storageKey`) —
   purge the stored bytes. Idempotent (missing key → `{ deleted: 0 }`).
8. **`del`** (`data_delete`, `recordId: request.query.id`, schema as above,
   `condition: steps.gate.allow && !guardNonEmpty`) — delete the node record.
9. **`response`** (`200`, `{"deleted": true, "id": <id>}`), **`deny401`** (`401`),
   **`deny403`** (`403`) — mirror the sibling rules.

`stripPrefix: true`, `proxyType: pipeline`, an unused `order` slot. Format all
`function_handler` / `response_handler` bodies as multi-line indented source
(see the pipelines skill's authoring rules), not minified one-liners.

> **Implementer note:** the ACL gate handler is currently copy-pasted across
> every rule. Don't refactor it in this issue — paste the same helper and only
> flip the allow test to write-level, to keep the diff reviewable.

## Frontend — `apps/handoff/src/store/handoffApi.ts`

Add a `deleteNode` mutation that deletes a **single** node:

```
deleteNode: builder.mutation<{ id: string }, { id: string; parentId: string }>
  query: DELETE api/node?id=<id>
  invalidatesTags: [{ type: 'Node', id: `LIST:${parentId}` }]
```

Add a **`deleteSubtree`** helper (a `queryFn` mutation, mirroring `importFolder`):

- Input `{ rootId, parentId }`. Resolve the subtree from already-cached
  `listNodes` data (or fetch per level via `api/nodes?parentId=`), produce a
  **bottom-up** ordering (deepest descendants first, root node last).
- Delete with bounded concurrency via the existing `runPool` helper, collecting
  `failures: { id, name, error }[]` so a partial delete still reports what went.
- `invalidatesTags`: the parent `LIST:<parentId>` plus every affected folder
  `LIST:<folderId>` touched in the subtree.

## Frontend — UI (`src/pages/FolderView.tsx`, `src/pages/HandoffViewer.tsx`)

- Per-row **delete affordance** (trash icon button) on each node row in the
  folder listing, and a Delete action in the viewer toolbar.
- **Gate to write access**: only render when `evaluateAccess({ folderChain, viewer }) >= 'edit'`
  (reuse `src/lib/acl.ts`). Hidden for view-only and share-link viewers; the
  backend enforces it regardless.
- **Confirm dialog** before deleting. For a folder, warn that it and its
  contents (show child count) will be permanently deleted.
- Disable the control while a Site iframe is open / a delete is in flight, and
  surface partial-failure summaries (reuse the import result toast pattern).

## Site asset purge — the one rough edge (paired CE enhancement)

A **Site** node's assets are *many* storage objects referenced only by its
`manifest` (`rel -> /api/uploads/content/<hash>`), with **no shared prefix**.
`file_delete` key-mode purges one object per call and a static pipeline can't
loop, so v1 deletes the **site node record** but cannot cleanly purge every
asset object in one step.

**v1 behavior:** delete the site node (it disappears, becomes unservable). Note
the orphaned asset objects rather than pretending they're gone.

**Paired CE enhancement (file alongside this issue, per the "Enhancing CE is a
first-class option" rule):** extend `file_delete` with a `keys: string[]` array
mode (or a manifest-driven mode) in
`repos/ce/apps/backend/src/pipelines/handlers/file-delete.handler.ts`, so the
delete pipeline can purge all of a site's manifest objects atomically. Once
available, wire site deletion to pass the manifest keys. Until then, document
the orphan in the issue; do **not** silently drop it.

## Testing

- **Unit (Vitest):** `deleteSubtree` ordering (bottom-up), partial-failure
  collection, tag invalidation; `acl`-gated visibility of the delete control.
- **MSW (`src/mocks/handlers.ts`):** add a `DELETE /api/node` handler that
  enforces write-access, refuses non-empty folders (`409`), and removes the node
  from the in-memory store — keeping mock == real (`toNode` seam).
- **Acceptance:**
  - Owner deletes a file → row gone, stored object purged, listing refetched.
  - Owner deletes a folder with nested files/subfolders → entire subtree gone.
  - `edit`-grant user can delete; `view`-grant user and share-link viewer cannot
    (no control; API returns `403`).
  - Direct `DELETE` of a non-empty folder → `409`, nothing deleted.
  - Deleting a site removes the node; asset-object orphan is noted (until CE
    enhancement lands).

## Out of scope

- Soft delete / trash / restore.
- Bulk multi-select delete (single node + recursive folder covers v1).
- Server-side atomic recursive delete (blocked on a CE `data_delete in` /
  recursive capability — separate enhancement if ever wanted).
