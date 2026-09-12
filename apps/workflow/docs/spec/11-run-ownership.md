# 11 — Run ownership

Runs are **user-driven**: a run belongs to the person who started it, and that is what every
surface shows by default. This document is the ownership model, the doors through it, and the
sweep that makes it true across the rule set. It amends D14 ("all members see all runs"), which
was the M1 shape for a harness with one human on it.

Decisions D26–D29; ADR-0007. Related: 05 (run records), 06 (access, files, D18), 07 (the
headless driver), 10 (the MCP endpoint and its scopes).

## Why this changes

D14 was written when the harness had exactly one member, and it says so plainly: *"All members
see all runs; `started_by` is recorded; delete = owner or admin."* Ownership was already
recorded and already enforced on delete — it simply was not enforced on **reads**. Opening the
harness to a second person makes that gap the difference between "my runs" and "everyone's".

The live data confirms the gap is latent rather than exercised: on `workflow.bffless.dev` all 13
runs carry the same `startedBy`, including the 7 headless ones, because the driver's app token
belongs to the same person. Nothing has to be migrated; the model has to be built **before** a
second identity exists, not after.

## The model (D26)

Every run has exactly one **owner**: `startedBy`, a CE user id, written once at creation and
never overwritten by any later call. Default visibility on every surface — harness UI, MCP
endpoint, `workflow-headless`, raw API — is **the caller's own runs**.

A caller may read or act on a run through exactly one of four doors:

| Door | Check | Notes |
|---|---|---|
| **Owner** | `startedBy === user.id` | the ordinary path |
| **Drive nonce** | the request carries the run's `driveKey` | how a dispatched driver acts on a run it does not own (D28) |
| **All-scope** | `user.projectRole` ∈ {`owner`, `admin`} **and** the caller asked for it | never implicit (D27) |
| **Grant** | a row in `workflow_run_grants` | **not built** — the gate calls a stub that returns false, so sharing lands without reopening the sweep |

**Ownerless runs.** A run whose `startedBy` is empty belongs to nobody: invisible to every
member, reachable only through all-scope. This fails closed, needs no backfill, and today
matches zero rows in production. A row written before `startedBy` existed is therefore
admin-only by construction — the same rule `run/delete`'s gate already applies.

**404, not 403.** A run the caller cannot reach answers *not found*, indistinguishable from an
unknown id, so a run id in a URL leaks nothing about whether it exists. The one exception is an
explicit `scope=all` from a caller without the role: that is a **403**, because silently
narrowing a list the caller deliberately asked to widen would be a lie about what they are
looking at.

## The exemption is asked for, never assumed (D27)

A project owner or admin does not automatically see every run. They see their own, exactly like
anyone else, until they ask: `?scope=all` on the list, `scope: "all"` on `workflow.runs`,
`--all` on the CLI, an "All runs" toggle in the UI.

