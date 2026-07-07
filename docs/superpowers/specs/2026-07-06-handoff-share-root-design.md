# Handoff — sharing the root folder ("My Files")

- **Date:** 2026-07-06
- **App:** `repos/apps/apps/handoff`, backed by the live `handoff` BFFless proxy rule set (`5d59f6d8-f492-4e18-9edc-6a9d96677b44`, project `c3b71936-c5f0-4d20-bd3c-d5887289f9d0`)
- **Schemas:** `handoff_nodes` (`1c5d4802-596e-4f50-a08f-c41fb8f9fab0`), `handoff_share_links` (`ace1febf-4b3d-4a11-a5f8-22a056dd9afa`)
- **Status:** design approved (owner signed off 2026-07-06); ready for implementation plan

## Problem

Opening **Share** on the root folder ("My Files") 500s:

```
STEP_EXECUTION_ERROR
select … from pipeline_data where … and id = $3   params: …,root,100
```

Root is a **synthetic sentinel** — the string `'root'` — with **no `handoff_nodes`
record**. The frontend already treats it as a non-record (`useGetNodeQuery` is
*skipped* for `'root'`, top-level nodes carry `parentId: 'root'`). But every share
and grant path assumes the target is a real node: they `data_query`/`data_update`
by `recordId = folderId`, and `pipeline_data.id` is a UUID column, so
`id = 'root'` fails the Postgres UUID cast. Even if the query were guarded, there
is no `ownerId` to authorize against and no `grantsJson` slot to store per-person
grants, and the ACL never puts `'root'` in a folder chain.

The owner wants the **full Share dialog** on root: both a public share link *and*
granting specific people (by email) view/edit — root behaving like any other
folder.

## Goals

- **Share link on root**: "anyone with the link can view" grants a guest access to
  the entire top-level tree (all top-level nodes and everything nested).
- **People-grants on root**: grant a named user `view`/`edit`; it inherits down to
  every node not under a deeper `restricted` folder — identical semantics to a
  grant on any folder.
- No regression to normal browsing/navigation, which keeps using the `'root'`
  sentinel unchanged.
- No data migration of existing nodes.

## Non-goals

- Materializing root as a fully-normal node everywhere (migrating every top-level
  `parentId: 'root'` → a UUID and removing the `'root'` sentinel from the
  frontend). Rejected: large migration + broad frontend churn for a cosmetic gain.
- Per-user roots. `root` is a **single global top-level** (the `listNodes` query
  filters only on `parentId`, never on owner), so exactly **one** root record
  exists instance-wide.
- Fixing the pre-existing "root *listing* is open to anyone" behavior (the list
  gate does `if (isRoot) allow = true`). Orthogonal; see **Out of scope**.

## Decisions (from brainstorming)

- **Approach 1 — singleton root record + sentinel resolution.** Materialize one
  root record; resolve the `'root'` sentinel → that record only in the paths that
  need an addressable node (mint, grants, ACL chain-building). The `'root'`
  sentinel and the existing tree/navigation model stay intact.
- The root record is **lazily created on first share** (mint or grant), never as a
  migration or a login-time side effect.
- Mint stores the share link's `folderId` as the root record's **real UUID**, so
  nothing downstream (validate / claim / serve) ever sees the string `'root'` —
  those pipelines are untouched.

## Architecture

Root becomes *addressable* via one singleton record `R`. Three backend concerns
(the root record + its resolver, mint/grants resolution, ACL chain injection) and
one frontend concern (the Share dialog learning `R`).

### 1. The root record `R`

One `handoff_nodes` row identifying the global root:

| field | value |
| --- | --- |
| `nodeType` | `'root'` — the marker; distinct from `'folder'`/`'file'` |
| `displayName` | `'My Files'` |
| `parentId` | `''` (never walked; not a UUID, so chain building stops there) |
| `ownerId` | the admin/owner who first triggers creation |
| `grantsJson` | `[]` initially |
| `mode` | `'inheriting'` |
| `id` | server-assigned UUID = `R` |

Invariant: **at most one** `nodeType='root'` row. It never appears in a folder
listing (its `parentId` is `''`, not `'root'`), so it is invisible to normal
browsing.

### 2. "Resolve root" — a shared sub-sequence

A small step group reused by mint and grants (both POST and GET):

1. `function_handler` — branch on `request.body.folderId === 'root'` (or, for the
   grants GET, the query param).
2. `data_query` — `filters: { nodeType: { op: 'eq', value: 'root' } }`,
   `pageSize: 1`, `condition:` isRoot. Yields `R` if it exists.
3. `data_create` — **write paths only** (`POST /api/share-links`,
   `POST /api/grants`); `condition:` isRoot **and** step 2 found nothing; creates
   `R` with `ownerId = user.id`. (Only reachable when the caller is owner/admin —
   the authorization check below still applies.) **Read paths**
   (`GET /api/grants`, the dialog resolver in §5) omit this step and treat an
   absent `R` as an empty root (no grants, no links).
4. `function_handler` — compute `effectiveFolderId = isRoot ? R.id : folderId` and
   the resolved node object for the ownership check.

Downstream steps use `effectiveFolderId` in place of `request.body.folderId`. For
a non-root folder the resolver is a pass-through (isRoot false → steps 2–3 skipped).
So `R` is created exactly once, by whichever write (link or grant) happens first.

> **Concurrency note:** two simultaneous first-shares could each create an `R`. The
> resolver's `data_query` orders deterministically and the consumers always pick
> the first row, so a duplicate is inert (an orphaned empty root). Acceptable for
> this app's scale; the implementation plan may add a guard test documenting it.

