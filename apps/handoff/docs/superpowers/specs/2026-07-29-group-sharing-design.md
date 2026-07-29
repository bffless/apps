# Group Sharing — Design

**Date:** 2026-07-29
**Status:** Approved (pending implementation)
**Scope:** CE (`repos/ce`) + Handoff (`repos/apps/apps/handoff`)

## Problem

Handoff folder sharing is per-user only: a grant names one `principalId`
(a user UUID) or the reserved `anyone` principal. Sharing the same folders
with the same set of people over and over means re-entering every email.
CE already has an instance-wide **User Groups** feature (`user_groups`,
`user_group_members`, admin-managed at `/groups` in the admin panel, and
already consulted for project-level permissions via
`project_group_permissions`) — but nothing exposes it to app pipelines or
to Handoff's ACL.

## Decision summary

- **Groups are operator-curated**: created and membered by admins in the
  existing CE admin panel. No end-user group management.
- **Any folder owner can see and apply groups** in the share dialog. Group
  names and member counts are treated as non-sensitive; member lists and
  emails are never exposed to non-admins.
- **Approach A**: CE enriches the pipeline `HandlerContext` with the
  viewer's group memberships; Handoff's ACL matches grants against them.
  No membership mirroring, no caching dependency, membership changes are
  live on the next request.
- Group grants support **view and edit**, inherit down the folder chain,
  and are cut by `restricted` mode — identical semantics to user grants.
- Publicness is structurally unaffected: anonymous viewers have no
  memberships, so `isEffectivelyPublic`, share links, and the feed do not
  change.

## Part 1 — CE changes (PR 1, ships first)

### 1a. `user.groups` in the pipeline `HandlerContext`

Where CE builds the `user` object handed to pipeline `function_handler`s
(today `{id, email, role}`), add:

```ts
user.groups: string[]   // UUIDs of user_groups the identity belongs to
```

- Populated for **every authenticated identity** (session cookie or API
  key → key owner) via one indexed query on `user_group_members`
  (`user_group_members_user_idx` exists). No lazy opt-in, no cache — a
  purged/absent cache is not a state this design has.
- Anonymous requests have no `user`; nothing changes.
- Empty memberships → `[]`, never `undefined`, on new CE. (Handoff still
  treats `undefined` as `[]` for old-CE compatibility.)

### 1b. `GET /api/user-groups/directory` (member-accessible)

