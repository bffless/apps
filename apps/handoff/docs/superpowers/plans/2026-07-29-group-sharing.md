# Handoff Group Sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let folder owners grant `view`/`edit` to CE User Groups, with membership evaluated live by the pipeline gate (`user.groups`) and mirrored client-side.

**Architecture:** Grants stay in `grantsJson` with an optional `principalType: 'group'` + `principalName` snapshot; `evaluateAccess` (canonical `src/lib/acl.ts` and its server port `_shared/acl.ts`) gains `viewer.groupIds`; two new plain proxy rules expose CE's member-accessible group endpoints; the share dialog grows a Groups picker section. Publicness, share links, and the feed are structurally untouched (anonymous viewers have no `groupIds`).

**Tech Stack:** React 19 + RTK Query, Vitest + Testing Library + MSW, BFFless proxy rules (`.bffless/proxy-rules/handoff/`, function handlers bundled by esbuild).

**Spec:** `apps/handoff/docs/superpowers/specs/2026-07-29-group-sharing-design.md` (this worktree).

## Global Constraints

- Repo: `/home/rico/bffless/repos/apps`, worktree `.claude/worktrees/group-sharing`, branch `group-sharing`. Paths below are relative to `apps/handoff/` unless prefixed.
- **Depends on CE plan** (`repos/ce` worktree `docs/superpowers/plans/2026-07-29-pipeline-user-groups.md`) being deployed for live behavior — but every change here must degrade gracefully against an old CE: `user.groups` undefined ⇒ group grants never match; `/api/groups` 404 ⇒ no Groups picker section.
- Group grants support `view` and `edit`. The reserved `anyone` principal keeps its view cap and its no-email rule — do not touch that branch.
- `principalType` is UX metadata only; access evaluation matches on `principalId` alone (UUIDs; no user/group collision).
- Tests: `pnpm test` (vitest) from `apps/handoff/`; run `pnpm lint` before each commit.
- `src/lib/anyoneGrantRule.test.ts` is the port-equivalence matrix pinning `src/lib/acl.ts` to `_shared/acl.ts` — any change to one without the other must fail there.
- Commit after each task; conventional-commit messages.

---

### Task 1: `viewer.groupIds` in the canonical ACL

**Files:**
- Modify: `src/lib/acl.ts`
- Test: `src/lib/acl.test.ts`

**Interfaces:**
- Produces (every later task relies on these):
  - `Grant` gains `principalType?: 'user' | 'group'` and `principalName?: string | null`
  - `Viewer` gains `groupIds?: string[]`
  - `evaluateAccess` promotes a grant whose `principalId` is in `viewer.groupIds`

