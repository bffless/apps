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

**Feed logic: duplication and parity.** Title and description appear in RSS via two independent
code paths — `src/lib/feed.ts` (item generation for the `/feed.xml` and `/feed/*` endpoints,
one each) — both of which must stay in sync with each other and with the feed schema. Parity is
verified by `src/lib/feedRule.test.ts`, which co-checks both paths: if one path changes how it
renders a leaf, the test fails.

**Why.** Feeds in v1 are read-only (users discover content via subscriptions). Authors have no
editor UI to set a title or description per-item yet; the fields are there for future UX (e.g.,
a "Rename for this feed" button, or a description editor in the upload flow). For now, storing
the fields decouples data structure from UI — the feature is infrastructure, not surface. Keeping
title/description leaf-only (not on folders) matches Handoff's permission model (folders own
access; leaves own content) and simplifies the feed: a folder's title is its path context, a
leaf's is its authored override.

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
- Two independent feed-rendering code paths must be tested together; changes to one must update
  the other. The `feedRule.test.ts` co-check catches skew.
- Authors can set titles and descriptions now (via direct API calls or future UX); feed readers
  will render them immediately without a migration or feed schema change (backward compatible).
- The feature is stored but not yet surfaced in the UI; the Handoff team can build editor UX
  (upload-time description prompts, rename-for-feed buttons, bulk edits) without schema changes.