Sibling of the existing member-accessible `GET /api/users/directory`
(added for Handoff's people picker):

- **Auth:** any authenticated session (NOT `@Roles('admin')` — this
  endpoint lives outside the admin-only `user-groups` controller guard,
  or in a separate controller).
- **Request:** optional `?search=` (name substring), optional `?limit=`
  (capped server-side).
- **Response:** `{ groups: [{ id, name, memberCount }] }`.
- **Never returns member lists or emails.** Group management (CRUD,
  membership) remains admin-only and untouched.

### 1c. `GET /api/user-groups/mine` (member-accessible)

The client mirror of the gate's `user.groups`: Handoff's UI computes
`canWrite`/`canManage` by running `evaluateAccess` client-side
(`FolderView.tsx`), so the browser must know the session user's own
memberships or group-granted users see wrong affordances.

- **Auth:** any authenticated session (same guard shape as 1b).
- **Response:** `{ groups: [{ id, name }] }` — **strict memberships only**
  (`user_group_members`), NOT the existing `listUserGroups` which also
  includes groups the user *created*. Creator ≠ member: creators are
  admins and already short-circuit to owner. The gate (1a) uses the same
  strict-membership query, so client and server always agree.

### CE testing

- Unit: context builder attaches correct `groups` for session and
  API-key identities; empty array when no memberships.
- e2e: directory endpoint — member gets results with counts;
  unauthenticated → 401; response contains no member identities.

## Part 2 — Handoff changes (PR 2, after CE release is deployed)

### 2a. Grant shape (in `grantsJson` on `handoff_nodes` — no migration)

```ts
interface Grant {
  principalId: string                    // user UUID | group UUID | 'anyone'
  level: 'view' | 'edit'
  principalType?: 'user' | 'group'       // absent ⇒ 'user' (back-compat)
  principalEmail?: string | null         // user grants (existing)
  principalName?: string | null          // display snapshot, group grants
}
```

- Every existing grant row parses unchanged (`principalType` absent ⇒
  `'user'`).
- `principalName` is snapshotted at grant time (like `principalEmail`).
  Rename in CE ⇒ stale display name, harmless. Delete in CE ⇒ grant
  matches no one, row stays visible so an owner can revoke it. No
  cascade, no existence check on write (symmetric with user grants;
  writes are already owner/admin-gated).

### 2b. `evaluateAccess` (src/lib/acl.ts + the gate function_handler port)

- `Viewer` gains `groupIds?: string[]`.
- Grant scan match arm becomes: promote when
  `grant.principalId === ANYONE_PRINCIPAL` (view-capped), or
  `grant.principalId === viewer.userId`, or
  `viewer.groupIds?.includes(grant.principalId)`.
- UUID id space means no user/group collision; `principalType` is UX
  metadata, not a security input.
- Inheritance, `restricted` cut-off, admin/owner short-circuits, the
  `anyone` view cap, share-link guest scoping: all unchanged.
- Server gate reads `user.groups` from the enriched context →
  `viewer.groupIds`; `undefined` (old CE) degrades to `[]` — group
  grants simply never match, nothing throws.
- Downstream gates (comments, delete, share-mode, feed publicness) call
  `evaluateAccess` and become group-aware with zero changes.

### 2c. API surface

- `POST /api/grants` accepts optional `principalType`, `principalName`;
  stores and echoes them. `GET /api/grants` returns them. Revoke is
  unchanged (by `principalId`).
- New plain proxy rule `GET /api/groups` →
  `http://localhost:3000/api/user-groups/directory`,
  `forwardCookies: true` — exact sibling of the `/api/directory` rule.
- New plain proxy rule `GET /api/me/groups` →
  `http://localhost:3000/api/user-groups/mine`, `forwardCookies: true`.
  The client fetches it once per session (RTK Query) and threads the ids
  into `viewer.groupIds` at every client-side `evaluateAccess` call site
  (`FolderView`, delete gate, comment gate). Fetch failure or 404 (old
  CE) ⇒ `groupIds` undefined ⇒ exactly today's behavior.

### 2d. UI (ShareDialog / ManageAccessPanel)

- Picker becomes two-section: typing queries `/api/directory` (People)
  and `/api/groups?search=` (Groups) in parallel, rendered under
  section headers.
- Selecting a group → `addGrant` with `principalType: 'group'` and
  `principalName` from the picker row.
- Grant rows: group icon + snapshotted `principalName` for group grants;
  same view/edit selector and revoke affordance as user rows. Member
  count is shown only where the dialog already holds directory data for
  that group (it is not snapshotted in the grant) — a row for a deleted
  group renders name-only.
- **Degradation:** if `/api/groups` 404s (older CE), the Groups section
  does not render; dialog behaves exactly as today.

### 2e. Handoff testing

- `acl.test.ts`: group grant match; inherited group grant; `restricted`
  drops inherited group grant; owner/admin unaffected; `anyone`
  unaffected; `groupIds` undefined ⇒ no match, no throw.
- Grants rule tests: new fields round-trip through POST/GET; absent
  fields on legacy rows.
- `ManageAccessPanel` tests: two-section picker, group grant add/revoke,
  404 fallback hides Groups.
- MSW mocks for `/api/groups`.

## Rollout

1. **PR 1 (`repos/ce`)** — built in-loop, released, deployed to j5s.dev.
2. **PR 2 (`repos/apps`)** — Handoff epic via Sandcastle once CE is
   live. At deploy, fold the new `/api/groups` rule and updated gate
   functions into the live base `handoff` proxy rule set via MCP
   (fold-into-base-set convention; no separate preview set).

## Out of scope (explicitly)

- End-user group creation/management (future: would need CE ownership
  semantics on groups; grant format already accommodates it).
- Nested groups, roles beyond view/edit, per-file grants.
- Member-list visibility for non-admins.
- Refreshing stale `principalName` snapshots (possible later polish via
  the directory response).
