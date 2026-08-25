# 07 — Headless mode

The harness **always** runs in a browser (D11); unattended runs — CI, schedules, batch — use a
headless browser driving the real harness page, exactly as Studio's `headless/` runner
drives the real Studio site. Nothing of the harness is re-implemented server-side, so headless
and interactive runs are the same code, the same rows, the same history.

## Page contract (D12)

**Start:** `GET /<impl>/<workflow>/run?auto=1&inputs=<base64url(JSON)>`

- `inputs` is the kickoff form's values. `file` inputs are given as already-stored paths (the
  driver uploads first through `/api/workflow/files/prepare|register`, 06) or as `https://`
  URLs the harness fetches into run storage before starting (size-capped by `maxSize`).
- The page validates inputs against `on.manual.inputs`; invalid → the page renders the errors
  and sets `data-state="invalid"` without starting.
- Valid → the run starts immediately (no Start click), `run.headless = true` on the row.

**Observe:** the page exposes

```ts
window.__workflow = {
  runId: string, status: 'running'|'succeeded'|'failed'|'cancelled'|'invalid',
  currentSteps: string[],            // keys of active steps
  outputs: Record<string, unknown>   // filled at completion (File refs, not bytes)
}
```

and stable `data-testid`s: `run-status[data-state=…]`, `step[data-key][data-state]`,
`run-outputs`. `data-testid`s are a **contract** (Studio rule): the driver depends on them, a
UI change that breaks one breaks headless.

**Results:** read `/api/workflow/run?id=<runId>` for the full record; download `file` outputs
via their `url` (`?download=1`). The driver never scrapes the DOM for data.

## Interactive steps without a person

Each `island` / `form` step declares what to do under `run.headless`:

| `headless` | behaviour |
|---|---|
| `skip` / `{ mode: skip, outputs: {…} }` | step is `skipped`; its outputs are the literal `outputs` (expressions allowed; must satisfy the declared map). **Lint error** if a declared output that a later expression references has no skip value |
| `auto` | the island/form is still mounted; an island gets `_meta.bffless.headless = true` on `tool-input` and must `workflow/submit` on its own; a `form` auto-submits its defaults. Timeout → `HEADLESS_TIMEOUT` |
| *(none)* | the run **fails fast** at that step with annotation `step <key> needs a person; declare headless:` — never hangs |

> The `tool-input` stamp does not reach the island as written: ext-apps 1.7.5's View strips
> unknown `tool-input` keys before `app.ontoolinput` (the host still sends it, harmlessly), so
> headless needs another channel — a `headless` key inside `arguments`, or `hostContext` —
> decided at M3 along with `HEADLESS_TIMEOUT` itself.

The linter reports every interactive step lacking `headless` as a notice ("not headless-safe"),
and `index.json` marks each workflow `headlessSafe: true|false` so the UI and the CLI can say
so before a run is attempted.

## The driver — `headless/` package

`packages/workflow-headless` (Node + Playwright, Chromium from `~/.cache/ms-playwright`):

```
workflow run <harness-url> <impl>/<workflow> --inputs inputs.json [--out ./outputs] [--timeout 60m] [--token <api-key>]
workflow runs <harness-url> <impl>/<workflow> --last 10
```

- Auth: the driver injects `X-API-Key: <key>` on every request via Playwright route
  interception (BFFless pipelines and CE APIs accept API keys; no session exchange needed), or
  a session cookie can be passed in. The key's project role applies (06).
- Uploads `file` inputs, opens the start URL, waits for `data-state` terminal, fetches the
  record, writes `run.json` and downloads file outputs into `--out`, exits non-zero on
  `failed`/`cancelled`. SIGINT → clicks Cancel (run → `cancelled`), exits 130.
- Logs step transitions as they happen (polls `window.__workflow`).

A GitHub Action `bffless/run-workflow` is a thin wrapper around the CLI (Playwright + Chromium
install step, inputs from `with`, outputs as step outputs / artifacts). It is **not** a
server-side runner: it is Playwright in CI.

## Resume

Headless runs do not resume; a failed CI step re-runs the workflow. A headless run that dies
leaves a `running` row like any other (lease expires; anyone can open it and see where it got
to).
