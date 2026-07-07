# Feed URLs are path-based, not id-based

**Status: accepted (2026-07-07).** Design-time decision for the folder RSS feed
(bffless/apps, "handoff-rss"). No feed pipeline has shipped yet; this records the URL-shape choice
before it becomes a durable contract in subscribers' readers.

**Decision.** A [[Folder]]'s [[Feed]] is served at a **path-based** URL that mirrors the folder's
content path — `/feed/<encoded-path>.xml` (root is the special case `/feed.xml`) — with an optional
`?token=` for a private folder's [[Share Link]]. It is **not** keyed by the folder's node id.

**Why.** Handoff's whole navigation surface is already path-based (`/tree/<path>`, `/blob/<path>`,
`/api/resolve/<path>`, per-segment encoding in `pathUrl.ts`, spec #177). A path-based feed URL reuses
that machinery directly: the feed pipeline resolves the path exactly as `/api/resolve/*` does, and the
share-dialog affordance builds the URL from the same `encodePath` helper. It also reads naturally in a
reader ("the feed for Design/Q3"). Keeping one addressing scheme across the app avoids a second,
divergent identity system for the same folders.

**Considered options.**
- *Id-based, like `/r/`* (`/feed/<folderId>/<slug>.xml`). **Rejected**, despite being the stabler
  identifier — a node id survives rename and move, so subscriptions wouldn't break. It lost on
  consistency: it would be the only place in the app that addresses a folder by id rather than path,
  needs an id→subtree lookup instead of the existing path-resolve, and produces opaque URLs. The
  stability win was judged not worth a parallel addressing scheme for an internal tool.

**Consequences.**
- **Renaming or moving a folder breaks every existing subscription to it** (the old path 404s; readers
  show a dead feed with no error). This is the accepted cost, chosen with eyes open. If it bites in
  practice, the mitigation is to add an id-based alias later (`/feed/id/<folderId>.xml`) *alongside*
  the path URL — an additive change, not a migration — so this decision is less irreversible than it
  first looks.
- The `.xml` suffix is cosmetic (the `Content-Type: application/rss+xml` header is authoritative); it
  is appended to the whole path, so it always terminates the URL even for a folder whose name contains
  a dot.
- Root's empty path forces the `/feed.xml` special case rather than a bare `/feed/`.
