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
run.json          the /api/workflow/run?id=… record, verbatim
outputs/          every File-ref output, named after the output (poster.svg, posters-1.png…)
steps.log         one timestamped line per status transition
console.log       the page console
01-start.png      the run page, just after the start settled
02-<status>.png   the run page at its terminal status
failed.png        written whenever the run did not succeed
```

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
| `130` | SIGINT: Cancel was clicked and the run ended `cancelled` |

Exit `3` is watched on `window.__workflow`, not on the `kickoff-invalid`
element: only two of the six refusals render that list, and the four that do
not are the likeliest ways a CI run goes wrong.

### Signals

SIGINT is the driver's own, from the moment the browser exists: before a run
page is up it closes the browser and leaves with `130`; once the run is
running it clicks Cancel and waits for the run to reach `cancelled` first, so
CI's record says the run was cancelled rather than that the driver vanished. A
second Ctrl-C closes the browser and leaves without waiting.

`SIGTERM` and `SIGHUP` stay Playwright's, which closes the browser and exits
without asking the run anything. A CI job cancellation is therefore **exit 1
with the run left `running`**, not `130` — if you need the run cancelled on a
job cancellation, send `SIGINT`.

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