### 3. Mint & grants

- **`POST /api/share-links`** (mint): insert the resolve-root group before the
  existing `folder` query; feed `effectiveFolderId` to the ownership `check` and
  store it as the share link's `folderId`. A root link therefore stores `R` (a
  UUID) — validate/claim/serve are unchanged.
- **`POST /api/grants`** and **`GET /api/grants`**: same resolve group; read/write
  `R.grantsJson` via `effectiveFolderId`. Ownership is `R.ownerId`/admin.
- **`GET /api/share-links`** (list for the dialog): filter by `effectiveFolderId`
  so the root dialog lists root's links.

### 4. ACL chain injection (main surface area)

Every gate that authorizes access builds a folder chain with an embedded
`folderChain(folders, startId)` that walks `parentId` upward **only while the id
is a UUID present in the folder map** — so it stops at the `'root'` sentinel and
never includes root. Affected gates: **`GET /api/nodes`, `GET /api/node`,
`GET /api/resolve/*`, `GET /r/*`, `POST /api/sign`** (the exact set is enumerated
during planning by grepping the rule set for `folderChain`).

Two changes per gate:

1. The chain-feeding query (`allFolders`) selects `nodeType in ('folder','root')`
   (filter op `in`) so `R` is in the map.
2. In `folderChain`, when the current node's `parentId === 'root'` (the sentinel),
   resolve it to `R.id` and take one more hop, so `R` becomes `chain[0]`. `R`'s own
   `parentId` is `''`, so the walk then terminates.

`evalAccess` is unchanged. With `R` at the chain head:

- a share-link visitor whose scope (`hf_s` cookie `s`) equals `R` matches
  `chain.some(f => f.id === shareLinkFolderId)` → `view`;
- a named grantee listed in `R.grantsJson` gets their level, inherited from the
  chain head down (dropped only under a deeper `restricted` folder, exactly as today).

### 5. Frontend — Share dialog on root

- **Resolve for display (read-only):** `useGetNodeQuery('root')` is currently
  skipped. Make `GET /api/node` resolve the `'root'` sentinel server-side and
  return `R` (via the read-only resolver — no creation). Before the first share `R`
  does not exist, so it returns an **empty root placeholder** (`id: null`, no
  grants); PeopleAccess and the share-links list then render the empty state, and
  the first mint/grant creates `R` and returns its id for subsequent queries. Once
  `R` exists, the dialog keys off it like any folder.
- **Navigation untouched:** breadcrumbs, `listNodes({ parentId: 'root' })`, and the
  `'root'` sentinel stay exactly as they are. Only the Share dialog learns `R`.
- The Share button already renders on root (gated on `canManage`); no change there.

## Data flow

**Owner shares root (link):** Share dialog (folderId `'root'`) → `POST
/api/share-links` → resolve-root creates/loads `R` → link row stored with
`folderId = R` → dialog shows `handoff.j5s.dev/s/<token>`.

**Guest opens the link:** `/s/:token` → claim sets `hf_s` cookie `{ s: R }` →
browses → each gate builds a chain that now includes `R` at the head → scope
matches → `view` on every node.

**Owner grants a person on root:** dialog → `POST /api/grants` → resolve-root loads
`R` → merge into `R.grantsJson`. That user, when authenticated, gets their granted
level inherited from `R` downward.

## Error handling

- `folderId` that is neither `'root'` nor a UUID → mint/grants return the existing
  validation denial (unchanged), never a raw DB cast error.
- Resolve-root creating `R` is gated on the same owner/admin check as sharing any
  folder, so a non-owner can never mint the record.
- Serve/claim paths are untouched, so their existing revoked/expired/malformed-token
  handling is unchanged.

## Testing

- **Pure functions:** unit-test the updated `folderChain` — injects `R` at the head
  when a top-level node's parent is the `'root'` sentinel; still terminates; still
  honors a deeper `restricted` folder. Unit-test `evaluateAccess` for (a) a
  root-scoped share visitor and (b) a root grantee, including the restricted-drop case.
- **Structural guards** (repo-JSON assertions, in the style of the existing
  `*Rules.test.ts`): mint & grants contain the resolve-root group; mint stores a
  UUID `folderId` for root (never the string `'root'`); the affected gates query
  `nodeType in ('folder','root')`.
- **Mock layer (MSW):** end-to-end "share root → guest views a nested file" and
  "grant a user on root → they see everything"; plus a negative "no scope/grant →
  nested access denied."

## Rollout

1. Land repo changes (proxy-rules JSON + frontend + tests) via PR on
   `feat/handoff-share-root`.
2. Apply the rule changes to the **live** `handoff` set via MCP after merge
   (Sandcastle does not deploy proxy rules) — update the 3 share/grant rules and
   the affected gate rules; diff-verify repo JSON vs live.
3. Smoke-test on the live app: share root, open the link in a logged-out browser,
   confirm a nested file loads; grant a second user and confirm inherited access.

## Out of scope

- **Root listing is world-readable.** `GET /api/nodes?parentId=root` returns all
  top-level nodes to anyone because the gate short-circuits `if (isRoot) allow =
  true`. That predates this work and is independent of it (it concerns the
  top-level *listing*, not nested access or grants). Flagged here as a follow-up to
  evaluate separately; this feature neither fixes nor worsens it.
- Materialization/migration of the tree (see Non-goals).
- Per-user roots (see Non-goals).
