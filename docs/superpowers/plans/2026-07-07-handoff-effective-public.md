# Handoff — Effective Public/Private in the UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the UI tell the truth about publicness. The header badge and the Share dialog's General access section show the folder's **effective** state (Public/Private — two words, no "inherited" label), folder icons are tinted when a folder is effectively public, and "Make private" on a folder that is public only via its parent cuts off inherited access by flipping the folder to `restricted` mode (with a confirmation).

**Architecture:** Effective state = `evaluateAccess` with an anonymous viewer over the ancestor chain — the frontend already has the chain machinery; what it lacks is the **root record's grants** (never exposed to reads today) and a way to **write `mode`**. Backend adds two things: the `GET /api/nodes` response gains a `root: { id, public }` meta (boolean only — no grant/email leakage), and a new `PATCH /api/node` rule updates a folder's `mode` (owner/admin-gated). Everything else is frontend derivation.

**Tech Stack:** BFFless proxy-rule pipelines (embedded JS in `handoff.proxy-rules.json`), React + RTK Query, Vitest + MSW.

## Global Constraints

- **Semantics (ADR-0005, unchanged):** public = the `(anyone, view)` grant; it inherits through `inheriting` folders and is cut by `restricted`. This plan changes NO access-evaluation logic — the gates and `evaluateAccess` stay byte-identical. Only display + the two backend additions above.
- **User decisions (2026-07-07):** badge/dialog show exactly two states, "Public" / "Private", from effective access; public folders get a visibly different folder-icon color; "Make private" on an inherited-public folder flips it to `restricted` after a confirm dialog that explains inherited people-access is also cut (people granted directly on the folder keep access). "Make public" adds the folder's own anyone grant and never touches `mode`.
- **Rule set:** live `handoff` set `5d59f6d8-f492-4e18-9edc-6a9d96677b44`, project `c3b71936-c5f0-4d20-bd3c-d5887289f9d0`; `handoff_nodes` schema `1c5d4802-596e-4f50-a08f-c41fb8f9fab0`. Repo JSON is source of truth; live is updated via MCP post-merge.
- **Editing existing embedded code blobs** (the `shape` step, the response template) goes through a checked-in patch script + guard test. **Authoring the NEW `PATCH /api/node` rule directly in the JSON is fine** (it patches nothing existing). Max existing rule `order` is 30 → the new rule uses 31.
- **Handler sandbox:** `var`/`for` only, no crypto/Buffer/require/fetch; step `condition`s must be simple truthy paths (no operators).
- **Root cannot be restricted:** `PATCH /api/node` accepts `nodeType === 'folder'` only (root/file → 400). Root's publicness is only ever its own anyone grant.
- **Working branch:** `feat/handoff-effective-public` (worktree `repos/apps-handoff-effective-public`). Tests: `pnpm --filter handoff test`; lint: `pnpm --filter handoff lint`.

Verified ground truth (main @ 47b41d2): `GET /api/node?id=root` → 401 (no read-side root resolver exists); no endpoint writes `mode` (only `grantsJson` via grants merge); `GET /api/nodes` response step body is exactly `{"nodes": {{{steps.shape.nodes}}}}` and `shape` ends with `return { nodes: out }; }`; `shape` has `allFolders` (with root records, `nodeType in (folder,root)`) in scope as `folders`; header badge is `FolderView.tsx:947` (`isPrivate = (currentFolder?.grants ?? []).length === 0 && canManage`) rendered at `:1101-1103`; folder icons: `icons.tsx:154` (`FolderIcon`), `icons.tsx:215` (`FileTypeIcon` dispatch), `FolderTree.tsx:73` (tree tint `text-accent-600`/`text-folder`); FolderView passes `null` as `rootNode` to `buildAncestorFolderChain` (`FolderView.tsx:~868`); `rootFolderLink`/`pickRootNode` live in `src/lib/rootNode.ts`.

---

## File structure

