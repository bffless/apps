# Workflow

Workflow is a browser-driven workflow runner for BFFless, inspired by GitHub Actions: a generic
**harness** app renders and runs **workflows** declared in YAML by separate **implementation**
repos, dispatching the implementation's BFFless pipelines and pausing on custom UI where a
person is needed. This glossary is the vocabulary; the design is in `docs/spec/`.

## Language

### The parties

**Harness**:
The Workflow app itself, installed once per project. It owns the UI, the runner, run history,
run storage and the headless driver, and carries no workflow of its own.
_Avoid_: runner app, shell, host app, engine (for the app)

**Implementation**:
A separate repo deployed to its own alias inside the harness's project, shipping workflow
definitions, the pipelines they call, and any islands or scripts.
_Avoid_: workflow repo, plugin, extension, provider

**Project member**:
A BFFless user with any role on the project; the only kind of person who can start or view
runs.

### Definitions

**Workflow**:
One YAML file under an implementation's `.bffless/workflows/`: a name, a kickoff form and a
set of jobs. The unit a person picks to run.
_Avoid_: process, pipeline (that word is taken), app (when meaning the definition)

**Job**:
A unit of a workflow that starts once its `needs` are satisfied; jobs with no `needs` run
concurrently. A job may fan out over a matrix.
_Avoid_: stage, phase, group

**Matrix item**:
One instance of a fanned-out job, e.g. "per-video for take-2.mov". A matrix job's outputs
collect into lists, one element per item.
_Avoid_: iteration, shard, branch

**Step**:
One action inside a job; steps run in order. A step `uses` exactly one step kind.
_Avoid_: task, action, node (UI-only word)

**Step kind**:
What a step does: `pipeline` (call a BFFless rule), `island` (custom UI), `form` (built-in
schema form) or `script` (browser Worker). The closed set.
_Avoid_: step type, handler

**Kickoff form**:
The input form shown to start a run, generated from `on.manual.inputs`.
_Avoid_: start form, dispatch form, run settings, parameters

**Expression**:
A `${{ … }}` reference or computation evaluated by the harness against the run's contexts
(`inputs`, `needs`, `steps`, `matrix`, `response`, …).

### Values

**Payload**:
A typed value flowing between steps; its type is one of the closed vocabulary (`string`,
`number`, `boolean`, `choice`, `file`, `table`, `markdown`, `json`), optionally a list.
_Avoid_: artifact, data, result, blob

**File ref**:
The payload shape of a `file`: `{ path, name, contentType, size, url }`. Bytes never travel in
payloads; only refs do.
_Avoid_: file object, upload, attachment

**Renderer**:
The viewer or editor the harness picks for a payload from its type, overridable per
definition with `render` (e.g. `transcript`, `images`, `island`).
_Avoid_: widget, component, viewer (as the concept name)

**Run storage**:
The harness-owned storage area for a workflow: a per-workflow `inputs/` area for uploads
(reused across runs) and a per-run prefix for everything a run produces; pipelines read and
write paths, never choose prefixes.
_Avoid_: bucket, uploads folder

### Running

**Run**:
One execution of a workflow, started from the kickoff form in a browser and recorded
server-side step by step.
_Avoid_: execution, job (taken), session

**Run record**:
The server-side rows of a run (`workflow_runs` + one row per job/item/step) — the truth that
history, the run page and Resume are rebuilt from.
_Avoid_: log, history entry, event log (as the user-facing name)

**Resume**:
Continuing a run whose driving tab closed: finished steps are replayed from their rows,
in-flight pipeline steps re-poll, interactive steps re-prompt.
_Avoid_: restart, retry (taken), recover

**Lease**:
The claim the driving tab holds on a running run (heartbeat-renewed) so two tabs can't both
drive it; an expired lease is what makes Resume or Take-over offered.

**Summary**:
Markdown a step contributes to the run page, declared as a template on the step.
_Avoid_: attestation, report, note, annotation (different thing)

**Annotation**:
A levelled (notice / warning / error) message a step or the run pins to the run page.
_Avoid_: warning (as the concept), log line, summary

**Headless run**:
A run driven by a headless browser (Playwright) rather than a person; the same harness page,
auto-started by URL, with interactive steps skipped, auto-submitted, or failing fast.
_Avoid_: server-side run, CI run (as the concept), background run

**Driver**:
`@bffless/workflow-headless`, the Playwright CLI that *performs* a headless run: it opens the
start URL, follows `window.__workflow` and writes the run's artifacts down. It re-implements no
harness behaviour, and its exit code is what CI branches on.
_Avoid_: runner (the harness runs the workflow), agent, bot, worker

**Island**:
A custom micro-UI shipped by an implementation as a self-contained HTML resource in the MCP
Apps format, rendered by the harness in a sandboxed iframe as a step or as an output viewer.
_Avoid_: widget, component, micro-app, plugin UI, iframe (as the concept)

