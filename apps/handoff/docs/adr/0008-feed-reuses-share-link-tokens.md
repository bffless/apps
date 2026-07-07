# A private feed URL is a Share Link bearer credential

**Status: accepted (2026-07-07).** Design-time decision for the folder RSS feed. Builds on
**ADR-0002** (per-folder ACL + `/r/*` tokened serve).

**Decision.** A private [[Folder]]'s [[Feed]] carries an existing [[Share Link]] `?token=`, and
**every enclosure/link URL inside the feed embeds that same token**. There is no feed-specific token
type and no feed-specific expiry policy: the feed's access is the share link's access, for the share
link's lifetime, revoked when the link is revoked. A folder with several share links therefore has
**one renderable feed per link** (each its own token, expiry, and revocation). Public folders (an
[[Anyone]] grant, direct or inherited) get a **tokenless** feed URL. The feed endpoint runs the
folder's `evaluateAccess` and nothing else.

**Why.** A feed reader polls a URL for months with **no cookies and no login**, and it fetches each
item's media server-side the same way — so access must live entirely in the URL, on every URL, and
must not expire on its own. Handoff's [[Share Link]] is already exactly this: a folder-scoped,
URL-borne, optionally-expiring, revocable `View` credential over the folder *and its subtree* — which
is precisely a feed's scope. `/r/<id>?token=` already validates such a token and 302s to signed bytes.
Reusing it means the feature ships with **zero new auth surface** and "share" naturally becomes "get a
feed," which is how the operator described it.

**Considered options.**
- *A dedicated feed-token / feed-principal type, independently revocable.* **Rejected** — a second
  tokened-access surface to build and secure (new principal in `evaluateAccess`, new revoke UI) for no
  behavioural gain; share links already have the exact lifecycle (No-expiry / 1d / 7d / 30d, revoke).
- *One canonical feed per folder.* **Rejected** — would need a designated "primary" token and rules for
  what happens when it's revoked; per-link feeds fall straight out of the share model with no new
  lifecycle.

**Consequences.**
- **The feed URL is a bearer credential.** Anyone who has it has share-link-level `View` on the whole
  subtree, including raw file bytes via the embedded enclosure tokens — for as long as the link lives.
  This is the same exposure as handing out a share link today; revoking the link kills the feed and its
  enclosure URLs together.
- Autodiscovery (`<link rel="alternate">`) is emitted **only for public folders** — never for private
  ones, since a discoverable link must not carry a token.
- Feed responses must be cached keyed on the **full URL including the token** (public feeds, being
  tokenless, cache and share safely; private feeds never cross-leak because a different token is a
  different cache key). The `/feed/*` path must not be blanket-cached ignoring the query string.
- A Restricted-private descendant under a public folder stays out of the public feed automatically,
  because `evaluateAccess(Anyone, leaf)` returns `none` there — no separate feed-side check needed.
