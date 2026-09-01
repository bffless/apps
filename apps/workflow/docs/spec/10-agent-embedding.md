# 10 — Agent embedding (WebMCP + MCP Apps)

The harness was built for people; this spec makes it usable **by agents on a person's
behalf** — Claude, Copilot, a browser's own agent, any harness that speaks one of two
standards — up to and including the app rendering *inside* the agent's chat surface with
islands intact. It is the M5 milestone (00), and it cashes the cheque ADR-0002 wrote:
islands adopted the MCP Apps contract precisely so "the same island file can later be
served as a `ui://` resource … and render inside Claude / Copilot / Goose."

Two standards, opposite directions:

- **WebMCP** (W3C WebML CG draft) — the *page* exposes tools *up* to an agent running in the
  member's own browser. The page is already open, the session cookie is already there; the
  agent gets exactly what the member could do. Canonical entry point is
  `document.modelContext` (the `navigator.modelContext` form older notes here used is now a
  deprecated alias — feature-detect both).
- **MCP Apps** (`io.modelcontextprotocol/ui`, spec 2026-01-26 — the contract islands already
  speak, per 04/ADR-0002) — a *server* ships tools and `ui://` UI *down* into a chat
  harness. Rendered by claude.ai and Claude Desktop today. The embedded iframe is sandboxed
  with **no cookies** and default-deny CSP; every capability arrives as `tools/call`
  proxied to the MCP server, which must therefore act as the member server-side.

Both consume the same shape — a named tool, a description, a JSON Schema, an MCP-style
result — so the design is **one tool catalog, two adapters** (D19, ADR-0005). Nothing in
this spec re-implements harness behaviour: the WebMCP adapter drives the same store a click
does, and the MCP adapter drives the same `/api/workflow/*` rows the page writes.

## The tool catalog — `@bffless/workflow-agent-tools`

A new package owns the catalog: tool names, descriptions, input schemas, annotations, and
the result builders, so the two adapters cannot drift. Names are dot-canonical and
slash-tolerant, exactly as island tool names are (04). Every result is an MCP
`CallToolResult`: a human-readable `content[0].text` plus machine-readable
`structuredContent`.

| tool | input | answers |
|---|---|---|
| `workflow.list` | `{ impl? }` | implementations and their workflows, with each workflow's `headlessSafe` mark (07) |
| `workflow.describe` | `{ impl, workflow }` | `on.manual.inputs` (types, required, defaults), run outputs, the job/step graph, and per interactive step its `headless:` declaration — what an agent reads before deciding a run can complete without a person |
| `workflow.start` | `{ impl, workflow, inputs }` | starts a run; `{ runId }` + the first snapshot |
| `workflow.status` | `{ runId? }` | the **run snapshot** (below) |
| `workflow.await` | `{ runId?, until: 'waiting' \| 'terminal', timeoutMs? }` | resolves when the run needs input or ends — the polite alternative to busy-polling `status` |
| `workflow.runs` | `{ workflow?, status?, limit? }` | past runs (`GET /api/workflow/runs`) |
| `workflow.submitStep` | `{ runId?, step, values }` | completes a **waiting** interactive step; the step's kind picks the validator — a `form`'s evaluated fields or an `island`'s declared output map, the same checks a person's submit runs (02, 04) |
| `workflow.outputs` | `{ runId? }` | the run's outputs — File refs, never bytes (02) |
| `workflow.sign` | `{ runId?, path }` | `{ url, expiresIn }`, the same presigned GET islands get (04, D6) |
| `workflow.cancel` | `{ runId? }` | cancels the run |
| `workflow.resume` | `{ runId }` | takes over an expired lease (05) — how an agent adopts a run another surface abandoned |

`runId` is optional where a *current run* exists (the WebMCP page has one; the MCP server
does not, so there it is required). Read-only tools carry `annotations.readOnlyHint` so a
consenting browser can grant them more cheaply.

