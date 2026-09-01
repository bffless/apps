# 04 — Islands (MCP Apps contract)

An **island** is a custom micro-UI an implementation ships for a step (input) or for an
output viewer (`render: island`). Rather than inventing an embedding protocol, islands **are
MCP Apps** (MCP extension `io.modelcontextprotocol/ui`, spec 2026-01-26) and the harness is an
MCP Apps **host**. Rationale in ADR-0002: the same HTML file can later be served as a `ui://`
resource by a BFFless MCP server and render inside Claude, Copilot, Goose, … with the
implementation's pipelines as its tools; authors write against the public
`@modelcontextprotocol/ext-apps` `App` class, not a BFFless SDK.

## The mapping

| Workflow | MCP Apps |
|---|---|
| the harness | the **host** — we embed `@modelcontextprotocol/ext-apps` **AppBridge** |
| an island file (`islands/x.html` → `/w/<alias>/islands/x.html`) | a UI resource, `text/html;profile=mcp-app`, fetched same-origin by the harness |
| the step starting | `ui/notifications/tool-input` with `arguments = with` (minus `src/title/display`) |
| island calls a pipeline | `tools/call { name, arguments }` → host proxies to `/api/<alias>/<name>` (see tool naming) |
| island finishes the step | `tools/call { name: "workflow.submit", arguments: { outputs } }` — our one host tool for completion |
| island writes a summary / annotation | `tools/call { name: "workflow.annotate", arguments: { summary?, annotations? } }` |
| island needs media (an image/video/audio the run produced) | `tools/call { name: "workflow.sign", arguments: { path } }` → `{ url, expiresIn }` — a presigned GET for an object under `workflows/`, because the frame is opaque-origin and carries no cookie |
| theme, dark mode, size | the **`ui/initialize` result**'s `hostContext` (`theme`, `displayMode`, `availableDisplayModes`, `platform`, `containerDimensions`) carries the opening values; `ui/notifications/host-context-changed` carries every later one — the host re-sends `theme` on an OS theme flip and `containerDimensions` on a frame resize — and `ui/notifications/size-changed` comes the other way |
| headless run | `hostContext.platform = "web"`; `hostContext.bffless.headless = true`, delivered in the same `ui/initialize` result, readable as `app.getHostContext().bffless` (07) |
| step cancelled / run leaves the page | `ui/resource-teardown { reason }` |
| output viewer (`render: island`) | same file; `tool-input.arguments = { value }`; `workflow.submit` and `workflow.annotate` are rejected (`workflow.sign` is not — see below). A changed value is a **fresh `tool-input`** over the same bridge, never a remount — a viewer must handle `ontoolinput` more than once. A step's island is sent `tool-input` exactly once |

Host capabilities declared on `ui/initialize`: `tools/call`, `ui/message` (no-op: logs to the
step card), `ui/open-link` (opens a new tab, same as GitHub), `ui/request-display-mode`
(`inline` ↔ `fullscreen` only). `resources/read` is served for `ui://bffless/<impl>/...`
→ `/w/<impl>/...` (lets an island load sibling assets through the bridge when CSP forbids
direct fetch). `ui/update-model-context` is accepted and ignored in v1.

## Display modes

