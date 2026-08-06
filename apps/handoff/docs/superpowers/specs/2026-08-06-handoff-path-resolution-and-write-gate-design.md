# Path resolution and the create-endpoint write gate

*2026-08-06*

## Why

An agent holding a BFFless API key was asked to publish content into
`https://handoff.sahp.app/tree/claude`. It failed, filed a
[feature request](#the-report) concluding that Handoff has no way to turn a path
into a `parentId`, and reached the id by reading the app's raw node table through
the BFFless admin API instead.

Both halves of that conclusion are wrong, and the reasons matter more than the
symptom.

**The resolver already exists.** `GET /api/resolve/<path>`
(`rules/api/resolve/[...path]/get/`) walks the folder tree by name, gates the
result through the real ACL chain, and returns the node. Verified against the
folder from the report:

```
curl -H "X-API-Key: $K" https://handoff.sahp.app/api/resolve/claude
→ 200 {"node":{"id":"a46c2c42-16ca-43e3-8a16-5229c0437305","type":"folder",
        "path":"claude","parentId":"root","ownerId":"49202908-…","mode":"restricted"}}
```

That is exactly the id the agent went around the app to find. It is absent from
the `handoff-api` skill, so an agent driving the API has no way to learn it
exists.

**The key was for the wrong instance.** The report diagnosed "an identity with no
user" from `"ownerId": null` on everything it created. A correctly-scoped key
lists `claude` with a real `ownerId`. CE matches `X-API-Key` against its own
`api_keys` table, where `user_id` is `NOT NULL` — a real key always carries a
user. An unrecognized key simply falls through to anonymous.

**And Handoff accepts writes from callers it never authenticated.** That is what
turned a wrong key into a confusing failure instead of an error. The four create
endpoints have no ACL step at all; their `guard.fn.ts` files check sibling-name
collisions and nothing else. So the anonymous caller's `POST /api/folders`
succeeded structurally, wrote `ownerId: user.id` as `null`, and — where a name
already existed — returned a collision error about a folder the caller could not
see. Every downstream symptom looked like a lookup problem.

The hole is wider than anonymous callers: with no ACL step, *any* authenticated
user can also create inside a folder they hold no access to.

## What we are building

Two independent changes, one shared cause.

### A. Gate the create endpoints

`POST /api/folders`, `POST /api/nodes`, `POST /api/sites`, and
`POST /api/uploads/prepare` gain the access check that `DELETE /api/node` has
had all along: an `allFolders` query, a `folderChain` walk, `evalAccess`, and a
minimum rank.

Two bars, matching how `GET /api/nodes` already treats root:

| Target | Required | Rationale |
| --- | --- | --- |
| `parentId: "root"` or absent | an authenticated user | Root is a shared landing area. `nodes/get` allows the listing itself and filters per row. |
| `parentId: <folder uuid>` | `edit` on the parent chain (`rank >= 2`) | The same bar `DELETE` uses. |

A share-link visitor's viewer caps at `view`, and an `anyone` grant is capped at
`view` by `evalAccess` itself, so neither can write. No anonymous write path
survives — which is what the domain model already says, since `Edit` is never
grantable to an anonymous principal.

**The access check runs before the collision check.** A caller without access
gets `401`/`403` rather than a `409` that discloses whether a name exists. This
is the specific message that sent the reporting agent to the admin database.

Not fixed here: an authenticated user creating at root can still hit `409` on a
sibling name they cannot see. Root is a shared namespace under verbatim keys
(issue #225), so in-folder uniqueness is owner-blind by design. It is documented,
not changed.

### B. Correct the `handoff-api` skill

PR #294 documents the failure honestly but encodes the wrong conclusions, and
would train every future agent into the workaround. Superseded:

- *"Finding a folder's id from its path"* — opens with "There is no endpoint that
  resolves one to the other", teaches tree-walking, and falls back to reading the
  node table via the admin API. Replaced by a section built on
  `GET /api/resolve/<path>`. The admin-table workaround is removed entirely.
- *"Some project keys carry no user identity"* — replaced by "an unrecognized key
  degrades silently to anonymous; you have the wrong instance's key". Its
  two-curl diagnostic is sound and stays; only the conclusion changes, from
  *plan around being unable to delete your mistakes* to *stop and fix the key*.

Kept from #294 unchanged, all independently correct: host-relative `uploadUrl`,
register taking no mime field, `parentId: "root"` versus the root node's UUID
being different destinations, re-PUT to correct a registered file, and
`node.size` going stale after an overwrite.

## Design

### `_shared/writeAccess.ts`

A new shared module beside `_shared/acl.ts`, exporting:

- `viewerFrom(ctx)` → `Viewer`. Builds the viewer from `user` plus the `hf_s`
  share cookie. This logic — `readCookie`, `verifyToken`, and the
  user/share/anonymous branch — is currently copy-pasted into every gate file in
  the rule set; the create gates import it instead of adding four more copies.
- `decideWrite({ folders, parentId, viewer })` →
  `{ allow, deny401, deny403, level }`. Applies the two-bar table above.
  `deny401` when no credential was presented, `deny403` when one was and it was
  insufficient — the same split `resolve` and `node/delete` already use.

`evalAccess` and `folderChain` are imported from `_shared/acl.ts` unchanged. This
adds a consumer of the access model, not a second statement of it, so the
`src/lib/anyoneGrantRule.test.ts` port-equivalence matrix still pins the model.

### Per-rule changes

Each of the four rules, identically:

1. Add an `allFolders` `data_query` step — `nodeType in (folder, root)`,
   `pageSize: 500` — matching the one in `node/delete`.
2. Extend the existing `guard.fn.ts` to call `decideWrite` and fold the verdict
   into its result: `ok` becomes `allow && !collision`, and `collision` is only
   reported when `allow` is true.
3. Add `deny401` (401 `{"error":"unauthorized"}`) and `deny403` (403
   `{"error":"forbidden"}`) `response_handler` steps, conditioned on the guard's
   booleans.

Each branch arrives from the guard as its own plain boolean, because a BFFless
step `condition` can only reference a simple path — the same constraint
`node/delete`'s gate documents.

`uploads/prepare` is included deliberately. It mints presigned URLs, so leaving
it ungated would let an unauthenticated caller write bytes into the bucket even
with the register step closed.

### Skill changes

`plugins/bffless-apps/skills/handoff-api/SKILL.md`, with the two mirrored copies
(`.claude/skills/`, `.agents/skills/`) kept byte-identical as they are today.
Bump `marketplace.json` and `plugin.json` versions, as #294 does.

## Testing

- **Unit**: a decision table over `decideWrite` — anonymous, share-link visitor,
  signed-in non-grantee, `view` grantee, `edit` grantee, owner, admin — crossed
  with root and folder targets. Asserts the `401`/`403` split, not just
  allow/deny.
- **Live smoke** against a preview rule set before merge: anonymous
  `POST /api/folders` → `401`; keyed → `200`; keyed user without `edit` on a
  folder → `403`; the browser UI's create/upload/site flows still succeed.

## Risk

For `apps/*`, a merge is a live rule deploy. The browser UI always sends session
cookies, so signed-in users are unaffected. The only thing that breaks is a
client relying on unauthenticated writes — nothing legitimately does, and
anything that did was writing unowned nodes. Land on a preview rule set and smoke
it first.

Existing unowned nodes are left alone. Two strays from the reporting session
(`claude-test`, `zz-probe-2350045`) have `ownerId: null`, and since CE hardcodes
`role: 'user'` for API-key auth, no API key can reach `edit` on them — they need
an admin in the browser. Out of scope.

## The report

`https://handoff.sahp.app/r/b57dcc6c-52d5-4d23-b036-441ecf3b8b26/folder-id-discovery.md`

Its remaining suggestions are deliberately **not** in scope here, and stand as
separate work:

- Accepting `path` in place of `parentId` on writes (its option 1). Worth doing —
  it removes the lookup round trip entirely — but it is a bigger change across
  four rules and is not needed to fix the reported failure.
- `GET /api/nodes?path=` being silently ignored rather than filtering or erroring.
- Aliasing the root node's UUID to `"root"`, or rejecting it.
- Carrying `prepare`'s `contentType` through to the registered node's mime.
- Refreshing `node.size` after an overwrite.