**The run snapshot** is the `window.__workflow` shape (07) extended with `waitingOn`: for
each `waiting` step, its key, kind (`form` | `island`), the declared inputs/outputs, and for
islands the resolved `src`. It tells an agent not just *that* the run is waiting but *what
would satisfy it* — the machine equivalent of the step pane.

**Refusals are spec 07's, verbatim.** `workflow.start` validates through the same function
the kickoff form and `?auto=1` run (`lib/autoStart.ts`), and its error `structuredContent`
carries the same keyed `errors` map the global publishes (`inputs`, `workflow`,
`discovery`, or a per-input key). An agent and a driver and a person are never judged
differently (D12 extended).

Deliberately **not** in v1: `fork`, `retry`, `annotate`, `delete` (rare or destructive; a
person's surfaces exist), and raw pipeline tools (below). Per-workflow *generated* tools
(`studio.publish-blog` as its own tool, synthesized from `index.json`) are a v2 option for
the MCP endpoint — better model ergonomics, but a tool count that moves with every deploy —
recorded in Later.

## WebMCP — the harness page as a tool surface

The page registers the catalog on `document.modelContext` (falling back to the
`navigator.` alias) from one App-level effect: each tool registered once with an
`AbortSignal` tied to effect cleanup. Executors live in `src/agent/` and bind to the store
— reads go through the same selectors the UI renders from (`snapshotOf`, the discovery
state), mutations dispatch the same actions a click does (`startRun`, the form-submit
path, `cancelRun`, take-over). Executors read state **at call time**, so nothing
re-registers as the run progresses and `toolchange` stays quiet.

- **The agent's actions stay visible.** `workflow.start` navigates to the run page the way
  the kickoff form does; the member watches the same screens whether a person or an agent
  is driving. Cooperative use — agent starts, person completes an island, agent reads the
  outputs — is the point of the standard, and it falls out of driving the one store.
- **Auth is the session.** Tools run in the page with the member's cookie; the server-side
  checks every rule already makes (`auth_required`, ownership on delete) apply unchanged.
  Nothing new is granted: the agent can do what the member can do, gated by the browser's
  own consent UI.
- **No pipeline tools on the page** (D21). Registering `/api/<impl>/*` rules as page tools
  would hand an agent the raw backend without run semantics, and would breach the
  own-implementation fence islands are held to (04). An agent completes an island step with
  `workflow.submitStep`; it does not do the island's job. Dynamically registering a
  *waiting* island's own tools is a v2 option — that churn is what `toolchange` exists for.
- **Polyfill always** (D21): when the native API is absent the page installs
  `@mcp-b/webmcp-polyfill`, which is inert without a consumer. The tool surface then exists
  in every Chromium — callable by the `@mcp-b` extension bridge, by a devtools agent via
  `evaluate_script`, and by the driver.
- Islands cannot register page tools themselves — the sandbox is an opaque origin and the
  Permissions-Policy feature (`tools`) is never granted to it. The page is the only WebMCP
  surface.

**Testing without an agent host.** The catalog's contract test is a headless walk: the
driver `page.evaluate`s `getTools()` and drives a full `hello` run —
`executeTool('workflow.start' …)` → `await` → `submitStep` → `outputs` — asserting on
`run.json` as ever (07). Unit tests inject a fake registry. Claude has no WebMCP support
today; a chrome-devtools bridge demo is documented, not automated.

## The MCP endpoint — a rule, not a platform surface

The workflow app's MCP server is **part of the app**: one rule in the harness rule set,
`POST /api/workflow/mcp`, installed and versioned as rules-as-code like every other
endpoint, present wherever the app is installed (catalog installs included). It is **not**
a CE endpoint, not a `/_bffless/*` surface, and not a mode of CE's platform-admin MCP
server (D22) — the platform stays generic; the app ships its own agent surface.

The protocol profile is **stateless Streamable HTTP**, which the MCP spec explicitly
permits: each `POST` carries one JSON-RPC message and is answered with one JSON body; no
SSE, no session id; `GET` answers 405. claude.ai connects to exactly this shape. The
endpoint answers `initialize`, `tools/list`, `tools/call`, `resources/list`,
`resources/read`.

Two implementations, one endpoint:

1. **Prototype — `function_handler`.** The rule's pipeline implements the protocol switch
   by hand. Enough for discovery reads, `resources/read`, and however much of `tools/call`
   a function can reach (a spike settles whether it can call sibling rules; if not, the
   prototype narrows and the handler below absorbs execution).
2. **GA — CE `mcp_handler`.** CE grows a *generic* pipeline handler — a peer of
   `function_handler` / `data_query`, knowing nothing about workflow — that owns the
   protocol plumbing; the rule's config declares the tools (name → rule path, method,
   schema, visibility) and the `ui://` resources (path → served file + `_meta.ui`). The
   workflow rule swaps its guts; the endpoint, and any third-party client configured
   against it, never moves. Any BFFless app can then ship an MCP surface the same way.