`with.display` is `inline` (the default) or `fullscreen`, and it is a **size, not a
capability** (apps#432): every action an island offers works in either mode, so the harness
never opens an island enlarged.

- **Every island mounts inline** — in the step pane under the graph, the same "one level under
  the graph" pane every step uses. `display: fullscreen` is the island's *preferred enlarged
  mode*: the pane offers an **Expand** control, and the person decides.
- **Fullscreen is an overlay, not a route.** Expand fixes the same pane over the viewport with a
  strip (Run › job, the step key, **Exit fullscreen**) in place of the graph; Esc or Exit
  returns to the pane. The `<iframe>` is **the same element** in both modes — nothing remounts,
  so edit state inside the island survives, and the bridge never reconnects.
- `inline` islands are never offered Expand. An island may still ask through
  `ui/request-display-mode` (the host advertises `availableDisplayModes: [inline, fullscreen]`)
  and is answered the same way; the store is the source of truth and the mode flows back to it
  as `hostContext.displayMode`.
- The mode is view state (09): a reload, another step, or the step finishing puts the page back
  inline. No `data-testid` depends on it; the headless driver never relies on fullscreen.

## Tool naming — pipelines as tools

Inside an island a pipeline is a tool named after its path **relative to the implementation's
API prefix**, with `/` written as `.` (MCP tool names are `[A-Za-z0-9_.-]`):
`tools/call { name: "video.slice", arguments: {...} }` → `POST /api/<alias>/video/slice` with
`arguments` as the JSON body. The host is **slash-tolerant**: `"video/slice"` is accepted and
means the same thing — and a pipeline whose path itself contains a `.` (`feed.xml`) is only
callable by its slash name (the linter notices). The three host tools are `workflow.submit`,
`workflow.annotate` and `workflow.sign` (slash forms accepted). A call may carry
`_meta: { bffless: { method: "GET" } }` to send `arguments` as the query string; the default
is POST. The host restricts islands to **their own implementation's** rules plus the
`workflow.*` host tools: absolute paths and other aliases are a tool error. `poll` is not
available to islands — an island that enqueues a job polls it itself.

`workflow.sign` takes one `path` — an uploads-relative key under `workflows/` (a File ref's
own `path`) — and answers `{ url, expiresIn }`, a presigned GET the frame can put straight in
an `<img>`/`<video>`/`<audio>` `src`. Nothing else is signable: a path outside the harness
prefix, or one with traversal, is a tool error. It is the **one host tool a `render: island`
viewer keeps** — signing records nothing, and a viewer showing media has no other way to load
it. See 06 for the rule behind it (and its local-FS caveat).

`workflow.annotate` is budgeted **per step**, because its `annotations`/`summary` land in
persisted columns that are never offloaded the way large `outputs` are (05): at most **100
annotations** and **64 KB** of annotation JSON per step (what the row already holds counts), and
a `summary` of at most **16 KB**. An over-budget call is a tool error and records nothing;
the numbers are `ANNOTATION_BUDGET` in the island adapter.

## Sandbox

v1 renders a **single iframe** with `sandbox="allow-scripts"` (no `allow-same-origin`) and the
island HTML injected via `srcdoc`. The frame therefore has an **opaque origin**: no cookies,
no storage, no same-origin fetch — everything goes through the bridge. This is the
desktop-host profile of the spec; the web-host double-iframe (sandbox proxy on a second
origin + CSP from `_meta.ui.csp`) is a later upgrade and the implementation alias is a
ready-made second origin for it. `_meta.ui.permissions` (camera, microphone) are honoured
via the iframe `allow` attribute. The island HTML is fetched by the harness with the member's
session and injected verbatim; relative asset references inside it do not resolve (opaque
origin) — inline everything, or read siblings through `resources/read` (`ui://bffless/<impl>/…`).

## Authoring an island

```html
<!doctype html>
<html><head><meta charset="utf-8"><title>Cut editor</title>
<script type="module">
  import { App } from "https://esm.sh/@modelcontextprotocol/ext-apps";  // bundle it in practice
  const app = new App({ name: "cut-editor", version: "1.0.0" });
  app.ontoolinput = ({ arguments: args }) => render(args.clip, args.words);
  async function save(spans) {
    await app.callServerTool({ name: "workflow.submit", arguments: { outputs: { spans } } });
  }
  async function refine(brief) {
    const r = await app.callServerTool({ name: "refine-scene", arguments: { brief } });
    return r.structuredContent;     // the pipeline's JSON, object-wrapped
  }
  await app.connect();
</script></head><body>…</body></html>
```

Build: any framework; output **one HTML file** with inlined JS/CSS (the ext-apps examples
show Vite single-file builds). Put it under `islands/` in the implementation and it ships
with the deploy at `/w/<impl>/islands/<name>.html`.

The View-side method is **`app.callServerTool`** (`callTool` does not exist on `App`).

`structuredContent` is an object, so a pipeline that answers with an array or a scalar is
wrapped — a JSON object body arrives as-is, a string as `{ text }`, anything else as
`{ value }` (Decision 10). A non-2xx answer comes back as `{ isError: true, content: [{ type:
"text", text: "<code>: <message>" }] }` with the raw status under `_meta.bffless.status`.

`workflow.submit` validates `outputs` against the step's declared map (02); a mismatch is
returned as the tool's error (`content[0].text` = the per-output messages,
`structuredContent.errors` the same as an object) and the step stays `waiting`, so the island
can fix and resubmit.

## Headless

When `run.headless`, the host sets `hostContext.bffless.headless = true` (delivered in the
`ui/initialize` result, readable as `app.getHostContext().bffless`); a `headless: auto` island
must `workflow.submit` on its own within its budget (Decision 10) or fails `HEADLESS_TIMEOUT`.

Why `hostContext` and not `_meta`: the View's zod schema for `ui/notifications/tool-input`
**strips** unknown keys, so a flag cannot ride `_meta` there, while `hostContext` is
`.passthrough()` on both `McpUiHostContextSchema` and the `ui/initialize` result.
`ui/notifications/initialized` has empty params in the SDK schema and can carry nothing at all.
`tool-input` therefore sends `{ arguments }` and nothing else.

## Later

- Double-iframe sandbox proxy + per-island CSP (`_meta.ui.csp`) when third-party islands exist.
- Serving islands as real `ui://` resources from a BFFless MCP server, with implementation
  pipelines exposed as MCP tools — the reason this contract was chosen. **→ spec'd as M5:
  [10-agent-embedding.md](10-agent-embedding.md)** (the endpoint is a rule in the harness
  rule set, D22; islands serve as `ui://bffless/<impl>/islands/<name>.html` unchanged).
- WebMCP on the **harness page** (not islands): declare *start run / submit form / pick
  output* as page tools for browser agents. **→ spec'd as M5:
  [10-agent-embedding.md](10-agent-embedding.md)** (the tool catalog, D19–D21; note the
  entry point is now `document.modelContext` — `navigator.modelContext` is a deprecated
  alias).
