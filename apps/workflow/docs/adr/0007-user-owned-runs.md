---
status: accepted
date: 2026-09-10
---
# User-owned runs: ownership enforced on reads, and asked for to escape

D14 recorded ownership and enforced it on delete only — *"All members see all runs; `started_by`
is recorded; delete = owner or admin."* That was the shape of a harness with one human on it.
Opening it to a second person makes the unenforced half the whole difference between "my runs"
and "everyone's".

**Decision:** a run belongs to `startedBy`, and every surface defaults to the caller's own runs.
Four doors: **owner**, a **drive nonce** on the row, an **all-scope** the caller must explicitly
ask for, and a **grant** that is stubbed for a later sharing feature. An unreachable run answers
404, never 403 — except an explicit `scope=all` from a caller without the role, which is a 403
rather than a quietly narrowed list. A run with no `startedBy` belongs to nobody and is reachable
only through all-scope; nothing is backfilled.

Three consequences worth naming, because each was the reason a simpler option was rejected:

1. **The exemption is asked for, not assumed.** A project owner/admin sees their own runs until
   they pass `scope=all`. Implicit exemption is self-defeating on a project you own — nothing
   changes, and the MCP connector's app token carries the real global role, so claude.ai would
   keep listing everything.
2. **"Project admin" needs CE.** Only the global role reaches a pipeline; the project role is not
   on `PipelineUser`. CE gains `projectRole`, populated on all four credential paths, and the
   harness bumps `requires.ceMin`. Backing the exemption with the global role instead would mean
   "instance operator", would fire for app tokens and never for API keys (the guard path attaches
   no role; the middleware path pins `'user'`), and would leave two meanings of "admin" depending
   on the CE underneath.
3. **Attribution is captured at dispatch.** A dispatched run is created by the driver, not the
   requester: `client_payload` carries no identity, and the `from-app-token` exchange mints a
   plain session, so **the app token's scopes do not survive** and the driver cannot prove it is
   the driver by scope. `run/drive` writes a `workflow_run_claims` row (`startedBy`, a random
   `driveKey`) and `runs/post` consumes it. The ownership claim is written by the requester's own
   authenticated request; the driver acts on the nonce.

**Why a claim row rather than a pre-created run row:** `definition`, `yaml` and `workflowName`
are `required: true`, and the server cannot produce `definition` — YAML is compiled to a
definition in the browser. Relaxing them is not syncable: `adoptFields` is strictly additive
(new optional fields only), so it would need hand surgery on every install's schema. A new
schema is created cleanly by the same sync.

**Why files are in scope:** ownership over records but not bytes would not be a true sentence —
run ids are in URLs and a path is all anyone needs. Both byte doors (`files/sign` and the
`file_serve_handler` serve rule) are harness rules, so both gate without a CE change, and
sandboxed media already plays from presigned URLs so seeking never touches the gated route. The
per-workflow `inputs/` area stays member-wide: D18 makes it per-workflow and reused across runs.

**Considered:** *ownership as a default filter only* (rejected — a run could still be read by id,
so "private" would be untrue); *no exemption at all* (rejected — no operator path short of the
admin panel, and it makes sharing a blocker rather than a follow-on); *lease-holder may act*
(rejected as the driver's door — any member could claim someone else's queued run, which is
precisely the case this change exists for); *a configured driver identity* (rejected — a required
config value on every install, against the 1-click catalog story, and a permanent account that
can touch every run); *fall back to the global role when `projectRole` is absent* (rejected —
two permanent meanings of "admin").

**Cost:** ~25 of 36 rules gain a gate, and the MCP tool rules are generated so the gate goes in
the generator. Held in check by a single shared `runGate.fn.js`, a CI fence asserting every
run-scoped rule imports it, and the existing parity-test pattern. CE and the harness ship in that
order; installs on an older CE cannot take the harness update.

Spec: 11. Amends D14 (06). Related: ADR-0006 (driven runs), D18 (06), D23 (10).