**Tools it serves**: the catalog, executed against the sibling `/api/workflow/*` rules as
the authenticated member (auth below) — plus, per island being served, the implementation's
own pipeline tools and the `workflow.submit` / `workflow.annotate` / `workflow.sign` host
tools, published with `visibility: ["app"]` so the embedded UI can call them but the model
never sees them in `tools/list`. The fence holds: an island's tools are its own
implementation's rules plus `workflow.*`, exactly as on the page (04).

**Resources it serves**: `ui://bffless/<impl>/islands/<name>.html`, fetched from
`/w/<impl>/islands/<name>.html` — the very namespace the page host already resolves (04) —
and `ui://bffless/workflow/run.html`, the run view below. Each carries
`_meta.ui` with a generated CSP: `connectDomains` lists the app domain and the storage
origin only (presigned PUT/GET need direct network; everything else rides the bridge), and
they are derived from the instance, never hardcoded (the catalog app is instance-agnostic,
06).

## Islands and the run view inside an agent host

An island file renders in claude.ai unchanged: the host fetches it as a `ui://` resource,
mounts it in the sandboxed iframe, sends `tool-input`, and proxies its `tools/call` to the
endpoint — which answers `workflow.submit` by writing the same step rows the page host
writes. The sandbox contract islands were held to from day one (opaque origin, no cookies,
everything through the bridge — 04) is exactly the agent-host contract, which is why this
works without touching a single island.

But a run is more than one island: on the harness page **the browser drives** — the store
middleware executes pipeline steps, holds the lease, writes transitions (D8, D11). Inside
an agent host there is no harness page, so the run view restores one (D24):

- `ui://bffless/workflow/run.html` is a second Vite entry — a self-contained build of the
  run page: the pure runner (`lib/runner/`), the store and its middleware, the island host,
  the run panes; no router, no shell.
- Its every HTTP call goes through **one** app-only tool, `workflow.http { path, method,
  body }` — the `HttpJson` seam the middleware already injects, implemented over
  `callServerTool`. The endpoint executes it server-side as the member, fenced to the
  project's `/api/*` paths the page itself may call. `visibility: ["app"]`: the model
  cannot call it, only the view.
- `workflow.start` and `workflow.resume` link the view via `_meta.ui.resourceUri`, so
  starting a run in Claude mounts it in the conversation; islands mount inside it as
  nested srcdoc iframes under the same `IslandHost`, none the wiser.
- The invariant survives: the sandboxed iframe **is** a browser, it takes the same 60 s
  lease and writes the same rows, so a run started in Claude and abandoned there is in the
  same state as a closed tab — open it on the harness page and Resume, or `workflow.resume`
  it back into a conversation (05). One engine, one history, no divergence for 07's rules
  to re-litigate.

