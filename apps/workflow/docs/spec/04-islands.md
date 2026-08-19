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
| island finishes the step | `tools/call { name: "workflow/submit", arguments: { outputs } }` — our one host tool for completion |
| island writes a summary / annotation | `tools/call { name: "workflow/annotate", arguments: { summary?, annotations? } }` |
| theme, dark mode, size | `ui/notifications/initialized.hostContext` (`theme`, `styles`, `displayMode`, `containerDimensions`), `ui/notifications/size-changed`, `ui/notifications/host-context-changed` |
| headless run | `hostContext.platform = "web"`, plus `_meta.bffless.headless = true` on `tool-input` (07) |
| step cancelled / run leaves the page | `ui/resource-teardown { reason }` |
| output viewer (`render: island`) | same file; `tool-input.arguments = { value }`; `workflow/submit` is rejected |

Host capabilities declared on `ui/initialize`: `tools/call`, `ui/message` (no-op: logs to the
step card), `ui/open-link` (opens a new tab, same as GitHub), `ui/request-display-mode`
(`inline` ↔ `fullscreen` only). `resources/read` is served for `ui://bffless/<impl>/...`
→ `/w/<impl>/...` (lets an island load sibling assets through the bridge when CSP forbids
direct fetch). `ui/update-model-context` is accepted and ignored in v1.

## Tool naming — pipelines as tools

Inside an island, a pipeline is a tool named by its path **relative to the implementation's
API prefix**: `tools/call { name: "video/slice", arguments: {...} }` → `POST /api/<alias>/video/slice`
with `arguments` as the JSON body (the host knows which implementation the island belongs to). The host restricts islands to **their own implementation's**
rules plus `workflow/*` host tools (MCP Apps `visibility: ["app"]` semantics): an island from
`studio` cannot call another implementation's rules. GET rules are called with `arguments` as query. `poll`
is not available to islands — an island that enqueues a job polls it itself (it has the
tool), or the workflow splits the pipeline out into its own `pipeline` step.

## Sandbox

v1 renders a **single iframe** with `sandbox="allow-scripts"` (no `allow-same-origin`) and the
island HTML injected via `srcdoc`. The frame therefore has an **opaque origin**: no cookies,
no storage, no same-origin fetch — everything goes through the bridge. This is the
desktop-host profile of the spec; the web-host double-iframe (sandbox proxy on a second
origin + CSP from `_meta.ui.csp`) is a later upgrade and the implementation alias is a
ready-made second origin for it. `_meta.ui.permissions` (camera, microphone) are honoured
via the iframe `allow` attribute.

## Authoring an island

```html
<!doctype html>
<html><head><meta charset="utf-8"><title>Cut editor</title>
<script type="module">
  import { App } from "https://esm.sh/@modelcontextprotocol/ext-apps";  // bundle it in practice
  const app = new App({ name: "cut-editor", version: "1.0.0" });
  app.ontoolinput = ({ arguments: args }) => render(args.clip, args.words);
  async function save(spans) {
    await app.callTool({ name: "workflow/submit", arguments: { outputs: { spans } } });
  }
  async function refine(brief) {
    const r = await app.callTool({ name: "refine-scene", arguments: { brief } });
    return r.structuredContent;     // the pipeline's JSON
  }
  await app.connect();
</script></head><body>…</body></html>
```

Build: any framework; output **one HTML file** with inlined JS/CSS (the ext-apps examples
show Vite single-file builds). Put it under `islands/` in the implementation and it ships
with the deploy at `/w/<impl>/islands/<name>.html`.

`workflow/submit` validates `outputs` against the step's declared map (02); a mismatch is
returned as the tool's error and the step stays `waiting`, so the island can fix and resubmit.

## Headless

When `run.headless`, a `headless: auto` island receives `tool-input` with
`_meta.bffless.headless = true` and is expected to submit on its own (e.g. accept the AI's
cuts unchanged). If it has not submitted within its `timeout-minutes` (default 5 in headless),
the step fails with `HEADLESS_TIMEOUT` (07).

## Later

- Double-iframe sandbox proxy + per-island CSP (`_meta.ui.csp`) when third-party islands exist.
- Serving islands as real `ui://` resources from a BFFless MCP server, with implementation
  pipelines exposed as MCP tools — the reason this contract was chosen.
- WebMCP (`navigator.modelContext`) on the **harness page** (not islands): declare *start run /
  submit form / pick output* as page tools for browser agents.
