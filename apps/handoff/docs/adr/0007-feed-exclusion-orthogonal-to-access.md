# Feed-exclusion is a surfacing flag, orthogonal to the access model

**Status: accepted (2026-07-07).** Design-time decision for the folder RSS feed. Relates to
**ADR-0005** (publicness is a grant, not a mode) — read the two together.

**Decision.** A [[Folder]] carries a **`feedExcluded`** boolean (default `false`). A feed-excluded
folder — and its whole subtree — produces **no [[Feed Item]]s** in any [[Feed]]. It is a per-folder,
subtree-inheriting bit, evaluated during the same root→target `parentId` walk the access gate already
runs (a leaf is fed only if no ancestor is feed-excluded). It is **not** a [[Grant]], not a
[[Principal]], and does not interact with [[Inheriting / Restricted]].

**Why.** ADR-0005 established that Handoff has exactly one access model and that publicness must be a
grant rather than a parallel `visibility` field — so that "who can see this folder?" has a single
answer surface. Feed-exclusion looks superficially like it violates that ("another per-folder
inherited bit"), so the distinction must be explicit: **ADR-0005's principle governs *access*;
feed-exclusion is *surfacing*.** An excluded folder is fully accessible — browsable at its URL, its
files openable, its share links valid; it is simply absent from the RSS *projection*. Access and
"does this appear in the feed" are genuinely different axes, so folding exclusion into the grant model
would be the actual mistake — it would make an ordinary "hide my `assets/` images from the feed"
gesture look like an access change, and it can't be expressed as a grant anyway (there is no principal
to deny; the folder stays visible to everyone who could already see it).

**Considered options.**
- *A negative/deny grant, or a `(Anyone, hidden)` pseudo-grant.* **Rejected** — deny grants don't
  exist in this model (ADR-0002/0005), and it would conflate not-in-feed with not-visible.
- *A feed-side heuristic that parses markdown and suppresses referenced images.* **Rejected** — needs
  a markdown parser in the pipeline (CE work), only catches *referenced* files, and is fragile. A
  user-driven folder flag is simpler and general (drafts, working files, any subtree).
- *Per-leaf exclusion (files, not just folders).* **Deferred** — folder-level covers the motivating
  case (put assets in a subfolder, exclude it) and keeps the toggle on the unit permissions already
  attach to. Loose files next to a post can't be individually hidden in v1.

**Consequences.**
- Two per-folder inherited bits now exist — `Restricted` (access) and `feedExcluded` (surfacing). They
  are independent: a folder can be public **and** feed-excluded, or private **and** fed (via a share
  link). Any UI that reads one must not assume the other.
- The flag lives on the folder node alongside `grantsJson`/`mode`; toggling it is an Owner/admin action
  (it sits with folder settings, not content editing).
- Because it rides the existing ancestor walk, it adds no query and no new access semantics.
