# Workflow agent embedding (M5) — design

**Goal (the user's framing):** the long-term dream of the workflow app is to be embeddable
inside Claude using WebMCP and MCP Apps — a user asks Claude (or any harness with these
capabilities) and it interacts with the workflow on their behalf, leveraging the islands as
web-app MCP UI. This document is the design behind
`apps/workflow/docs/spec/10-agent-embedding.md` (the durable contract) and the
`EPIC: Agent embedding` tracking issue (the sequencing). Decisions D19–D24 in the spec;
ADR-0005 is the anchor.

Ratified with the user 2026-08-31 → 2026-09-01: WebMCP first; the MCP endpoint lives in the
app's rule set, **never** baked into CE (no `/_bffless/*`, no coupling with CE's
platform-admin MCP server — CE contributes only generic primitives); CE track = app tokens
+ generic `mcp_handler` + OAuth 2.1; the run view drives runs inside agent hosts.

---

## 1. External ground truth (researched 2026-08-31)

### WebMCP — W3C Web Machine Learning CG draft

Spec: <https://webmachinelearning.github.io/webmcp/> (draft CG report, 2026-08-26; not a
W3C standard). Explainer: <https://github.com/webmachinelearning/webmcp>. The page
registers typed JS tools an in-browser agent discovers and calls — the counter to "UI
disintermediation," designed for cooperative human+agent use of the same session.

