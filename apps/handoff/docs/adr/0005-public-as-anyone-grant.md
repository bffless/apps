# Publicness is a grant to an "Anyone" principal, not a visibility field

**Status: accepted (2026-07-07).** Re-verified against the landed share-root work (apps #181 + #182):
the singleton root record `R` exists and grants on root ride the resolve-root pipeline, so making the
whole site public = the ordinary grants write with `folderId: 'root'` and the Anyone principal.

**Decision.** Making a [[Folder]] public means adding the [[Grant]] `(Anyone, View)` to its existing
grants list, where **Anyone** is a reserved [[Principal]] id representing every visitor, signed in or
not. There is no `visibility` field on nodes and no global site-visibility setting. Anyone grants are
capped at `View` — writes always require a real identity (Edit grant, owner, or admin).

**Why.** Handoff already has exactly one access model: `evaluateAccess` over a root→target folder
chain of grants, with [[Inheriting / Restricted]] as the only modifier. A parallel visibility flag
would create a second inheritance system that every gate, chain-walk, and UI surface must merge with
the first, and "who can see this folder?" would no longer have a single answer surface. As a grant,
publicness gets inheritance, revocation, Restricted-cutoff, and the Manage Access UI for free —
`evaluateAccess` changes only in that anonymous viewers (and ungranted signed-in users) match Anyone
grants instead of short-circuiting to `none`.

**Considered options.**
- *Global public/private site setting (settings page + `handoff_settings` schema).* Rejected: too
  coarse — publicness turned out to be a per-subtree concern; site-wide public is just the Anyone
  grant on the root record, so the setting (and the schema, and the page) is redundant.
- *`visibility` field on `handoff_nodes`.* Rejected: second inheritance mechanism, special cases in
  gates and UI, and an ambiguous interaction with Restricted that grants answer uniformly.

**Consequences.**
- The reserved principal id is written into durable `grantsJson` data — renaming it later means a
  data migration, which is why this is an ADR.
- `Restricted` cuts inherited publicness like any other grant: a Restricted subtree stays private
  under a public ancestor unless made public itself. This is deliberate (no special cases), even
  though "public pierces everything" was considered.
- [[Share Link]]s remain the mechanism for *tokened* access to private folders (expiry, revocation);
  a public folder needs no token and its plain URLs (`/tree/…`, `/blob/…`, `/r/*`) work logged-out.
- Anonymous visitors flow through the normal ACL evaluation as viewers holding only Anyone grants.
  The merged gates already evaluate before denying (401 only when unallowed *and* credential-less),
  so the change is confined to the embedded `evalAccess` bodies (and their `src/lib/acl.ts` mirror):
  every viewer's grant scan also matches the Anyone principal, replacing the current
  `no userId → 'none'` short-circuit. Root listing already allows all viewers and filters per child,
  so anonymous public browse at root falls out of the same `evalAccess` change (empty state +
  sign-in when nothing is public).
- The grants write path accepts arbitrary principal ids already, so storing the Anyone grant needs no
  new endpoint — but the write-side `merge` step must cap the Anyone principal at `View` (it would
  otherwise happily store `edit`).