- [ ] **Step 1: Write failing tests** in `src/lib/acl.test.ts` (reuse the file's existing `FolderLink` helpers):

```ts
describe('group grants', () => {
  const groupGrant = (level: 'view' | 'edit'): Grant => ({
    principalId: 'group-1', principalType: 'group', principalName: 'Design', level,
  })

  it('a member of a granted group gets the grant level', () => {
    const chain = [link({ grants: [groupGrant('edit')] })]
    expect(evaluateAccess({ folderChain: chain, viewer: { userId: 'u1', groupIds: ['group-1'] } })).toBe('edit')
  })

  it('a non-member does not match a group grant', () => {
    const chain = [link({ grants: [groupGrant('edit')] })]
    expect(evaluateAccess({ folderChain: chain, viewer: { userId: 'u1', groupIds: ['other'] } })).toBe('none')
  })

  it('group grants inherit down the chain', () => {
    const chain = [link({ grants: [groupGrant('view')] }), link({})]
    expect(evaluateAccess({ folderChain: chain, viewer: { userId: 'u1', groupIds: ['group-1'] } })).toBe('view')
  })

  it('a restricted descendant drops an inherited group grant', () => {
    const chain = [link({ grants: [groupGrant('edit')] }), link({ mode: 'restricted' })]
    expect(evaluateAccess({ folderChain: chain, viewer: { userId: 'u1', groupIds: ['group-1'] } })).toBe('none')
  })

  it('undefined groupIds behaves exactly like today (no match, no throw)', () => {
    const chain = [link({ grants: [groupGrant('edit')] })]
    expect(evaluateAccess({ folderChain: chain, viewer: { userId: 'u1' } })).toBe('none')
  })

  it('the highest of a direct and a group grant wins', () => {
    const chain = [link({ grants: [
      { principalId: 'u1', level: 'view' }, groupGrant('edit'),
    ] })]
    expect(evaluateAccess({ folderChain: chain, viewer: { userId: 'u1', groupIds: ['group-1'] } })).toBe('edit')
  })
})
```

- [ ] **Step 2: Run to verify failure** — `pnpm test -- src/lib/acl.test.ts`. Expected: FAIL (type error on `principalType` / wrong levels).

- [ ] **Step 3: Implement** in `src/lib/acl.ts`:

```ts
export interface Grant {
  principalId: string
  principalEmail?: string | null
  /** UX metadata only — evaluation matches principalId. Absent ⇒ 'user' (legacy rows). */
  principalType?: 'user' | 'group'
  /** Display snapshot for group grants, taken at grant time. */
  principalName?: string | null
  level: 'view' | 'edit'
}

export interface Viewer {
  userId?: string
  isAdmin?: boolean
  /** Group ids the viewer is a member of (from CE user.groups / /api/me/groups). */
  groupIds?: string[]
  shareLinkFolderId?: string
}
```

Grant-scan arm (keep the Anyone branch first and untouched):

```ts
if (grant.principalId === ANYONE_PRINCIPAL) {
  promote('view')
} else if (viewer.userId && grant.principalId === viewer.userId) {
  promote(grant.level)
} else if (viewer.groupIds && viewer.groupIds.includes(grant.principalId)) {
  promote(grant.level)
}
```

- [ ] **Step 4: Run to verify pass** — `pnpm test -- src/lib/acl.test.ts`. Expected: PASS (including all pre-existing cases).

- [ ] **Step 5: Commit** — `git add src/lib/acl.ts src/lib/acl.test.ts && git commit -m "feat(handoff): group principals in the canonical ACL"`

---

### Task 2: Port to the server ACL + equivalence matrix

**Files:**
- Modify: `.bffless/proxy-rules/handoff/_shared/acl.ts`
- Test: `src/lib/anyoneGrantRule.test.ts` (the port-equivalence matrix — it imports BOTH modules)

**Interfaces:**
- Consumes: Task 1's semantics (identical arm).
- Produces: `Viewer.groupIds?: string[]` on the server-port `Viewer`; `evalAccess` matches group grants. Gate functions (Task 3) construct this Viewer.

- [ ] **Step 1: Extend the matrix first.** In `src/lib/anyoneGrantRule.test.ts`, add group cases to the existing matrix that asserts `evaluateAccess(...) === evalAccess(...)` for the same chain/viewer: member-of-granted-group (view and edit), non-member, restricted-drops-inherited-group-grant, and `groupIds: undefined`. Follow the file's existing case-table shape exactly.

- [ ] **Step 2: Run to verify failure** — `pnpm test -- src/lib/anyoneGrantRule.test.ts`. Expected: FAIL — the port returns 'none' where the canonical returns the grant level.

- [ ] **Step 3: Implement in `_shared/acl.ts`.** Add to `Viewer`:

```ts
export interface Viewer {
  userId?: string | null;
  isAdmin?: boolean;
  /** Group ids the viewer belongs to — from the pipeline context's user.groups. */
  groupIds?: string[] | null;
  shareLinkFolderId?: string | null;
}
```

In `evalAccess`'s grant scan (the loop over `grants` after the restricted-boundary computation), mirror the canonical arm:

```ts
} else if (viewer.userId && grant.principalId === viewer.userId) {
  if (rank(grant.level) > rank(best)) best = (grant.level === 'edit' ? 'edit' : 'view');
} else if (viewer.groupIds && grant.principalId && viewer.groupIds.indexOf(grant.principalId) !== -1) {
  if (rank(grant.level) > rank(best)) best = (grant.level === 'edit' ? 'edit' : 'view');
}
```

(Match the file's defensive style — `indexOf` and level-collapsing are how the existing arms are written; keep whatever exact idiom the current user-arm uses.)

- [ ] **Step 4: Run to verify pass** — `pnpm test -- src/lib/anyoneGrantRule.test.ts src/lib/acl.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit** — `git add .bffless/proxy-rules/handoff/_shared/acl.ts src/lib/anyoneGrantRule.test.ts && git commit -m "feat(handoff): group principals in the server ACL port"`

---

### Task 3: Gate functions thread `user.groups`

**Files (every fn that constructs a `Viewer` from `user` — the current importer list of `_shared/acl`):**
- Modify: `.bffless/proxy-rules/handoff/rules/api/nodes/get/gate.fn.ts`
- Modify: `.bffless/proxy-rules/handoff/rules/api/nodes/get/shape.fn.ts`
- Modify: `.bffless/proxy-rules/handoff/rules/api/node/get/gate.fn.ts`
- Modify: `.bffless/proxy-rules/handoff/rules/api/node/delete/gate.fn.ts`
- Modify: `.bffless/proxy-rules/handoff/rules/api/node/meta/patch/gate.fn.ts`
- Modify: `.bffless/proxy-rules/handoff/rules/api/uploads/content/[...path]/get/gate.fn.ts`
- Modify: `.bffless/proxy-rules/handoff/rules/api/resolve/[...path]/get/gate.fn.ts`
- Modify: `.bffless/proxy-rules/handoff/rules/api/sign/post/gate.fn.ts`
- Modify: `.bffless/proxy-rules/handoff/rules/api/comments/get/gate.fn.ts`
- Modify: `.bffless/proxy-rules/handoff/rules/api/comments/post/gate.fn.ts`
- Modify: `.bffless/proxy-rules/handoff/rules/api/comments/patch/gate.fn.ts`
- Modify: `.bffless/proxy-rules/handoff/rules/r/[...path]/any/check.fn.ts`
- Tests: the existing per-rule suites (`src/lib/contentTraversalRule.test.ts`, `src/lib/commentsListRule.test.ts`, `src/lib/commentsCreateRule.test.ts`, `src/lib/commentsPatchRule.test.ts`, `src/lib/deleteNodeRule.test.ts`, `src/lib/directoryRule.test.ts`, `src/lib/effectivePublicRule.test.ts`, `src/lib/feedRule.test.ts`) — these compile the real fn bundles via `compileHandler`; extend the ones that inject a `user`.

**Interfaces:**
- Consumes: the CE contract `user.groups?: string[]` in the pipeline handler context (empty array on new CE, absent on old CE), plus Task 2's `Viewer.groupIds`.
- Produces: every gate evaluates group grants; no rule.yaml changes.

- [ ] **Step 1: Pick one gate as the TDD anchor** — `rules/api/nodes/get/gate.fn.ts` via its suite. Add a failing case: a folder whose `grantsJson` contains `[{"principalId":"group-1","principalType":"group","level":"view"}]`, request user `{ id: 'u2', role: 'user', groups: ['group-1'] }` ⇒ allowed; same user with `groups: []` ⇒ denied. Run the suite; expected: FAIL.

- [ ] **Step 2: Update the viewer construction in ALL twelve files.** The current pattern (e.g. `nodes/get/gate.fn.ts:66-74`) is:

```ts
const uid = ((user && user.id) || null) as string | null;
const isAdmin = !!user && user.role === 'admin';
...
if (uid) viewer = { userId: uid, isAdmin: isAdmin };
```

Becomes:

```ts
const uid = ((user && user.id) || null) as string | null;
const isAdmin = !!user && user.role === 'admin';
const groupIds = ((user && (user as { groups?: string[] }).groups) || undefined);
...
if (uid) viewer = { userId: uid, isAdmin: isAdmin, groupIds: groupIds };
```

The cast is needed until the `bffless` package's `HandlerContext` user type declares `groups` — check `node_modules/bffless` after the CE release; if the published types already include it, drop the casts and import normally. Anonymous/share-link viewer branches stay exactly as they are (guests have no groups by construction).

- [ ] **Step 3: Extend the remaining per-rule suites** with one member-allowed + one non-member-denied case each, following the anchor case's shape.

- [ ] **Step 4: Run to verify pass** — `pnpm test -- src/lib`. Expected: PASS.

- [ ] **Step 5: Commit** — `git add .bffless/proxy-rules/handoff/rules src/lib && git commit -m "feat(handoff): gates evaluate group membership from user.groups"`

---

### Task 4: Grants API stores and echoes the new fields

**Files:**
- Modify: `.bffless/proxy-rules/handoff/rules/api/grants/post/merge.fn.ts`
- Modify: `.bffless/proxy-rules/handoff/rules/api/grants/get/shape.fn.ts`
- Tests: the grants rule suites in `src/lib/` that compile these fns (find them with `grep -rl "grants/post\|grants/get" src/lib src/test`); extend with round-trip cases.

**Interfaces:**
- Consumes: `POST /api/grants` body gains optional `principalType?: 'group'` and `principalName?: string`.
- Produces: stored grants carry `principalType`/`principalName`; `GET /api/grants` echoes `{ principalId, principalEmail, principalType, principalName, level }`. The UI (Task 7) relies on exactly these keys.

- [ ] **Step 1: Failing round-trip test:** POST a group grant `{ folderId, principalId: 'group-1', principalType: 'group', principalName: 'Design', level: 'edit' }` as the folder owner ⇒ the merged grants array contains all five fields; then the GET shape returns them. Also: a legacy stored grant without `principalType` shapes to `principalType` absent/undefined (NOT `'user'` — don't rewrite stored data), and an `anyone` POST still forces `level: 'view'`, no email, no name.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement `merge.fn.ts`.** Extend the interfaces:

```ts
interface StoredGrant {
  principalId?: string;
  principalEmail?: string | null;
  principalType?: string;
  principalName?: string | null;
  level?: string;
}
interface GrantBody {
  principalId?: string;
  principalEmail?: string;
  principalType?: string;
  principalName?: string;
  level?: string;
}
```

Sanitize after the existing `pid`/`level`/`email` lines:

```ts
const ptype = body.principalType === 'group' ? 'group' : undefined;
let pname: string | null = ptype === 'group' && body.principalName ? String(body.principalName) : null;
if (pid === 'anyone') {
  level = 'view';
  email = null;
  pname = null; // anyone is never a group and never named
}
```

And include `principalType: ptype` (omit when undefined) + `principalName: pname` in both `out.push` sites (the replace branch and the append branch), preserving an existing stored grant's `principalType`/`principalName` when the update body omits them (same `||` fallback style the email field uses).

- [ ] **Step 4: Implement `shape.fn.ts`** — extend its `StoredGrant` the same way and echo the two fields in its `out.push` (`principalType: g.principalType === 'group' ? 'group' : undefined`, `principalName: g.principalName || null`).

- [ ] **Step 5: Run to verify pass, then commit** — `git commit -m "feat(handoff): grants API round-trips group principal metadata"`

---

### Task 5: Proxy rules for the two CE endpoints

**Files:**
- Create: `.bffless/proxy-rules/handoff/rules/api/groups/get.rule.yaml`
- Create: `.bffless/proxy-rules/handoff/rules/api/me/groups/get.rule.yaml`

**Interfaces:**
- Produces: `GET /api/groups?search=&limit=` → `{ groups: [{ id, name, memberCount }] }` and `GET /api/me/groups` → `{ groups: [{ id, name }] }` (CE response bodies pass through untouched). Task 6's RTK endpoints call these paths.

- [ ] **Step 1: Author both rules** on the `/api/directory` pattern (plain proxy, session forwarded, no admin key):

`rules/api/groups/get.rule.yaml`:

```yaml
targetUrl: http://localhost:3000/api/user-groups/directory
order: 10
forwardCookies: true
description: "Group picker for the share dialog. Forwards GET /api/groups?search=&limit= to the CE backend's member-accessible GET /api/user-groups/directory (returns { groups: [{id,name,memberCount}] }; blank search lists all, capped; never member lists/emails). forwardCookies carries the SuperTokens session — no admin key is borrowed. Requires CE >= the release that adds the member-accessible group directory; on older CE this 404s and the UI hides the Groups section."
```

`rules/api/me/groups/get.rule.yaml`:

```yaml
targetUrl: http://localhost:3000/api/user-groups/mine
order: 10
forwardCookies: true
description: "The session user's own group memberships (strict), so the client-side evaluateAccess mirror can compute the same canWrite/canManage a group-granted user gets from the server gate. Returns { groups: [{id,name}] }. Requires the same CE release as /api/groups; 404 on older CE degrades to no group awareness client-side."
```

- [ ] **Step 2: Validate the rule set builds/loads** — run the repo's proxy-rules check (the same script CI runs; see `.bffless/proxy-rules/handoff` build/test wiring in the root `package.json`, e.g. the rules compile/`loadProxyRules` test suite). Expected: both rules parse; no path+method collision (`/api/groups` GET and `/api/me/groups` GET are new).

- [ ] **Step 3: Commit** — `git add .bffless/proxy-rules/handoff/rules/api && git commit -m "feat(handoff): proxy rules for group directory and my-memberships"`

---

### Task 6: RTK endpoints + Grant type in the store

**Files:**
- Modify: `src/store/handoffApi.ts`
- Test: extend the store tests beside the existing grants tests (see `src/store/` suites that mock grants endpoints)

**Interfaces:**
- Consumes: Task 5's routes.
- Produces (Tasks 7–8 import these):
  - `Grant` client type gains `principalType?: 'user' | 'group'`, `principalName?: string | null`
  - `useAddGrantMutation` arg gains `principalType?: 'group'; principalName?: string`
  - `useSearchGroupsQuery({ search: string })` → `{ groups: { id: string; name: string; memberCount: number }[] }`
  - `useMyGroupsQuery()` → `{ groups: { id: string; name: string }[] }`

- [ ] **Step 1: Failing tests** — MSW-backed: `searchGroups` hits `/api/groups?search=de` and returns the mocked list; `myGroups` hits `/api/me/groups`; `addGrant` posts `principalType`/`principalName` through in the body.

- [ ] **Step 2: Implement.** Extend the `Grant` interface and `addGrant` mutation arg (`handoffApi.ts:512-516` documents the current body — update the doc comment too). Add:

```ts
searchGroups: builder.query<{ groups: { id: string; name: string; memberCount: number }[] }, { search: string }>({
  query: ({ search }) => ({ url: '/api/groups', params: search ? { search } : undefined }),
}),
myGroups: builder.query<{ groups: { id: string; name: string }[] }, void>({
  query: () => ({ url: '/api/me/groups' }),
}),
```

(Follow the file's existing `builder.query` idiom for base URL/error handling; no `providesTags` invalidation needed — memberships are admin-curated and re-fetched per session.)

- [ ] **Step 3: Run to verify pass, then commit** — `git commit -m "feat(handoff): group directory and my-memberships client endpoints"`

---

### Task 7: Thread `groupIds` through the client viewer

**Files:**
- Modify: `src/pages/FolderView.tsx` (viewer at ~line 857)
- Modify: `src/lib/deleteGate.ts` (`canDeleteNode` input + viewer at ~line 46)
- Modify: `src/lib/commentGate.ts` (`canComment` input + viewer at ~line 48)
- Modify: every caller of `canDeleteNode` / `canComment` (find with `grep -rn "canDeleteNode(\|canComment(" src --include="*.tsx" --include="*.ts" | grep -v test`) to pass the new field
- Modify: `src/mocks/handlers.ts` (viewer construction at ~line 385 — feed the mock session's groups so MSW mirrors the server)
- Tests: `src/lib/deleteGate.test.ts`, `src/lib/commentGate.test.ts`, plus the FolderView-level suite that covers `canWrite`/`canManage`

**Interfaces:**
- Consumes: `useMyGroupsQuery` from Task 6; `viewer.groupIds` from Task 1.
- Produces: `canDeleteNode`/`canComment` inputs gain `groupIds?: string[]`; FolderView computes `effectiveLevel` group-aware.

- [ ] **Step 1: Failing gate tests** — `canDeleteNode`/`canComment` with a group-granted chain: member ⇒ allowed, non-member ⇒ denied, `groupIds` undefined ⇒ today's behavior.

- [ ] **Step 2: Implement.** Add `groupIds?: string[]` to both gate inputs and spread it into their internal `viewer: { userId: ..., isAdmin: ..., groupIds: input.groupIds }`. In `FolderView.tsx`:

```ts
const { data: myGroupsData } = useMyGroupsQuery(undefined, { skip: !session?.authenticated })
const myGroupIds = myGroupsData?.groups.map((g) => g.id)
```

and in the authenticated viewer branch (~line 861): `{ userId: ..., isAdmin: ..., groupIds: myGroupIds }`. `undefined` while loading or on 404 is correct — it renders exactly today's affordances, then upgrades when the query lands. Pass `groupIds: myGroupIds` through the `canDeleteNode`/`canComment` call sites (each caller already has the session in scope; fetch `useMyGroupsQuery` at the same level it fetches the session).

- [ ] **Step 3: MSW mirror** — in `src/mocks/handlers.ts`, give the mock session a `groups: string[]` and include it in the `viewer` built at ~line 385, plus handlers for `GET /api/groups` and `GET /api/me/groups` returning fixture groups.

- [ ] **Step 4: Run to verify pass** — `pnpm test -- src/lib src/pages`. Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(handoff): client access checks mirror group membership"`

---

### Task 8: Groups section in the share dialog

**Files:**
- Modify: `src/components/ManageAccessPanel.tsx` (picker at ~lines 286-370, `handleAdd` at ~line 401, grant rows)
- Test: `src/components/generalAccess.test.tsx` and/or a new `src/components/manageAccessGroups.test.tsx`

**Interfaces:**
- Consumes: `useSearchGroupsQuery`, `useAddGrantMutation` (with `principalType`/`principalName`), `Grant.principalType`/`principalName` from Task 6.
- Produces: UI only.

- [ ] **Step 1: Failing component tests** (MSW fixtures from Task 7):
  - typing a term shows a **People** section (existing `/api/directory` results) and a **Groups** section (`/api/groups` results, each row showing name + member count);
  - selecting a group row calls `addGrant` with `{ principalId, principalType: 'group', principalName, level: 'view' }`;
  - a grant with `principalType: 'group'` renders in the access list with the group icon and `principalName` (falling back to `principalId` if the name is missing) and keeps the same level dropdown + revoke button as user rows;
  - when `GET /api/groups` responds 404, no Groups section renders and people search is unaffected.

- [ ] **Step 2: Implement.**
  - Run `useSearchGroupsQuery({ search })` beside the existing people search (same `shouldSearch` debounce; `skip` when blank if the existing people picker skips — keep the two consistent).
  - Render section headers only when both sources have results; otherwise render the single flat list as today for people-only results.
  - `handleSelect`/`handleAdd` overloads: group selection calls `addGrant` with the three extra fields; people selection is unchanged.
  - Grant rows: branch on `grant.principalType === 'group'` — icon `Users` (or the project's existing lucide group icon), label `grant.principalName ?? grant.principalId`, member count appended only when that group id is present in the current `searchGroups` data (the count is not snapshotted — a deleted group renders name-only).
  - 404 degradation: `useSearchGroupsQuery` error with `status === 404` ⇒ treat as "no groups feature"; suppress the section (and don't retry per keystroke — RTK caches the error per arg, which is acceptable).

- [ ] **Step 3: Run to verify pass** — `pnpm test -- src/components`. Expected: PASS.

- [ ] **Step 4: Visual check** — `pnpm handoff:dev` from the monorepo root of THIS worktree, then from `/home/rico/bffless/localdev-tools`: `node shot.mjs http://localhost:5173/ --out /tmp/claude-1000/-home-rico-bffless-repos-apps/bd1bc317-4514-4e51-8c13-bdda4dede477/scratchpad/handoff-groups.png --full`. A cold session shows the logged-out fallback (expected); the component tests carry the behavioral verification — this step is a smoke check that the app boots clean (`consoleErrors:0`).

- [ ] **Step 5: Commit** — `git commit -m "feat(handoff): groups section in the share dialog"`

---

### Task 9: Skill doc + skills sync

**Files:**
- Modify: `.claude/skills/handoff-api/SKILL.md` (repo root of the worktree — NOT the app dir)
- Regenerate: `.agents/` mirror via `pnpm skills:sync`

- [ ] **Step 1: Document group grants** in the skill's **Permissions (grants)** section: `POST /api/grants` accepts `principalType: 'group'` + `principalName`; grants match any member of the group; `GET /api/groups?search=` (picker; id/name/memberCount) and `GET /api/me/groups` (own memberships) exist; both require the CE release that ships the member-accessible group endpoints and 404 before it.

- [ ] **Step 2: Sync the mirror** — from the worktree root: `pnpm skills:sync`. Commit BOTH `.claude/skills/**` and the regenerated `.agents/**` (the CI parity check fails otherwise):

```bash
git add .claude/skills/handoff-api .agents
git commit -m "docs(handoff): document group sharing in the handoff-api skill"
```

---

### Task 10: Full verification

- [ ] **Step 1:** `pnpm test` from `apps/handoff/` — full vitest suite green.
- [ ] **Step 2:** `pnpm lint` and `pnpm build` from `apps/handoff/` — clean.
- [ ] **Step 3:** Re-run the port-equivalence matrix explicitly: `pnpm test -- src/lib/anyoneGrantRule.test.ts`.
- [ ] **Step 4:** Push and open PR against `main` titled `feat(handoff): share folders with CE user groups`.

---

## Deployment note (post-merge, human-gated — not a plan task)

Live cutover on j5s.dev, **after** the CE release is deployed:

1. Fold the two new rules (`/api/groups`, `/api/me/groups`) and the rebuilt gate/grants function bundles into the live base `handoff` proxy rule set via MCP (fold-into-base-set convention — prod/preview aliases share the set; no separate preview set).
2. Verify with a non-admin test user: create a group in `admin.j5s.dev/groups`, add the user, grant the group `view` on a folder, confirm the user sees it and that removing them from the group revokes access on the next request.