- `apps/handoff/src/lib/acl.ts` — `isEffectivelyPublic(chain)`, `childIsPublic(chain, node)` (pure, derived from `evaluateAccess`).
- `apps/handoff/src/lib/rootNode.ts` — `rootMetaNode(meta)`: synthesize a root `HandoffNode` from the new listing meta so the existing chain plumbing carries root grants.
- `apps/handoff/bffless/scripts/patch-root-meta.mjs` *(new)* — adds `rootMeta` to the `shape` step + `"root"` key to the response template.
- `apps/handoff/bffless/handoff.proxy-rules.json` — the above patch + the new `PATCH /api/node` rule (hand-authored).
- `apps/handoff/src/lib/effectivePublicRule.test.ts` *(new)* — guard + behavioral tests for both backend changes.
- `apps/handoff/src/store/handoffApi.ts` — `RootMeta` type, `getRootMeta` query, `setNodeMode` mutation.
- `apps/handoff/src/pages/FolderView.tsx` — real root chain head; effective badge; row icon tints; passes chain/mode into ShareDialog.
- `apps/handoff/src/components/FolderTree.tsx` — public tint threaded recursively.
- `apps/handoff/src/components/ManageAccessPanel.tsx` — `GeneralAccess` effective state + cut-off action with confirm.
- `apps/handoff/src/components/ShareDialog.tsx` — accepts/forwards chain context; note keyed off effective state.
- `apps/handoff/src/mocks/handlers.ts` — root meta in listing, `PATCH /api/node` mock.
- Tests: additions to `acl.test.ts`, `rootNode.test.ts`, `generalAccess.test.tsx`; new `src/mocks/effectivePublic.test.ts`.

---

## Task 1: Pure helpers — effective publicness + root meta node

**Files:**
- Modify: `apps/handoff/src/lib/acl.ts`, `apps/handoff/src/lib/rootNode.ts`
- Test: `apps/handoff/src/lib/acl.test.ts`, `apps/handoff/src/lib/rootNode.test.ts` (append)

**Interfaces:**
- Produces (acl.ts): `isEffectivelyPublic(folderChain: FolderLink[]): boolean` — `evaluateAccess({ folderChain, viewer: {} }) !== 'none'`; `childIsPublic(folderChain: FolderLink[], child: Pick<FolderLink, 'id' | 'ownerId'> & { grants?: Grant[]; mode?: FolderLink['mode'] }): boolean` — appends the child as a `FolderLink` (defaults `grants: []`, `mode: 'inheriting'`) and delegates to `isEffectivelyPublic`.
- Produces (rootNode.ts): `export interface RootMeta { id: string | null; public: boolean }`; `rootMetaNode(meta: RootMeta | undefined): HandoffNode | null` — `null` when `meta?.id` is falsy; otherwise a synthetic root node `{ id: meta.id, type: 'root', name: 'My Files', parentId: '', ownerId: null, grants: meta.public ? [{ principalId: ANYONE_PRINCIPAL, level: 'view' }] : [], mode: 'inheriting', size: null, mime: null, url: null, createdAt: 0 } as HandoffNode` (adapt filler fields to the actual `HandoffNode` type). Import `ANYONE_PRINCIPAL` from `./acl`.

- [ ] **Step 1: Failing tests** — append to `acl.test.ts`: chain with anyone on head → `isEffectivelyPublic` true; empty-grants chain → false; restricted tail under public head → false; `childIsPublic` with public parent + default child → true, with `mode: 'restricted'` child → false, with private parent + child own anyone → true. Append to `rootNode.test.ts`: `rootMetaNode({ id: 'R', public: true })` carries one anyone/view grant; `public: false` → `grants: []`; `undefined`/`{ id: null, public: false }` → `null`.
- [ ] **Step 2: Run** `pnpm --filter handoff test -- acl` and `-- rootNode` → FAIL (exports missing).
- [ ] **Step 3: Implement** per the Interfaces block (both helpers are 3-6 lines each; no changes to `evaluateAccess` itself).
- [ ] **Step 4: Run** both filters → PASS; full suite green.
- [ ] **Step 5: Commit** `feat(handoff): effective-public helpers (isEffectivelyPublic, rootMetaNode)`

---

## Task 2: Backend — root meta on the listing response

**Files:**
- Create: `apps/handoff/bffless/scripts/patch-root-meta.mjs`
- Modify: `apps/handoff/bffless/handoff.proxy-rules.json` (via script only)
- Test: `apps/handoff/src/lib/effectivePublicRule.test.ts` *(new)*

**Interfaces:**
- Produces: `GET /api/nodes` responses become `{"nodes": [...], "root": {"id": <uuid|null>, "public": <bool>}}` on every allowed listing. `shape` gains a `rootMeta` output computed from the already-loaded `folders` array (find `nodeType==='root'`, parse `grantsJson`, `public` = contains `principalId==='anyone'`). No other rule changes.