- **Entry point moved**: `document.modelContext` is canonical since May 2026
  (webmcp#184); `navigator.modelContext` is a deprecated alias (Chrome 150 warns).
  Feature-detect both.
- API: `registerTool({ name, description, inputSchema, execute, annotations })` with an
  `AbortSignal` option for unregistration (a natural React-effect cleanup); `getTools()`,
  `executeTool()`, one `toolchange` event. `execute` returns MCP-style
  `{ content: [{type:'text', …}] }` — deliberately aligned with MCP's `CallToolResult`.
  `annotations` today: `readOnlyHint`, `untrustedContentHint`.
- Trust model: SecureContext; same-origin by default (cross-origin exposure is explicit
  opt-in); iframes need Permissions-Policy `allow="tools"` (default allowlist `self`) —
  islands never get it. Human-in-the-loop is explicit: full automation without oversight is
  a stated non-goal; consent UX is implementation-defined.
- Auth: tools run in the page with the user's cookies/session — the agent gets exactly the
  signed-in member's capabilities, gated by browser consent. No new server surface.
- Status (implementation-status.md): Chrome 149 origin trial (early preview from ~146),
  Edge 150 OT, Brave experimenting, ChatGPT Desktop listed as supporting. **Claude: no
  official support** — anthropics/claude-code#30645 closed not-planned. Practical bridges:
  a chrome-devtools-mcp agent can call `document.modelContext.getTools()/executeTool()` via
  `evaluate_script`; the `@mcp-b/*` family (<https://github.com/WebMCP-org/npm-packages>)
  ships `@mcp-b/webmcp-polyfill` (strict polyfill), `@mcp-b/react-webmcp` (hooks),
  transports, and a Chromium extension template that surfaces page tools to any MCP client.
- Flux warnings: `provideContext` (bulk registration, overwrites — webmcp#101), the
  declarative API, and the Service-Worker extension are unsettled; don't hard-code Chrome
  149 OT behaviour.

### MCP Apps — `io.modelcontextprotocol/ui` extension

Spec 2026-01-26, **Final**, in <https://github.com/modelcontextprotocol/ext-apps>
(`specification/2026-01-26/apps.mdx`); SEP-1865 (joint Anthropic + OpenAI + MCP-UI,
announced 2025-11-21). SDK: `@modelcontextprotocol/ext-apps` (v1.1.2 docs at
<https://apps.extensions.modelcontextprotocol.io/api/>; the harness already depends on
^1.7.5 as the island host — ADR-0002).

- Server exposes `ui://` resources, MIME `text/html;profile=mcp-app`, via normal
  `resources/read`; a tool links UI with `_meta.ui.resourceUri`; `visibility:
  ["model"]|["app"]` — app-only tools are callable by the embedded UI and **excluded from
  the model's `tools/list`** (the mechanism behind `workflow.http`).
- Sandbox: iframe `allow-scripts allow-same-origin` on a host-controlled origin; CSP built
  from `_meta.ui.csp` (`connectDomains`, `resourceDomains`, …); the default is fully locked
  down (inline everything, no network). Web hosts use a double-iframe sandbox proxy.
  **No host cookies/localStorage**; iframe storage is not stable across sessions — never an
  auth store.
- Bridge: the view is an MCP client over postMessage — `ui/initialize` handshake
  (hostContext: theme, CSS variables, displayMode, containerDimensions, locale…), then
  `tools/call`, `resources/read`, `ui/update-model-context`, `ui/message`,
  `ui/request-display-mode`, `ui/notifications/size-changed`; host pushes `tool-input`,
  `tool-result`, `host-context-changed`, `ui/resource-teardown`. This is exactly the
  surface `IslandHost.ts` already implements as a host.
- Hosts (mid-2026): **claude.ai + Claude Desktop since 2026-01-26**, VS Code Copilot, M365
  Copilot, Goose, Postman, MCPJam; ChatGPT renders standard MCP Apps too (its legacy
  `window.openai` dialect is abstracted by Skybridge). Claude Code's terminal does **not**
  render MCP Apps. `apps.extensions.modelcontextprotocol.io` is a docs hub, not an app
  store — distribution is per-host (Claude's connector directory).
- Server auth: core MCP authorization — OAuth 2.1 + PKCE, RFC 9728 protected-resource
  metadata, RFC 8707 resource indicators, dynamic client registration; claude.ai supports
  authless and OAuth remote servers incl. DCR. The iframe does **not** share that auth;
  guidance is to keep tokens server-side and let the UI act through `tools/call`.
- Transport: **stateless** Streamable HTTP is explicitly permitted — single POST, single
  JSON body, no SSE, no session id, `GET` → 405. That is what makes a proxy-rule
  implementation feasible.

### The relationship

Same JSON-Schema tool shape, opposite directions: WebMCP = the agent comes to the page
(session free, no server); MCP Apps = the UI goes to the agent (server mandatory, auth
rebuilt). One tool catalog serves both. For reaching Claude users specifically, MCP Apps is
the only supported path today; WebMCP is the long-term "agent drives my real app" fit.

---

## 2. Internal ground truth

Not greenfield — the repo pre-recorded this feature:

- ADR-0002's **Why** is the embedding dream verbatim; "WebMCP … is a separate, later layer
  on the harness page" sits in its Consequences. Spec 04 §Later listed all three
  deliverables; 00-overview M4 follow-ups listed "WebMCP on the harness page".
- Machine contracts ready to be adapted, not invented:
  - `window.__workflow` (`src/lib/workflowGlobal.ts`) — one writer, one type; ≈
    `workflow.status` minus `waitingOn`.
  - `?auto=1&inputs=` (`src/lib/autoStart.ts`) — validated by the same function as the
    kickoff form; spec 07's refusal table is exhaustive; ≈ `workflow.start`.
  - The pure runner (`src/lib/runner/`, eslint-fenced framework-free) + the single
    side-effect listener (`src/store/runnerMiddleware.ts`) with injected `HttpJson` /
    `fetchText` seams — what makes the run view a bundling job, not a rewrite.
  - `IslandHost.ts` — already an MCP Apps host: one `AppBridge` per island,
    `workflow.submit`/`annotate`/`sign`, pipelines-as-tools naming (dot-canonical,
    slash-tolerant, own-implementation fence), `hostContext.bffless.*` extension channel,
    `updateModelContext` accepted-and-ignored (the pre-wired context hook), `HOST_INFO`
    version constant for feature detection.
- The auth landmine, pre-recorded (`packages/workflow-headless/src/login.ts:1-15`, spec 07):
  an X-API-Key can call `/api/workflow/*` but **cannot mint a SuperTokens session** and is
  pinned to role `user`, not bound to a member — why the driver logs in through the admin
  relay like a person, and why the MCP endpoint needs a new credential type.
- Single-origin invariant (ADR-0001): the browser only talks to `workflow.<domain>`. An
  agent host's iframe is a third origin with no cookie — by design it never fetches the app
  directly; everything rides the bridge.

## 3. Architecture — one catalog, two adapters

### Layer 0 — `packages/workflow-agent-tools`

Pure TS, published, joins the release train. Owns: the 10-tool catalog (`workflow.list`,
`describe`, `start`, `status`, `await`, `runs`, `submitStep`, `outputs`, `sign`, `cancel` /
`resume` — semantics in spec 10), JSON Schemas, MCP `CallToolResult` builders, and
`RunSnapshot` (= `window.__workflow` + `waitingOn`: per waiting step its kind, declared
inputs/outputs, island `src`). Not in v1: fork/retry/annotate/delete; per-workflow
generated tools (v2 option on the endpoint, synthesized from `index.json`).

### Layer 1 — WebMCP adapter (`apps/workflow/src/agent/`)

`registry.ts` (feature-detect `document.modelContext ?? navigator.modelContext`, injectable
for tests), `executors.ts` (bind catalog → store: reads via `snapshotOf` + waitingOn +
discovery state; mutations dispatch `startRun` / form-submit path / `cancelRun` /
take-over; `workflow.start` navigates so the member watches what the agent does),
`useWebMcp.ts` (one App-level effect, AbortSignal cleanup, zero `toolchange` churn —
executors read state at call time). Polyfill-always via `@mcp-b/webmcp-polyfill` when the
native API is absent. Contract test = a headless walk driving a full `hello` run through
`page.evaluate(executeTool(...))`.

### Layer 2 — the MCP endpoint (a rule in the harness rule set)

`POST /api/workflow/mcp`, stateless Streamable HTTP, answering `initialize`, `tools/list`,
`tools/call`, `resources/list`, `resources/read`.

- **Prototype**: `function_handler` implements the protocol switch. A spike settles whether
  a function can execute sibling rules for `tools/call`; if not, the prototype narrows to
  discovery reads + `resources/read` and execution lands with the CE handler.
- **GA**: CE grows a generic **`mcp_handler`** pipeline handler (peer of `function_handler`
  / `data_query`, app-agnostic): protocol plumbing in the handler, tools (name → rule
  path/method/schema/visibility) and `ui://` resources (path → file + `_meta.ui`) declared
  in the rule config. The workflow rule swaps its guts; the endpoint never moves; any
  BFFless app can ship an MCP surface the same way. **Explicitly not**: an app-aware CE
  endpoint, a `/_bffless/*` surface, or a merge with CE's platform-admin MCP server.
- Resources: `ui://bffless/<impl>/islands/<name>.html` ← `/w/<impl>/islands/<name>.html`
  (islands run unchanged — the 04 sandbox contract *is* the agent-host contract), and
  `ui://bffless/workflow/run.html` (below). `_meta.ui.csp.connectDomains` = app domain +
  storage origin, derived per instance (catalog app stays instance-agnostic).
- Island bridge calls (`workflow.submit`/`annotate`/`sign`, impl pipeline tools) are served
  as `visibility: ["app"]` tools; the own-implementation fence holds server-side exactly as
  in `island.ts` on the page.

### Layer 2b — the run view

Second Vite entry bundling run page + store + middleware + `IslandHost`; no router, no
shell, no network of its own. `HttpJson` is implemented over
`app.callServerTool('workflow.http', { path, method, body })` — one app-only tool,
path-fenced to the project's `/api/*`, executed server-side as the member.
`workflow.start`/`resume` link it via `_meta.ui.resourceUri`. The browser-drives-runs
invariant (D11) survives — the iframe is a browser, takes the same 60 s lease, writes the
same rows; a run abandoned in Claude resumes from the harness page and vice versa.
Rejected alternatives: server-side driver (second engine runtime, `node:vm` for scripts —
deferred until `on.schedule` earns its ADR); model-drives-via-tools (progresses only while
a conversation polls — kept only as the degenerate case that already works through the
catalog). Lightweight path that needs no engine: a run waiting on a single island step can
serve *that island* as `workflow.submitStep`'s UI — the Phase-2 demonstrator.

### Auth ladder

1. **Authless prototype** — dev instance only (scratch project), fixed service identity,
   never a production domain.
2. **App tokens (CE)** — first-class scoped user-bound bearers `{ user, project, scopes,
   expiry }`; `auth_required` resolves `Authorization: Bearer` to the member wherever it
   accepts a session (`user.id` flows into pipelines: `startedBy`, delete gate); mint/revoke
   API + admin UI. Fixes the landmine generally — the headless driver gets a real
   credential independent of MCP.
3. **OAuth 2.1 (CE)** — DCR + PKCE + RFC 9728/8707; the access token *is* an app token;
   SuperTokens OAuth2-provider recipe vs built-in decided by an in-story spike. The app
   ships `/.well-known/oauth-protected-resource` **as a rule** pointing at CE's
   authorization endpoints. Acceptance test: claude.ai's one-click connector flow. Scopes
   v1: `workflow:read`, `workflow:run`, `workflow:files`.

The iframe never holds a durable credential (tools/call carries the server session; signed
URLs stay the only bearer a sandbox sees, D6). WebMCP needs none of this — the session
cookie is already on the page.

## 4. Sequencing — phases, stories, gates

Epic mechanics per house convention: tracking issue labelled `epic` (never
`ready-for-agent`); when implementation starts, a draft PR into `main` labelled `epic`
(`EPIC: Agent embedding — WebMCP page tools + MCP Apps (workflow M5)`), stories branching
off and merging into it. CE stories land in `repos/ce` first (cross-repo policy); CE issues
are filed when Phase 3 starts.

| # | story (one PR-sized agent session) | repo |
|---|---|---|
| **Phase 0 — Spec** · *gate: decisions ratified on the spec PR* |||
| 1 | Spec 10 + ADR-0005 + 00/04 updates + this design doc | apps |
| **Phase 1 — WebMCP** · *gate: live walk drives `hello` end-to-end via page tools on j5s* |||
| 2 | `packages/workflow-agent-tools`: catalog, schemas, result builders, `RunSnapshot`, release-train plumbing, unit tests | apps |
| 3 | WebMCP read-only: `src/agent/{registry,executors,useWebMcp}.ts`, native-or-polyfill, `list/describe/status/runs/outputs`, fake-registry tests | apps |
| 4 | WebMCP mutations + live proof: `start/await/submitStep/sign/cancel/resume`, navigation coupling; `workflow-headless` + `workflow-live` page-tools walk | apps |
| **Phase 2 — MCP Apps prototype (authless, dev instance only)** · *gate: an island renders and round-trips `workflow.submit` inside claude.ai* |||
| 5 | Spike: stateless MCP over a `function_handler` rule (`POST /api/workflow/mcp`) — initialize / tools-list / tools-call for reads; findings comment on the epic (can a function execute sibling rules? if not, narrow and fold execution into story 8) | apps |
| 6 | Islands as `ui://` in Claude: `resources/read` of island HTML, one demo tool with `_meta.ui.resourceUri` + generated CSP, server-side `workflow.submit`/`sign`; manual claude.ai verification, screenshots on the PR — **ADR-0002's "why", proven** | apps |
| **Phase 3 — CE: auth + generic handler** · *gate: claude.ai completes DCR+PKCE against the app and calls `workflow.status` as the member* |||
| 7 | (CE) App tokens: scoped user-bound bearers, `auth_required` resolution, mint/revoke + admin UI; apps follow-up: driver may use an app token instead of relay login | ce |
| 8 | (CE) Generic `mcp_handler` pipeline handler; workflow's `/api/workflow/mcp` rule swaps from function_handler guts to it | ce |
| 9 | (CE) OAuth 2.1: DCR, PKCE, RFC 9728/8707, access token = app token; SuperTokens-provider-vs-built-in spike inside the story; app ships its `.well-known` rule | ce |
| **Phase 4 — the run view** · *gate: a full `hello` run started, driven and island-completed entirely inside claude.ai; workflow-live walk green* |||
| 10 | Run-view bundle: second Vite entry, store + middleware + `IslandHost` over `HttpJson`-on-`callServerTool('workflow.http')` | apps |
| 11 | Server wiring: `start`/`resume` link the run view; app-only path-fenced `workflow.http`; connectDomains for storage; lease/take-over from the view | apps |
| 12 | M5 closeout: Claude-path live verification (headless where possible, scripted-manual checklist where not); docs (`writing-an-implementation.md` — what implementations get for free in Claude; 00-overview M5 done-block); file deferred-item issues | apps |

Deferred, explicitly: per-workflow generated tools; dynamic island tools on the page
(`toolchange`); server-side driver / `on.schedule`; double-iframe CSP; wiring
`ui/update-model-context` through to the embedding model.

## 5. Key sources

WebMCP spec <https://webmachinelearning.github.io/webmcp/> · explainer/repo
<https://github.com/webmachinelearning/webmcp> · implementation status
<https://github.com/webmachinelearning/webmcp/blob/main/implementation-status.md> ·
@mcp-b packages <https://github.com/WebMCP-org/npm-packages> · MCP Apps spec
<https://github.com/modelcontextprotocol/ext-apps> · SEP-1865
<https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp> ·
overview <https://modelcontextprotocol.io/extensions/apps/overview> · SDK
<https://apps.extensions.modelcontextprotocol.io/api/> · MCP authorization
<https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization> · Claude
remote-connector auth <https://claude.com/docs/connectors/building/authentication>
