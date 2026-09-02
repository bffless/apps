# @bffless/workflow-headless

The Playwright driver for the [BFFless Workflow](https://github.com/bffless/apps/tree/main/apps/workflow)
harness: it runs one workflow unattended — CI, a schedule, a batch — by driving
the **real harness page** in headless Chromium.

Nothing of the harness is re-implemented here. Unattended and interactive runs
are the same code, the same rows and the same history; this package only opens
the page, follows it, and writes down what happened. The page contract it
depends on is [`07-headless.md`](https://github.com/bffless/apps/blob/main/apps/workflow/docs/spec/07-headless.md).

## Install

```bash
pnpm add -D @bffless/workflow-headless
pnpm exec playwright install chromium
```

## Use

```bash
workflow-headless run https://workflow.example.com hello/interactive \
  --inputs inputs.json --out ./run-artifacts --timeout 30m

workflow-headless runs https://workflow.example.com hello/interactive --last 10
```

`--inputs` is a JSON object of kickoff values keyed by the names in the
workflow's `on.manual.inputs`. A workflow that takes none still needs a file
containing `{}` — the harness refuses a start with no `inputs` parameter rather
than silently running on defaults.

A `file` input's value is a **local path**. The driver uploads it
(`files/prepare` → `PUT` → `files/register`) and puts the registered File ref
in the URL, because that is what the page validates: a whole
`{ path, name, contentType, size, url }`, never a bare string. A `list: true`
file input takes an array of paths.

### Options

| flag | |
|---|---|
| `--inputs <file>` | the kickoff values (required) |
| `--out <dir>` | where the artifacts are written; omit it and none are |
| `--timeout <60m>` | how long to wait for a terminal status (`ms`/`s`/`m`/`h`; a bare number is seconds) |
| `--mocks` | drive the dev harness's MSW mock backend, and skip the login (see the note below) |
| `--headed` | show the browser |
| `--last <n>` | (`runs`) how many past runs to list |

`--timeout` bounds the **run**. The *start* is separately capped at **120 s** inside it: a
harness that has not published a `runId` by then is not slow, it is wrong, so a generous
`--timeout` never turns a bad harness url into an hour of waiting.

### Environment

| variable | |
|---|---|
| `WORKFLOW_EMAIL` / `WORKFLOW_PASSWORD` | the member login the harness relays. Required unless `--mocks` |
| `WORKFLOW_TOKEN` | optional, sent as `X-API-Key` on `/api/workflow/*` reads |

The credential is a **session cookie**, obtained by signing in through the
harness's admin login relay exactly as a person does. An API key cannot mint a
session, and two of the harness's relays forward the caller's cookies, so
`WORKFLOW_TOKEN` is an extra on top of the session — never a replacement for it.

## Artifacts (`--out`)

```
run.json          the /api/workflow/run?id=… record, verbatim: { run, steps }
outputs/          every File-ref output, named after the output (poster.svg, posters-1.png…)
steps.log         one timestamped line per status transition
console.log       the page console
01-start.png      the run page, just after the start settled
02-<status>.png   the run page at its terminal status
failed.png        written whenever the run did not succeed
```

A start that times out (exit `4`) writes `failed.png`, `console.log` and `steps.log` too. That
is the one refusal with no record to fall back on — every refusal the page can explain arrives
as exit `3` — so the page's console is the whole diagnosis.

The run's status is `run.json.run.status`, and each step's settled status is a row of
`run.json.steps` (`{ key, status, … }`). Read verdicts from there rather than
from `steps.log`, which is a 1 s sampler: it can miss a status a run passed
through, so it is a narrative, not proof that something never happened.

An output is saved when its **value is a File ref**, not when its declared type
is `file`: a run-level `outputs:` entry that simply forwards a step's file
(`poster: ${{ jobs.card.outputs.poster }}`) declares no type at all, so type is
not something this side can filter on. A `render: island` output that carries a
ref is therefore saved too. An output that will not download is reported and
skipped — one unreadable ref never costs you the rest of the artifact set.

### `--mocks`

`--mocks` points the driver at the dev harness's in-browser MSW backend, which
is how this package is smoke-tested without a deployment. One dev-only wrinkle:
the mock's storage lives in page memory, and the start URL is a fresh
navigation, so bytes uploaded for a `file` input are gone by the time a step
asks for them. The ref itself is correct and the run is real — only a *download*
of a mock-uploaded input 404s. Against a deployment the bytes are in the bucket
and this does not arise.

## Exit codes

| code | |
|---|---|
| `0` | the run succeeded |
| `1` | the run failed or was cancelled |
| `2` | usage, an unreadable `--inputs`, a refused login, or any other driver-side fault (a failed upload, an API read that would not answer, an unexpected exception) — deliberately never `1`, so `if: failure()` can tell "the run failed" from "the driver could not reach the harness" |
| `3` | the page refused the start (`status: 'invalid'`) — bad values, an undecodable `inputs`, a workflow that does not lint or could not be read, no such implementation/workflow, or a discovery failure |
| `4` | the driver timed out (the run may still be going) |
| `130` | SIGINT: the driver was interrupted — before the run page exists it closes the browser and leaves; once the run is up it clicks Cancel and follows the run to `cancelled` first (see *Signals*) |

Exit `3` is watched on `window.__workflow`, not on the `kickoff-invalid`
element: only two of the six refusals render that list, and the four that do
not are the likeliest ways a CI run goes wrong.

### Signals

SIGINT is the driver's own, from the moment the browser exists: before a run
page is up it closes the browser and leaves with `130`; once the run is
running it clicks Cancel and waits for the run to reach `cancelled` first, so
CI's record says the run was cancelled rather than that the driver vanished. A
second Ctrl-C closes the browser and leaves without waiting.

`SIGTERM` and `SIGHUP` stay Playwright's, whose handlers close the browser but
do **not** exit the process. So the driver survives the signal, its in-flight
call rejects against a browser that is no longer there, and that lands in the
driver-fault branch: a CI job cancellation ends as **exit 2 with the run left
`running`** — not `130`, and not `1`, which stays reserved for a run that
really did fail. Send `SIGINT` if you want the run cancelled first.

## In CI

Two pieces of wiring live in [`bffless/apps`](https://github.com/bffless/apps), and they are the
worked examples for anyone wiring this up elsewhere:

- **`.github/workflows/workflow-headless-run.yml`** — the live run. `workflow_dispatch` only, on
  purpose: a run there writes a real row, uploads to the deployment's storage and calls whatever
  pipelines the workflow calls. It takes `workflow`, `inputs`, `harness_url` and
  `timeout_minutes` (digits only), passes `WORKFLOW_EMAIL` / `WORKFLOW_PASSWORD` from repo
  secrets, uploads `output/` as an artifact and summarises the run id and status. Note that
  cancelling the job sends `SIGTERM`, which is **exit 2 with the run left `running`** (see
  *Signals*) — hence `cancel-in-progress: false`.
- **`apps/workflow/e2e/headless.spec.ts`** — the end-to-end proof of this package, with no
  deployment involved: Playwright spawns the built `dist/cli.js` against the harness dev server
  in `--mocks` mode and reads the artifacts back off disk. It fails, rather than skipping, when
  `dist/cli.js` is missing — so `pnpm --filter @bffless/workflow-headless build` comes before
  `test:e2e` in CI.

There is deliberately no `bffless/run-workflow` GitHub Action yet; a dispatch workflow calling
the CLI is all a single repo needs.

## As a library

```ts
import { launchBrowser, runWorkflow } from '@bffless/workflow-headless'

const browser = await launchBrowser()
const report = await runWorkflow(
  { harnessUrl, impl: 'hello', workflow: 'interactive', inputs: {}, timeoutMs: 1_800_000, mocks: false, credentials },
  { browser, log: console.log },
)
await browser.close()
```

Everything below the CLI talks to a `PageLike`/`BrowserLike` seam rather than
to Playwright, so the unit suite launches no browser.

## Page tools (WebMCP)

The harness page registers its agent tool catalog on `document.modelContext`
([spec 10](https://github.com/bffless/apps/blob/main/apps/workflow/docs/spec/10-agent-embedding.md)),
polyfilled when the browser has no native WebMCP. `listPageTools`,
`waitForPageTools` and `callPageTool` drive those tools through `page.evaluate`
— how a walk proves the catalog against a real deployment with no agent host:

```ts
import { callPageTool, waitForPageTools } from '@bffless/workflow-headless'

await waitForPageTools(page, { timeoutMs: 30_000 })
const started = await callPageTool(page, 'workflow.start', { impl: 'hello', workflow: 'interactive', inputs: {} })
const done = await callPageTool(page, 'workflow.await', { until: 'terminal' })
```

`callPageTool` resolves to the `CallToolResult` — an `isError` refusal included,
since that is an answer to assert on — and throws `PageToolError` only when the
bridge itself fails (no registry, no such tool).
