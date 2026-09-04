# @bffless/workflow-agent-tools

The agent tool catalog of the [BFFless Workflow](https://github.com/bffless/apps/tree/main/apps/workflow)
harness: the eleven `workflow.*` tools an agent uses to drive a run on a member's
behalf, as one package both adapters consume — the **WebMCP** page adapter (the
harness page registers them on `document.modelContext` and executes them against
its own store) and the **MCP endpoint** (`POST /api/workflow/mcp`, executing them
against `/api/workflow/*`). One catalog, two adapters (spec 10, D19; ADR-0005):
neither adapter owns a name, a schema or a result shape, so neither can drift.

Pure TypeScript, zero dependencies, no DOM and no HTTP.

## What it owns

| export | what |
|---|---|
| `CATALOG`, `TOOL_NAMES`, `toolByName`, `canonicalToolName` | the tools — name, description, JSON Schema, `annotations.readOnlyHint`, scope. Names are dot-canonical and slash-tolerant (`workflow/start` ≡ `workflow.start`) |
| `SCOPES`, `TOOL_SCOPES`, `scopeOf` | the tool → scope map (D23): `workflow:read` · `workflow:run` · `workflow:files` |
| `RULE_SCOPES`, `ruleScopeOf` | the harness rule → scope map: what each `/api/workflow/*` rule declares as `requiredScopes`, held equal by the app's fence test |
| `textResult`, `errorResult`, `isErrorResult`, `CallToolResult` | MCP-shaped results: prose in `content[0].text`, data in `structuredContent`; refusals are `isError` with a spec-07-keyed `errors` map |
| `RunSnapshot`, `WaitingStep`, `snapshotFromRows`, `snapshotText`, `declaredList` | the run snapshot — `window.__workflow` (07) plus `waitingOn` — its derivation from a run row + step rows, and the one sentence both adapters say about it |
| `WorkflowDescription` | what `workflow.describe` answers |
| `ToolArgs` and the per-tool `*Args` types | the arguments each executor receives |

## The tools

| tool | scope | answers |
|---|---|---|
| `workflow.list` | read | implementations and their workflows, with `headlessSafe` |
| `workflow.describe` | read | inputs, outputs, the job/step graph, each interactive step's `headless` declaration |
| `workflow.start` | run | starts a run — `{ runId, snapshot }`; refusals keyed per input exactly as the kickoff form's |
| `workflow.status` | read | the run snapshot |
| `workflow.await` | read | the snapshot once the run needs input or ends |
| `workflow.runs` | read | past runs |
| `workflow.submitStep` | run | completes a waiting `form` or `island` step |
| `workflow.outputs` | read | the run's outputs (File refs, never bytes) |
| `workflow.sign` | files | `{ url, expiresIn }` for a File ref's `path` |
| `workflow.cancel` | run | cancels the run |
| `workflow.resume` | run | takes over an expired lease |

## Use

```ts
import { CATALOG, textResult, errorResult, snapshotFromRows } from '@bffless/workflow-agent-tools'

for (const tool of CATALOG) {
  registry.registerTool({ ...tool, execute: (args) => executors[tool.name](args) }, { signal })
}
```

An adapter registers `CATALOG` and supplies one executor per name; every executor
returns a `CallToolResult`. `snapshotFromRows(run, steps)` turns what
`GET /api/workflow/run` answers into the snapshot `workflow.status` returns.

Not in v1 (spec 10): `fork`, `retry`, `annotate`, `delete`, and any pipeline of an
implementation — an agent completes an island or form step with `workflow.submitStep`; it
does not do the island's job.