A single run's ask is spelled differently from a list's, because a single-run route has no query
string of its own to widen: `run/get`, `run/update`, `run/lease`, `run/fork`, `run/drive` and the
file routes read the **`x-workflow-scope: all`** header, while `runs/get` (and its MCP twin) read
`scope=all` — the list's own argument. There is a third spelling, for the run-scoped MCP tools
that only read: they take `scope` as a tool argument (§Gated below, apps#673), because an MCP
caller has no header and no query string to widen either.

This is not caution for its own sake. On a project you own, an implicit exemption means nothing
changes — you open the harness and still see everyone's runs — and the feature is invisible on
the surface you use most. Worse, the MCP connector authenticates with an **app token, which
carries the real global role** (`pinRoleLikeApiKey: false` for pipelines, `app-token.util.ts`),
so Claude Desktop would keep listing everything. Explicit widening keeps "what will I see when I
open this page" a property of the request, not of who happens to be asking.

### Why `projectRole`, and why it needs CE

Only the **global** role reaches a pipeline today. `PipelineUser` carries `role` — CE's
instance-wide `admin | user | member` (`users.schema.ts`) — and not the **project** role
(`owner | admin | contributor | viewer`, `project-permissions.schema.ts`). "Admin of this
project" is not currently expressible in a rule, which is why `run/delete`'s existing gate
matches global admin only and its `'owner'` branch is dead code.

The credential paths also disagree about the global role, deliberately:

| Credential | `user.role` in a pipeline |
|---|---|
| SuperTokens session | real global role |
| App token (MCP/OAuth, the driver) | real global role — not pinned for pipelines |
| `X-API-Key` (guard path) | **absent** — the guard attaches `{ id, apiKeyId, projectId }` |
| `X-API-Key` (middleware path) | pinned to `'user'` |

So an exemption backed by the global role would fire for app tokens, never for API keys, and
mean "instance operator" rather than "runs this project". CE therefore gains
`projectRole?: 'owner' | 'admin' | 'contributor' | 'viewer'` on `PipelineUser`, resolved from
`project_permissions` for the pipeline's project and populated on **all four** credential paths.
It is a project fact, orthogonal to the global-role pinning — and an API key is already fenced to
its project — so this does not reopen what the pinning closed.

`whoami` reports it too, since whether to render the toggle is the one thing the SPA cannot work
out for itself.

**Sequencing:** CE ships first; the harness bumps `requires.ceMin` and assumes the field is
there. Self-hosted installs on an older CE cannot take the harness update — accepted, in exchange
for one meaning of "admin" rather than two.

## One gate, not twenty-five copies

The sweep touches ~25 of the rule set's 36 rules. It stays maintainable because the check lives
in **one shared bundle**, `mcp-fn/runGate.fn.js`, imported the way `route.fn.js` and
`reply.fn.js` already are. It takes `{ steps.<runQuery>, request, user }` and returns the flag
shape `run/delete`'s gate already returns (`ok / notFound / forbidden / …`), so every rule keeps
the established pattern: one literal-status `response_handler` per flag, every later step gated
on `steps.gate.ok`. Nothing new is invented per rule.

The gate never throws. A throw is a generic `FUNCTION_ERROR`, not a status we get to choose, so
every refusal is a returned flag — the constraint `run/delete`'s gate already documents.

**Gated** — everything that names an existing run: `run/get`, `run/update`, `run-step/post`,
`run/lease`, `run/fork`, `run/drive` (resume), `files/sign`, `files/prepare`, `files/register`,
`api/uploads/workflows/[...path]`, and the eleven run-scoped MCP tools — the seven catalog tools
that take a `runId` (`status`, `await`, `outputs`, `sign`, `cancel`, `resume`, `submitStep`) and
the four host tools (`submit`, `annotate`, `pipeline`, `stepView`). `run/delete` moves off its
private gate onto the shared one.

The five of those eleven that only **read** — `status`, `await`, `outputs`, `sign` and
`stepView` — take the same optional `scope` argument `runs` takes, so an MCP caller with the
project role can ask to read a run that is not theirs (apps#673). The six that act on a run take
none: sharing/grants, not `scope`, is how you act on someone else's run. A single-run gate that
refuses answers `No such run`, never a scope error — an invisible run and a missing one read the
same (D29).

Two of the catalog's three surfaces do not ask it yet, and the argument is declared for one
contract rather than three. The **MCP endpoint** honours it — the gate reads `request.body.scope`.
The **harness page** registers the same schemas through WebMCP but its executors drop `scope`;
the page's ask is the "All runs" toggle, which travels as the header on every request. The
**step view** never sends it: the widget is mounted from `workflow.submitStep`'s tool input and
calls `workflow.stepView { runId, step }`, so `stepView`'s `scope` is symmetry with the other
reads, not a capability a shipped caller exercises. Threading the asked-for scope through those
two surfaces is follow-up work, not part of apps#673.

**Filtered, not gated** — the two list endpoints, which take the scope treatment below:
`runs/get` and its MCP twin `mcp-tools/runs`. Both default to the caller's own runs and both
answer 403 to a `scope=all` the caller has no role for; the MCP tool reads its scope from the
tool arguments rather than the query string, and is otherwise the same two-query shape.

**Neither** — nothing here names a run: `project/get`, `aliases/get`, `whoami`,
`mcp-tools/list`, `mcp-tools/describe` (it takes `{ impl, workflow }` and describes a
*workflow*, not a run), `mcp-tools/start` (it creates one — `run/drive` carries the gate for
its `resume` mode), `_custom/well-known`, `api/auth/*`, `api/workflow/mcp`.

> The MCP tool rules are **generated** (`scripts/build-mcp.mjs` from `src/mcp/mcpConfig.ts` —
> "do not edit"). The gate goes in the generator; `bundle.test.ts` keeps the committed files
> honest by comparing them to a fresh render.

## Listing: two queries, because a filter cannot be conditional

`data_query` filters are static YAML. There is no way to drop one conditionally, and `eq` has no
wildcard — so "mine or everything" cannot be one query with a swapped filter value.

`runs/get` therefore gets a `scope` `function_handler` followed by **two conditional
`data_query` steps**, and `shape.fn.js` reads whichever ran:

| step | condition | filters |
|---|---|---|
| `mine` | `steps.scope.isMine` | `impl`, `workflow`, `startedBy: { op: eq, value: user.id }` |
| `all` | `steps.scope.isAll` | `impl`, `workflow` |

This is the pattern the rule set already uses for mutually exclusive branches. `user` is a real
expression root (`EXPRESSION_ROOTS`, `expression-evaluator.ts`) and `user.id` resolves to `null`
for a caller CE could not tie to a person — which `eq`-matches nothing, so an unresolvable
caller sees an empty list rather than everyone's.

**`scope` is a catalog change.** `RUNS_SCHEMA` today takes `{ impl, workflow, status, limit }`
with `additionalProperties: false`, so `scope` is a new argument on a **published** contract
(`@bffless/workflow-agent-tools`): the catalog, its snapshot test and the generated MCP rules all
move together, and a host that has cached the old tool list simply never passes it — which
lands on the default, "mine". That is the right failure.

The `waiting` step-row query is unchanged: it still reads every waiting step on the instance and
`shape.fn.js` keeps the ones belonging to runs **in the page** — a page that is now already
scoped, so no step key can leak from a run the caller cannot see.

## Attribution: a claim, not a stub row (D28)

A run dispatched from the MCP endpoint is created by the **driver's** identity, not the
requester's. `workflow.start` (as you) → `run/drive` → `repository_dispatch` → GitHub Actions →
`workflow-headless` logs into the harness as *itself* and its browser calls `runs/post`. The
`client_payload` carries `mode`, `run_id`, `harness_url`, `workflow`, `inputs` — **no identity**.
`run/drive` is the last point in that chain where the requester's credential exists, so
attribution has to be captured there or invented later.

Nor can the driver prove it is the driver by scope: the `from-app-token` exchange mints a plain
SuperTokens session carrying `{ role, via, appTokenId }` (`auth.controller.ts`), and the
pipeline's session branch reads the users table and returns `{ id, email, role, credential:
'session' }`. **The app token's scopes do not survive the exchange.** Inside a pipeline the
driver is indistinguishable from that user sitting in a browser; its only identity is its user
id.

### Why the claim is its own row

The natural move — pre-create the `workflow_runs` row at drive time — does not work.
`definition`, `yaml` and `workflowName` are `required: true`, and the server cannot produce
`definition`: YAML is compiled to a definition **in the browser** (`lib/runDefinition.ts`).
Relaxing those three to optional is not a syncable change either — `adoptFields` is strictly
additive, *"new OPTIONAL fields only, nothing removed, retyped or newly required"*
(`proxy-rule-sets.service.ts`) — so it would mean hand surgery on every install's schema.

So the claim lives in a row of its own, which sync creates cleanly:

- **New schema `workflow_run_claims`** — `{ runId, impl, workflow, startedBy, driveKey, createdAt }`.
  A brand-new schema, so no adoption problem.
- **New optional field `driveKey` on `workflow_runs`** — additive and optional, so
  `--adopt-fields` handles it. The key stays on the row once the run finishes, so the
  dispatched driver can still read the record it just sealed and download the run's files;
  a later dispatch re-mints it.

Flow:

1. `run/drive` in `mode: run` writes the claim: `startedBy = user.id`, a fresh random
   `driveKey`, which also goes into `client_payload`.
2. `runs/post` becomes claim-aware:
   - claim found **and** the request carries its `driveKey` → `startedBy` and `driveKey` come
     **from the claim**, the claim is consumed;
   - claim found, key missing or wrong → `409 RUN_EXISTS`, as today;
   - no claim → today's behaviour, `startedBy: user.id` — the browser-started path, unchanged.

The ownership claim is thus written by the requester's **own authenticated request**, and the
driver can never mint a run owned by someone else. `workflow-headless` carries the nonce as the
`x-workflow-drive-key` request header. `api.ts`'s `WORKFLOW_TOKEN` injection is the wrong path
for it — that header rides the driver's own out-of-page fetches (`/api/workflow/*` GETs only),
while `runs/post` is issued by the SPA running *inside* the page; the driver instead injects the
nonce with a Playwright route on `/api/workflow/**` + `/api/uploads/**`, so every in-page request
the harness itself makes carries it too.

A claim is evidence of a **dispatch**, not of a run: it is written before `github_api` runs, so a
dispatch that fails — or one whose driver never picks the event up — leaves a claim standing with
no run behind it. So a claim holds its run id against other members for **ten minutes** — one
constant, `PENDING_WINDOW_MS` (`mcp/ids.ts`), which `driveGate.ts` imports as `CLAIM_STALE_MS`:
the harness must not answer *how long may a dispatch take* twice, because the same span is
already on the wire as `workflow.status`'s `pendingUntil`, and a shorter one here would hand the
id away while the first claimant was still being told to poll for it. Past the window the next
caller of `run/drive` takes the id over, overwriting the abandoned row in place rather than
adding a second claim beside it. (The two clocks differ — the pending window runs from the id's
mint, the claim's age from its row's write, which is later — so the status stops promising the id
just BEFORE it becomes takeable, which is the safe order.) The claimant's *own* standing
claim is reused whatever its age — that reuse is what makes a retry after a failed dispatch safe.

**Since apps#671:** an unconsumed claim *is* surfaced in the list as a `queued` run. It was
deferred out of the boundary here — the window between dispatch and pickup was blind — and
`runs/get` now runs a third pair of scoped queries over `workflow_run_claims` and stands each
claim with no run row of its own up as a synthetic `status: 'queued'` entry. It is a listing
only: `RunStatus` is unchanged, nothing that switches on a run's status is ever handed one, and
the claim's `driveKey` stays off the wire (D28) because the entry is built from an allow-list.

**Since apps#681:** the listing ages out on the harness's one dispatch window. `runs/get`'s
`shape.fn.js` drops a claim older than `CLAIM_STALE_MS` (restated there, pinned to the export by
its parity test), so a claim stops listing as `queued` when `workflow.status` stops answering
`pending` for the run it stands for — past `pendingUntil` a dispatch that never landed is *no
run* on both surfaces, not a run forever about to begin on one of them. The gate's own window
is the same number, but it only *hands the id away* to another member; the claimant's own claim
it reuses whatever its age (above), `createdAt` included, so a retry after the window is
unlisted until the driver's first write — the same short gap `workflow.status` already reports
as no run, since it measures from the id's mint. That gap is accepted rather than re-stamping
the claim, which would extend the foreign-takeover hold instead. The filter runs after the two
claim queries, not in them (a `data_query` filter value is a literal or a request path, never
"now minus a constant"), so a stale claim still holds one of the query's 50 slots. The row
itself is not reaped: it is the only record of who asked for a dispatch that never landed, and
that reuse is what makes the retry safe.

## Files follow the run (D29)

Ownership over run **records** and not run **bytes** would not be worth stating: run ids appear
in URLs, and a path is all anyone needs. 06 says the current behaviour out loud — *"That still
lets a run read `inputs/` uploads and other runs' files, which D14 allows."*

Both byte doors are harness rules, so both can be gated without a CE change:

- `files/sign`, which mints a presigned URL — today `confine.fn.js` checks only that the path is
  under `workflows/` with no traversal;
- `api/uploads/workflows/[...path]`, CE's `file_serve_handler` in the harness's own rule set.

Each parses `workflows/<impl>/<workflow>/runs/<runId>/…` out of the path, resolves the run and
applies the shared gate. Paths under the per-workflow `inputs/` area carry **no** runId and stay
member-wide — D18 makes that area per-workflow and reused across runs, not run-scoped, and
narrowing it would break reuse without closing anything a run prefix does not already close.

**No seek regression.** Media inside a sandboxed island already plays from a `files/sign`
presigned URL, which the storage backend serves directly — Range traffic never reaches the gated
route. The gated route serves the run page's own images and downloads, where one indexed lookup
per request is fine.

## What the person sees

- **Runs list** — defaults to your runs. An owner/admin gets an "All runs" toggle that adds
  `?scope=all`; nobody else sees the toggle, and a hand-written `scope=all` without the role is
  a 403.
- **`startedBy` column** — meaningful for the first time, so it must render a person and not a
  raw uuid. Cheapest is a denormalised `startedByEmail` written at create time (another additive
  optional field), avoiding an N+1 user lookup per list.
- **Someone else's run** — the run page shows its not-found state, the same as an unknown id.

## Testing

- **Fence.** `rules.fence.test.ts` already asserts every rule is `auth_required` with
  `allowApiKey`. It gains a fence asserting every run-scoped rule imports the shared gate, so a
  future ungated rule fails CI instead of quietly leaking.
- **Parity.** The gate gets the treatment `deleteGate.fn.parity.test.ts` and
  `forkGate.fn.parity.test.ts` already apply — the MSW mock and the real function bundle are
  compared, so they cannot drift.
- **A second identity.** MSW gains a second user so "someone else's run" is testable in the SPA.
  A `workflow-live` walk proves it end to end, which **requires a second member on the live
  harness** — a prerequisite the walk cannot create for itself.

## Not in this document

Sharing/grants (the gate is shaped for it; the table is not built) · a cross-workflow "my runs"
page · guest/public runs (already backlog in 06) · per-user partitioning of the `inputs/` area.

Both claim follow-ups have since landed and are specified under §Attribution above, not deferred:
listing an unconsumed claim as a `queued` run (apps#671), ageing one out so it stops holding
its run id (apps#672), and ageing the listing out on that same window (apps#681). Reaping the
aged-out rows is still not done anywhere, and deliberately so (apps#681).
