# Title and Description are additive, leaf-only display metadata

**Status: accepted (2026-07-08).** Design-time decision for leaf metadata (Files and Sites).
Relates to **ADR-0005** (publicness as a grant) and **ADR-0007** (feed-exclusion as surfacing) —
read the three together.

**Decision.** A [[File]] or [[Site]] may carry optional **`title`** and **`description`** fields
(both unset by default). These are **leaf-only**: [[Folder]]s do not have them; a folder's title
and description in a [[Feed]] are auto-generated from its path and metadata, unchanged by this
ADR. The [[Title]] overrides the viewer heading and the [[Feed Item]] `<title>`, falling back to
the filename when unset. The [[Description]] is plain-text (v1), escaped into the [[Feed Item]]
`<description>` body, and appears above inline images in a [[File]] item preview.

Both fields are **additive**: the filename remains the leaf's identity for path, deduplication,
and listings. A title is display-only; renaming the file (changing the leaf's actual name) is a
separate operation.

**Write gate.** Title and description are edited via a dedicated `PATCH /api/node/meta` pipeline
port, separate from the folder-only `PATCH /api/node` (which handles folder rename and settings).
Both gates require `edit` access on the target leaf's parent-folder chain (the same gate the
`DELETE` handler uses), ensuring only folder editors can author metadata.

**Partial updates.** The endpoint accepts `{ title?: string, description?: string }` and updates
**only the fields provided**, preserving omitted fields. Both fields may be cleared by passing an
empty string. Updates are **sequential per-field** (not atomically combined) to avoid the
[[CE]] data_update clobber that loses concurrent same-record writes; this is safe because the
fields are independent and user-facing UX does not combine them in a single form.

**Feed logic: duplication and parity.** `src/lib/feed.ts` (`selectFeedItems` / `renderFeedXml`) is
the **reference implementation** — pure functions, unit-testable, not itself in the request path.
The platform has no app server, so the live feed runs from **two embedded pipeline `select`
handlers** inside `bffless/handoff.proxy-rules.json`: one in the `/feed.xml` rule, one in the
`/feed/*` rule. Both are hand-written **ports** of `feed.ts`'s logic into the pipeline's
`function_handler` JS, and are byte-identical to each other. That makes three in-repo copies —
the reference plus two ports — that must stay behaviorally equivalent; `src/lib/feedRule.test.ts`
loads and executes the two embedded handlers directly from the exported JSON and pins their output
against the same fixtures, so a port that drifts from the reference (or from its sibling) fails
the test. (The live BFFless rule set that actually serves traffic is synced from this JSON
separately, post-merge — a merged change to the exported JSON still needs that sync step before
readers see it.)

**Why.** Feed items previously looked bare in readers — a filename and a byte count, no context
for what the item actually was. This feature lets an author set a **Title** and **Description**
per leaf, surfaced both in the Handoff viewer (a details block under the file/site control bar,
`NodeDetails.tsx`) and in the RSS feed item's `<title>`/`<description>`. The editor UI ships as
part of this feature: folder editors see an "Edit details" dialog (title + description fields)
from the viewer, backed by the `updateNodeMeta` mutation — it is not deferred to later work.
Obvious future extensions — folder-level metadata, bulk edit across many leaves, an upload-time
prompt — are still open, but the per-leaf editor itself is delivered here. Keeping title/description
leaf-only (not on folders) matches Handoff's permission model (folders own access; leaves own
content) and simplifies the feed: a folder's title is its path context, a leaf's is its authored
override.

**Considered options.**
- *A folder-level feed title/description, separate from leaf metadata.* **Rejected** — folders
  already have auto-generated titles (breadcrumb paths); Handoff has no folder rename feature
  anyway. Leaf metadata is the motivating case, and folder metadata can be added later without
  breaking this design.
- *Markdown or HTML in the description field.* **Rejected** — Markdown adds a parser dependency
  and a sanitization surface. Plain text is safer and sufficient for the initial UX (text notes).
  If Markdown is needed later, the field can be declared as `descriptionHtml` with its own feed
  logic.
- *Atomic multi-field updates (e.g., `{ title, description }` in one write).* **Rejected** — CE's
  data_update clobber (whole-record read-modify-write) can lose concurrent field-disjoint writes.
  Sequential single-field updates are slower but safe; users are unlikely to edit both fields in
  parallel anyway.

**Consequences.**
- Every [[File]] and [[Site]] node gains two optional text columns (`title`, `description`).
- The `PATCH /api/node/meta` endpoint is the only way to edit them (no folder-level endpoint).
- The endpoint returns the updated node (leaf record with `title`/`description` populated), so
  callers can reflect the write immediately (important for client-side UX).
- Three in-repo feed-rendering copies (the `feed.ts` reference plus the `/feed.xml` and `/feed/*`
  embedded pipeline ports) must be kept behaviorally identical; `feedRule.test.ts` pins that parity
  against shared fixtures, so a port that drifts from the reference — or from its sibling — fails
  the suite.
- Authors set titles and descriptions today from the Handoff viewer itself (`NodeDetails.tsx`'s
  "Edit details" dialog, folder editors only) — no direct API call or future UX is needed to reach
  the feature; feed readers render the values immediately with no migration or feed schema change
  (backward compatible).
- Folder-level metadata, bulk edits across many leaves, and an upload-time description prompt
  remain open future extensions; none require a schema change to add.
