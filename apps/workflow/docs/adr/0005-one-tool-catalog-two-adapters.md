---
status: accepted
date: 2026-09-01
---
# One agent tool catalog, two adapters; the MCP endpoint is an app rule

Agents need to drive the harness on a member's behalf: in the member's own browser (WebMCP,
`document.modelContext`) and inside chat harnesses that render MCP Apps (claude.ai, Claude
Desktop, Copilot, Goose). ADR-0002 chose the MCP Apps contract for islands in anticipation;
this decides the rest.

**Decision:** one headless tool catalog — `@bffless/workflow-agent-tools`: names, JSON
Schemas, MCP-shaped result builders, the run-snapshot type — consumed by two adapters. The
WebMCP adapter registers the catalog on the harness page and executes against the Redux
store (the agent does what a click does, with the member's session). The MCP adapter is a
**rule in the app's own rule set** — `POST /api/workflow/mcp`, stateless Streamable HTTP —
executing against the sibling `/api/workflow/*` rules and serving islands plus a bundled
run view as `ui://` resources; the run view carries the pure runner + island host over one
app-only `workflow.http` tool, so **the browser still drives runs** — the agent host's
sandboxed iframe is the browser. Auth ladders from an authless dev prototype to CE-minted
user-bound scoped app tokens to OAuth 2.1 in front of them. Spec 10 has the contract
(D19–D24).

**Why:** one catalog cannot drift between adapters; the store and the REST rows are the two
existing machine surfaces, so neither adapter re-implements harness behaviour; a rule-set
endpoint ships wherever the app installs, versioned as rules-as-code, and keeps the
platform generic.

**Considered:** per-workflow generated tools (better model ergonomics, tool count moves
with every deploy — a later endpoint option); baking the app's MCP server into CE, as a
`/_bffless/*` surface or a mode of CE's platform-admin MCP server (**rejected**: CE stays
app-agnostic; the generic `mcp_handler` pipeline handler is the CE-shaped contribution); a
standalone Node service (rejected: violates the serverless-app shape, adds an unowned
operational unit); a server-side run driver (rejected for now: a second engine runtime to
keep honest, contradicts D11 — deferred until `on.schedule` earns it); the model driving
runs turn-by-turn through tools alone (rejected as the primary path: a run would only
progress while a conversation polls).

**Consequences:** a new released package joins the train; the page gains a registration
effect and an executor layer but no new state; CE work is sequenced as app tokens →
`mcp_handler` → OAuth 2.1, each useful on its own (app tokens also give the headless
driver a real credential); the authless prototype is confined to a dev instance; islands
run unmodified in agent hosts, and `ui/update-model-context` finally has somewhere to go
(still a Later item).

**Amendment (2026-09-04, apps#554 Phase 4):** the "bundled run view … the agent host's sandboxed
iframe is the browser" clause is withdrawn. An MCP app reports and takes one input (the step
view: islands and forms); it never carries the engine. Runs are driven on the harness page — a
person, or an agent through WebMCP — and, as the long-term direction, by a server-side driver
(its own ADR when it comes). Everything else here stands. Reason: the 2026-09-04 sandbox probe
showed what the engine-in-widget shape would have cost (bridge-relayed uploads, Workers, file
reads against a per-widget origin), and the maintainer ruled the shape wrong on principle: small
apps in the chat, the engine in the browser today and on the server tomorrow.