A run already waiting on a single island step has a lighter path that needs no engine: the
endpoint serves *that island* as `workflow.submitStep`'s UI resource and answers its bridge
directly. That is the Phase-2 demonstrator, and it stays valid at GA.

## Auth

The landmine, pre-recorded in 07: a CE API key is pinned to role `user`, is not bound to a
member, and cannot mint a session — it is not a credential the MCP endpoint can act on a
member's behalf with. The ladder (D23):

1. **Authless prototype** — dev instance only, scratch data, `startedBy` a fixed service
   identity; never on a production domain. claude.ai connects to authless servers, which is
   what makes the Phase-2 demo cheap.
2. **App tokens (CE)** — first-class scoped, user-bound bearer tokens: `{ user, project,
   scopes, expiry }`, minted and revoked by the member. `auth_required` accepts
   `Authorization: Bearer <app-token>` wherever it accepts a session and resolves it to the
   member, so `user.id` flows into pipelines unchanged (`startedBy`, the delete gate). This
   fixes the landmine generally — the driver gets a real credential too, independent of MCP.
3. **OAuth 2.1 (CE)** — dynamic client registration, PKCE, RFC 9728 protected-resource
   metadata, RFC 8707 resource indicators; the access token *is* an app token. The app
   ships its `/.well-known/oauth-protected-resource` document **as a rule** pointing at
   CE's authorization endpoints — the discovery surface stays app-installed, no `/_bffless`
   pattern. claude.ai's one-click connector flow (DCR → consent → tokens) is the acceptance
   test. Scopes v1: `workflow:read`, `workflow:run`, `workflow:files`.

The iframe itself never holds a durable credential: the view acts through `tools/call`
(the host attaches the server session), and the only bearer it ever sees is the same
short-lived signed URL an island gets today (D6). WebMCP needs none of this ladder — the
session cookie is already on the page.

## Decisions

| # | Decision |
|---|---|
| D19 | One tool catalog (`@bffless/workflow-agent-tools`), two adapters — WebMCP binds it to the store, the MCP endpoint binds it to `/api/workflow/*`; results are MCP `CallToolResult`s in both (ADR-0005) |
| D20 | Generic `workflow.*` tools + `describe` in v1; per-workflow generated tools are a later MCP-endpoint option |
| D21 | WebMCP on the page only: polyfill always, executors drive the store and navigate, no pipeline tools on the page, islands never register page tools |
| D22 | The MCP endpoint is a rule in the app's rule set (`POST /api/workflow/mcp`), stateless Streamable HTTP; prototype `function_handler`, GA a generic CE `mcp_handler`; never an app-aware CE endpoint, never `/_bffless/*` |
| D23 | Auth ladder: authless dev prototype → CE user-bound scoped app tokens (Bearer = member) → OAuth 2.1 where the access token is an app token; `.well-known` ships as a rule |
| D24 | In agent hosts the run view drives: the pure runner + island host bundled as `ui://bffless/workflow/run.html` over an app-only `workflow.http` seam; same lease, same rows; a server-side driver stays deferred |

## Later

- Per-workflow generated tools on the MCP endpoint (synthesized from `index.json` at
  `tools/list` time), for hosts where ten generic tools read worse than one named verb.
- Dynamically registering a waiting island's own tools on the WebMCP page while the step
  waits — the `toolchange` use case.
- A server-side run driver (would unlock `on.schedule` / `on.webhook`; contradicts D11
  until it earns its own ADR).
- The web-host double-iframe sandbox proxy + per-island CSP, still gated on third-party
  islands (04).
- `ui/update-model-context` — the host capability accepted-and-ignored since v1 (04) —
  wired through so an island can push context to the *embedding* model in an agent host,
  and to a WebMCP consumer on the page.
- Claude-adjacent bridges as they mature: WebMCP origin trials are Chrome/Edge-only today,
  and Claude Code's terminal does not render MCP Apps — both worth revisiting as hosts
  move.
