# Per-folder ACL enforced by a pipeline + folder-scoped access cookie

**Decision.** All Handoff state — the [[Folder]] tree, content metadata, [[Grant]]s, and
[[Share Link]]s — lives in BFFless data tables; the app has no server of its own (like Studio, its
`/api/*` is a BFFless proxy rule set / pipelines). The view path is fronted by a Handoff **pipeline**
that authenticates the BFFless session, resolves the object's owning Folder, evaluates the ACL
(grants + group membership + [[Inheriting / Restricted]] + share-link cookie), and only then serves.
On the **first** allowed request into a Folder the pipeline sets a **short-lived signed cookie scoped
to that Folder**; subsequent asset requests in the same Site/Folder validate against the cookie
instead of re-running the full evaluation.

**Why.** BFFless's built-in visibility is project/alias/domain-wide only — it cannot express
"only Alice and eng-team can see this folder," which is Handoff's headline feature. So the per-folder
ACL must be the app's own logic. A `Site` load fires many asset sub-requests; re-evaluating the ACL
(and re-reading data tables) on every one would be slow and heavy, so the scoped cookie amortizes the
check. The pattern mirrors BFFless's own `__bffless_share` cookie.

**Consequences.**
- Revocation is not instant: a grant removed mid-session stays effective until the folder cookie
  expires (keep the TTL short, e.g. minutes).
- The cookie must be signed and folder-scoped so it can't be replayed against other folders.
- Group membership is read from BFFless's directory during the full evaluation only (not per asset).