**Script**:
An implementation's ES module the harness runs in a Worker as a step; the browser-CPU step
kind.
_Avoid_: task, function, worker (as the concept)

**Sandbox**:
The `sandbox="allow-scripts"` iframe with no `allow-same-origin` that implementation code runs
inside — an island's UI directly, and a script's Worker spawned from `data:` URLs within a
hidden one. Its origin is **opaque**: no cookies, no storage, no same-origin fetch, so every
capability arrives from the harness (the MCP Apps bridge, or the Worker's port).
_Avoid_: iframe (as the concept), jail, container, isolate

**Signed URL**:
A short-lived presigned GET for one object under the harness's `workflows/` prefix, minted by
`POST /api/workflow/files/sign` and handed to a sandbox through `workflow.sign`. It is the only
bearer credential the harness ever gives out, and the only way opaque-origin media loads.
_Avoid_: share link, token URL, public URL, presign (as a noun)

### Publishing

**Publish**:
Deploying an implementation to its alias with `.bffless/workflows/` + `index.json` in the
bundle and its rule set attached to both its alias and the harness alias. A deploy *is* the
publish; there is no registration.
_Avoid_: register, install (that's the harness), sync (the rules half only)

**Discovery**:
How the harness finds implementations: listing the project's aliases and probing each for
`/.bffless/workflows/index.json`.

### Agent embedding

**Tool catalog**:
`@bffless/workflow-agent-tools` — the eleven `workflow.*` tools (names, schemas, annotations,
the tool→scope map, result builders, the run snapshot) both embedding adapters consume.
_Avoid_: plugin, SDK, "the MCP server" (that is one adapter of it)

**Page tools**:
The catalog registered on the harness page's `document.modelContext` (WebMCP; polyfilled
when the browser has none), executed against the store — an agent in the member's own
browser does what a click does, with the member's session.
_Avoid_: page MCP server, browser plugin, pipeline tools (an implementation's pipelines are
never page tools)

**Run snapshot**:
`window.__workflow`'s shape plus `waitingOn` — for each waiting step what would satisfy it.
What `workflow.status` answers.
_Avoid_: run state (the engine's), run record (the rows)

**MCP endpoint**:
`POST /api/workflow/mcp` — the harness's MCP server as one rule in its own rule set (spec 10,
D22): from Phase 3 story 8 a single CE `mcp_handler` step whose config (the catalog's tools,
the app-only four, the `ui://` resources) is rendered from `src/mcp/mcpConfig.ts`; every tool
is its own sibling rule under `mcp-tools/`, invoked in-process as the caller with its own
`requiredScopes`. The sibling rules' function steps are the shared bundles under `mcp-fn/`
(`pnpm --filter workflow mcp:build` builds and renders everything).
_Avoid_: a CE endpoint, `/_bffless/*`, the platform-admin MCP server, "streaming" (one POST,
one JSON body), "the 24-step pipeline" (the Phase-2 prototype, retired)
one JSON body)

**App token**:
A CE-minted, member-bound, project-bound, scoped bearer (`Authorization: Bearer bfat_…`) — auth
ladder rung 2 (D23). Over the MCP endpoint it *is* the member: `startedBy`, the delete gate and
every sibling rule see the person, narrowed to the token's scopes (`workflow:read` /
`workflow:run` / `workflow:files`, the catalog's map). A session is never scope-checked.
_Avoid_: "service identity" (the retired Phase-2 `WORKFLOW_MCP_KEY` secret), "API key" (pinned
to role `user`, bound to no person)

**Protected-resource document**:
The harness's `/.well-known/oauth-protected-resource` rule (RFC 9728), served despite
deployment visibility: this host's MCP endpoint as the resource, CE's authorization server on
`admin.<domain>`, the catalog's scopes. How a chat host finds the login from the app.
_Avoid_: "OAuth discovery endpoint" (CE has none for apps), the Phase-2 404 rule (retired)

**Consent**:
The admin-side page (`/oauth/consent`) where a member grants a client a subset of the scopes it
asked for, per project; a `workflow:read`-only consent yields a token that watches but never runs.
_Avoid_: "login" (the member is already signed in), "permission" (the member's project role)

**Step view**:
`ui://bffless/workflow/step-view.<rev>.html` — the engine-less host page that mounts one waiting
island **or renders one waiting form** inside an agent host, under the same `IslandHost` the
harness page uses; what `workflow.submitStep` renders in claude.ai. `<rev>` is `sourceRev()`
(`scripts/build-mcp.mjs`), an 8-hex-char hash of `src/**` plus the step view build's own
`step/index.html` and `vite.step.config.ts`, rendered into the URI at `mcp:build` time — every
deploy that changes the view is a cache miss for a host that caches a widget's resource per URI
(apps#587).
_Avoid_: the run view (withdrawn 2026-09-04), the island itself (served unchanged as
`ui://bffless/<impl>/islands/<name>.html`)