- [ ] **Step 1: Failing guard + behavioral test** — new file, `@vitest-environment node`, same extraction idiom as `anyoneGrantRule.test.ts`: (a) the `/api/nodes` GET `response` step body equals `{"nodes": {{{steps.shape.nodes}}}, "root": {{{steps.shape.rootMeta}}}}`; (b) execute the real `shape` handler (`new Function`) with a `steps` fixture whose `allFolders` contains a root record with an anyone grant (grantsJson as a JSON **string**) plus one folder → returned `rootMeta` is `{ id: <root id>, public: true }` and `nodes` still lists the folder; (c) same fixture with `grantsJson: '[]'` → `public: false`; (d) no root record → `{ id: null, public: false }`. (Check the shape handler's exact `steps` input keys by reading its head in the JSON first — it destructures `{ steps }` and reads `steps.allFolders`, `steps.query`, `steps.pre`, etc.; build the minimal fixture that reaches the return.)
- [ ] **Step 2: Run** `pnpm --filter handoff test -- effectivePublicRule` → FAIL.
- [ ] **Step 3: Patch script** — `patch-root-meta.mjs`, same conventions as siblings (idempotency marker: `rootMeta`; loud exit 1 on missing anchors): in the `/api/nodes` GET rule only: (a) in step `shape`'s code, replace the exact tail `return { nodes: out }; }` with `var rootRec=null;for(var ri=0;ri<folders.length;ri++){if((folders[ri]||{}).nodeType==='root'){rootRec=folders[ri];break;}} var rootId=null;var rootPublic=false; if(rootRec){rootId=rootRec.id||rootRec.recordId||rootRec.record_id||null; var rg=rootRec.grantsJson; if(typeof rg==='string'){try{rg=JSON.parse(rg);}catch(e){rg=[];}} if(rg&&Object.prototype.toString.call(rg)==='[object Array]'){for(var gi=0;gi<rg.length;gi++){if((rg[gi]||{}).principalId==='anyone'){rootPublic=true;break;}}}} return { nodes: out, rootMeta: { id: rootId, public: rootPublic } }; }`; (b) replace the `response` step body `{"nodes": {{{steps.shape.nodes}}}}` with `{"nodes": {{{steps.shape.nodes}}}, "root": {{{steps.shape.rootMeta}}}}`. Run it; validate JSON parses.
- [ ] **Step 4: Run** the test file → PASS; full suite green (the `anyoneGrantRule` structural tests must still count 7 identical evalAccess copies — this patch must not touch them).
- [ ] **Step 5: Commit** `feat(handoff): listing response carries root {id, public} meta`

---

## Task 3: Backend — new `PATCH /api/node` rule (set folder mode)

**Files:**
- Modify: `apps/handoff/bffless/handoff.proxy-rules.json` (append the new rule — direct authoring)
- Test: `apps/handoff/src/lib/effectivePublicRule.test.ts` (append)

**Interfaces:**
- Produces: `PATCH /api/node` with body `{ id: <uuid>, mode: 'inheriting' | 'restricted' }` → 200 `{"id","mode"}` for the folder's owner or an admin; 400 on bad id/mode or non-folder target (root and files rejected); 403 otherwise (including anonymous). Order 31.

The new rule (append to the `rules` array; match sibling rules' top-level field shape — copy the structural fields (`proxyType` etc.) from the existing `DELETE /api/node` rule and set):

```json
{
  "pathPattern": "/api/node",
  "method": "PATCH",
  "order": 31,
  "description": "Set a folder's inheritance mode (inheriting|restricted); owner/admin only",
  "pipelineConfig": {
    "name": "node-set-mode",
    "steps": [
      { "id": "pre", "name": "pre", "handlerType": "function_handler",
        "config": { "code": "function handler({ request, user }) { var b=(request&&request.body)||{}; var id=String(b.id||''); var mode=(b.mode==='restricted')?'restricted':((b.mode==='inheriting')?'inheriting':''); var UUID=/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/; var valid=!!id&&UUID.test(id)&&!!mode; return { id: id, mode: mode, valid: valid, isAdmin: !!user&&user.role==='admin', uid: (user&&user.id)||null }; }" } },
      { "id": "folder", "name": "folder", "handlerType": "data_query",
        "config": { "schemaId": "1c5d4802-596e-4f50-a08f-c41fb8f9fab0", "recordId": "steps.pre.id", "condition": "steps.pre.valid" } },
      { "id": "check", "name": "check", "handlerType": "function_handler",
        "config": { "code": "function handler({ steps }) { var pre=steps.pre||{}; var f=steps.folder||null; var isFolder=!!f&&f.nodeType==='folder'; var isOwner=!!pre.uid&&!!f&&f.ownerId===pre.uid; var bad=(pre.valid!==true)||!isFolder; var allowed=!bad&&(pre.isAdmin===true||isOwner); return { allowed: allowed, badRequest: bad, denied: !allowed&&!bad }; }" } },
      { "id": "save", "name": "save", "handlerType": "data_update",
        "config": { "schemaId": "1c5d4802-596e-4f50-a08f-c41fb8f9fab0", "recordId": "steps.pre.id", "fields": { "mode": "steps.pre.mode" }, "condition": "steps.check.allowed" } },
      { "id": "ok", "name": "ok", "handlerType": "response_handler",
        "config": { "body": "{\"id\": \"{{steps.pre.id}}\", \"mode\": \"{{steps.pre.mode}}\"}", "status": 200, "condition": "steps.check.allowed", "contentType": "application/json" } },
      { "id": "bad", "name": "bad", "handlerType": "response_handler",
        "config": { "body": "{\"error\":\"invalid request\"}", "status": 400, "condition": "steps.check.badRequest", "contentType": "application/json" } },
      { "id": "denied", "name": "denied", "handlerType": "response_handler",
        "config": { "body": "{\"error\":\"forbidden\"}", "status": 403, "condition": "steps.check.denied", "contentType": "application/json" } }
    ]
  }
}
```

- [ ] **Step 1: Failing tests** (append): rule exists at `/api/node` PATCH with the 7 step ids in order; behavioral via `new Function` on the real `pre` and `check` handlers: owner+folder → allowed; admin+folder → allowed; non-owner user → denied (not badRequest); anonymous (`user` null) → denied; `nodeType:'root'` target → badRequest; bad mode value → badRequest; non-uuid id → badRequest.
- [ ] **Step 2: Run** → FAIL (rule absent).
- [ ] **Step 3: Author the rule** in the JSON (adapt top-level structural fields to match siblings exactly — compare against the `DELETE /api/node` rule object; keep this plan's `pipelineConfig` verbatim). Validate JSON parses.
- [ ] **Step 4: Run** → PASS; full suite green.
- [ ] **Step 5: Commit** `feat(handoff): PATCH /api/node sets a folder's inheritance mode`

---

## Task 4: Frontend data layer — `getRootMeta` + `setNodeMode` (+ MSW mocks)

**Files:**
- Modify: `apps/handoff/src/store/handoffApi.ts`, `apps/handoff/src/mocks/handlers.ts`
- Test: `apps/handoff/src/store/rootMeta.test.ts` *(new, follow `resolvePath.test.ts`'s store-construction pattern)*

**Interfaces:**
- Produces (handoffApi): `getRootMeta: query<RootMeta, void>` — GET `api/nodes?parentId=root`, `transformResponse: (raw) => raw.root ?? { id: null, public: false }`, `providesTags: ['Grant']` (so the public toggle's existing `invalidatesTags: ['Grant', ...]` refreshes it); `setNodeMode: mutation<{ id: string; mode: string }, { id: string; mode: 'inheriting' | 'restricted'; parentId?: string }>` — PATCH `api/node` body `{id, mode}`, `invalidatesTags: (_r,_e,{id,parentId}) => ['Grant', { type: 'Node', id }, ...(parentId ? [{ type: 'Node', id: parentId }] : [])]`. Reuse the `RootMeta` type from `rootNode.ts` (re-export or import — one definition only).
- Produces (mocks): the `GET /api/nodes` mock adds `root: { id: <ROOT_RECORD_ID if seeded, else null>, public: <root record's grants contain 'anyone'> }` to every 200 listing response; new `http.patch('/api/node')` mock mirroring the real rule (400 invalid/non-folder incl. root, 403 non-owner/anonymous, else update `nodeAcl`+`nodes` mode and 200).

- [ ] **Step 1: Failing tests** — via a minimal store + MSW server: `getRootMeta` returns `{id, public:true}` after `seedRoot()` + `setMockGrants(ROOT_RECORD_ID, [anyone])`, and `{id: ROOT_RECORD_ID, public: false}` without the grant; `setNodeMode` flips a seeded folder to restricted (assert via mock state) and rejects (403) for a non-owner `setMockUser`.
- [ ] **Step 2: Run** `pnpm --filter handoff test -- rootMeta` → FAIL.
- [ ] **Step 3: Implement** endpoints + mocks per Interfaces.
- [ ] **Step 4: Run** → PASS; full suite green (existing listing-shape assertions in other tests may need the additive `root` key tolerated — fix fixtures, never loosen assertions about `nodes`).
- [ ] **Step 5: Commit** `feat(handoff): root-meta query and set-mode mutation`

---

## Task 5: Frontend — truthful badge + tinted folder icons

**Files:**
- Modify: `apps/handoff/src/pages/FolderView.tsx`, `apps/handoff/src/components/FolderTree.tsx`
- Test: `apps/handoff/src/pages/folderBadge.test.tsx` *(new, follow `pathRoutes.test.tsx`'s render pattern)*

**Interfaces:**
- Consumes: `useGetRootMetaQuery`, `rootMetaNode`, `isEffectivelyPublic`, `childIsPublic` (Tasks 1+4).
- Produces (FolderView): `const { data: rootMeta } = useGetRootMetaQuery()`; `const rootNode = rootMetaNode(rootMeta)` passed as the 3rd arg to `buildAncestorFolderChain` (replacing the current `null`); badge derivation replacing `FolderView.tsx:947`: `const isPublicHere = chainReady && isEffectivelyPublic(currentFolder && folderChain[folderChain.length - 1]?.id !== currentFolder.id ? [...folderChain, { id: currentFolder.id, ownerId: currentFolder.ownerId, grants: currentFolder.grants, mode: currentFolder.mode }] : folderChain)` (at root the chain head alone decides); the render at `:1101-1103` becomes a two-state badge shown whenever `chainReady` (viewers included): `Public` (accent style, small globe) / `Private` (current muted style). Row icons: where the listing renders a folder row's icon, compute `childIsPublic(folderChain, node)` and pass a tint (`text-accent-600` when public; existing `text-folder` otherwise) — thread via the icon `className`, matching how `FolderTree.tsx:73` already varies the class.
- Produces (FolderTree): thread `parentPublic: boolean` recursively from `rootMeta?.public ?? false` at the top level; a tree folder is public iff `(parentPublic && node.mode !== 'restricted') || hasAnyoneGrant(node.grants ?? [])`; tint its `FolderIcon` `text-accent-600` when public (keep the `isCurrent` accent precedence as-is).

- [ ] **Step 1: Failing tests** — render FolderView at root (MSW: `seedRoot` + anyone grant on root + one child folder): badge text `Public` appears; child folder icon element carries the public tint class (assert via `data-testid` or class query on the row icon); without the root grant: badge `Private`, no tint. Also: a restricted child under public root renders untinted.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per Interfaces. Keep `EmptyState`, delete flows, and every other FolderView behavior untouched; `isPrivate` (947) is fully replaced, not augmented.
- [ ] **Step 4: Run** new file + full suite + lint → green.
- [ ] **Step 5: Commit** `feat(handoff): effective Public/Private badge and public folder tints`

---

## Task 6: Frontend — GeneralAccess effective state + cut-off action

**Files:**
- Modify: `apps/handoff/src/components/ManageAccessPanel.tsx`, `apps/handoff/src/components/ShareDialog.tsx`, `apps/handoff/src/pages/FolderView.tsx` (dialog call sites)
- Test: `apps/handoff/src/components/generalAccess.test.tsx` (extend)

**Interfaces:**
- `GeneralAccess` props become `{ folderId: string; parentChain?: FolderLink[]; folderMode?: 'inheriting' | 'restricted' }` (both optional — absent means behave as today, own-grant only). Derivations: `ownAnyone = hasAnyoneGrant(grants)`; `inheritedPublic = folderMode !== 'restricted' && isEffectivelyPublic(parentChain ?? [])`; `effectivePublic = ownAnyone || inheritedPublic`. Display: `Public`/`Private` from `effectivePublic`, copy unchanged otherwise.
- Actions: `Private` → "Make public" = `addGrant(anyone, view)` (unchanged, never touches mode). `Public` with `ownAnyone && !inheritedPublic` → "Make private" = revoke (unchanged). `Public` with `inheritedPublic` → "Make private" opens an in-dialog confirm (reuse the app's existing confirm-dialog pattern — see `DeleteConfirmDialog` in FolderView for idiom) with copy: heading **"Make this folder private?"**, body **"People who can only see it through a parent folder — including everyone on the internet while a parent is public — will lose access. People added directly to this folder keep access."**, confirm button "Make private" → `setNodeMode({ id: folderId, mode: 'restricted' })` and, if `ownAnyone`, also `revokeGrant(anyone)`.
- `ShareDialog` gains optional `parentChain?: FolderLink[]` and `folderMode?: 'inheriting' | 'restricted'`, forwarded to `GeneralAccess`; its share-links `isPublic` note uses the same effective derivation. FolderView passes `parentChain={folderChain}` (the chain **up to and including the current folder's parent** — when sharing the current folder, that's `folderChain` minus the current folder's own link if present; when sharing a file row, the containing folder is the current folder so the same value applies) and `folderMode={currentFolder?.mode ?? 'inheriting'}` (root: `'inheriting'` with `parentChain=[]`... at root pass `parentChain={[]}` and let root's own grant drive state).
- [ ] **Step 1: Failing tests** (extend `generalAccess.test.tsx`): (a) `parentChain` carrying an anyone grant + no own grant → shows `Public` and "Make private"; clicking it shows the confirm copy; confirming issues PATCH (assert mock mode flipped) and the panel re-renders `Private`; (b) own-grant folder (no chain) → unchanged revoke path still passes; (c) `folderMode:'restricted'` + public parentChain → `Private`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** extended file + full suite + lint → green.
- [ ] **Step 5: Commit** `feat(handoff): General access shows effective state; cut off inherited access with confirm`

---

## Task 7: MSW end-to-end — inherited display + cut-off round trip

**Files:**
- Create: `apps/handoff/src/mocks/effectivePublic.test.ts`
- Modify: `apps/handoff/src/mocks/handlers.ts` (only if gaps surface)

**Interfaces:** consumes everything above.

- [ ] **Step 1: Failing tests** (fetch-level, same style as `anyoneGrant.test.ts`): (1) public root + fresh subfolder → anonymous listing of the subfolder is 200 AND the root listing's `root.public` is true; (2) owner PATCHes the subfolder to `restricted` → anonymous subfolder listing 401 while anonymous root listing stays 200 and still shows... the subfolder is now NOT in the anonymous root listing (per-child filter); (3) PATCH by non-owner → 403 and mode unchanged; (4) PATCH the root record id → 400.
- [ ] **Step 2: Run** → FAIL where the mocks lack behavior; **Step 3:** close only real gaps in `handlers.ts` (mirroring the real rule semantics); **Step 4:** file + full suite green. **Step 5: Commit** `test(handoff): effective-public e2e (inherit, cut-off, guards)`

---

## Task 8: Live rollout + docs (post-merge, operational)

- [ ] **Step 1:** Live-update the `GET /api/nodes` rule's `pipelineConfig` (root meta) via `update_proxy_rule`, and CREATE the `PATCH /api/node` rule via `create_proxy_rule` on set `5d59f6d8-…` (order 31). Byte-diff verify the whole set against the repo JSON afterward.
- [ ] **Step 2:** Smoke on `handoff.j5s.dev`: root badge reads Public (root is currently public); anonymous root listing carries `root.public: true`; create a scratch subfolder → tinted public in UI, anonymous-listable; Make private on it → confirm dialog → anonymous 401, tint gone, badge Private inside it; root still Public; delete the scratch folder.
- [ ] **Step 3:** `apps/handoff/bffless/README.md`: document `PATCH /api/node` and the `root` listing meta under ACL enforcement (2 short paragraphs). Commit via PR.

---

## Self-review notes

- The gates/`evaluateAccess` are untouched — `anyoneGrantRule.test.ts`'s 7-identical-copies guard doubles as the regression net proving it.
- Root meta exposes only `{id, public}` — no grant emails leak to viewers/anonymous.
- The badge/tint math runs entirely on data listings already return (grants arrays) plus the new boolean; no per-row network calls.
- `Make public` after a cut-off leaves `mode: 'restricted'` (folder is public via its own grant; people-inheritance stays cut until someone re-grants or a future mode UI un-restricts) — deliberate, matches "Make public = add own grant, never touches mode".
- FolderTree tint uses parent-recursion rather than full chains — equivalent for display purposes and avoids N² chain builds.
