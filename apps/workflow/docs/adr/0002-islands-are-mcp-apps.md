---
status: accepted
date: 2026-08-19
---
# Islands use the MCP Apps contract; the harness is an MCP Apps host

Implementations need custom micro-UIs (Studio's cut editor) that receive step inputs, call
pipelines and hand back outputs. We were going to invent a postMessage protocol for a sandboxed
iframe anyway.

**Decision:** islands are MCP Apps (`io.modelcontextprotocol/ui`, spec 2026-01-26): a
self-contained `text/html;profile=mcp-app` file; the harness embeds
`@modelcontextprotocol/ext-apps` AppBridge as the host; step `with` arrives as
`ui/notifications/tool-input`; pipelines are `tools/call` proxied same-origin; completion is
our single host tool `workflow.submit` (plus `workflow.annotate`); tool names are
dot-canonical and slash-tolerant (M2 plan Decision 1). v1 renders a single `srcdoc` iframe
with `sandbox="allow-scripts"` (opaque origin); the web-host double-iframe proxy is a later
upgrade.

**Why:** the same island file can later be served as a `ui://` resource by a BFFless MCP
server and render inside Claude / Copilot / Goose with the implementation's pipelines as tools;
authors code against a public SDK, not ours; the security model (no cookies, everything via
the bridge) matches ADR-0001.

**Consequences:** `uses: island` takes an `.html`, not a JS module; islands cannot `poll` (they
call the job tool themselves); a BFFless-specific `_meta.bffless.headless` flag rides on
`tool-input` for headless runs. WebMCP (`navigator.modelContext`) is a separate, later layer on
the harness page.
