# 07 — Headless mode

The harness **always** runs in a browser (D11); unattended runs — CI, schedules, batch — use a
headless browser driving the real harness page, exactly as Studio's `headless/` runner
drives the real Studio site. Nothing of the harness is re-implemented server-side, so headless
and interactive runs are the same code, the same rows, the same history.

## Page contract (D12)

**Start:** `GET /<impl>/<workflow>/run?auto=1&inputs=<base64url(JSON)>`

- `inputs` decodes to a JSON **object** of kickoff values, keyed by the names in
  `on.manual.inputs`; base64url padding is optional and the bytes are read as UTF-8. A name the
  object leaves out takes its declared `default`, and a key the workflow does not declare is
  dropped — the same resolution the form's own initial state uses. The parameter itself is
  **required**: a workflow that takes no inputs is started with `inputs=e30` (`{}`), so a
  mistyped parameter is a refusal rather than a silent run on defaults.
- `file` inputs are given as **already-stored paths** — the driver uploads through
  `/api/workflow/files/prepare|register` (06) before it opens the page. The page never fetches a
  url a caller handed it; `https://` input values are deliberately not supported.
- The values are validated against `on.manual.inputs` by the very same function the kickoff
  form's own Start runs (`lib/autoStart.ts`), so a driver's inputs and a person's are never
  judged differently.
- Valid → the run starts immediately (no Start click) with `run.headless = true` on the row, and
  the page navigates to it. In place of the form the kickoff page shows a `kickoff-auto`
  ("Starting…") notice — auto mode never renders a form, since there is nobody to fill it in.
- Invalid → nothing starts, and the refusal is reported **twice**: as a `kickoff-invalid` list in
  the DOM, and as `status: 'invalid'` on the global below. Three things count as invalid — values
  that do not validate, an `inputs` parameter that does not decode, and a workflow whose file
  could not be read or does not lint. To a driver they are one fact ("this is not going to
  start"), and hanging is not an acceptable way to say it.

**Observe:** every run page — headless or not — publishes

```ts
window.__workflow = {
  runId: string,           // '' when a start was refused before a run existed
  status: 'running'|'succeeded'|'failed'|'cancelled'|'invalid',
  currentSteps: string[],  // keys whose status is running | polling | waiting
  outputs: Record<string, unknown>,  // the run's outputs, filled at completion (File refs, not bytes)
  steps: Record<string, StepStatus>, // every step the run has reached → its status
  errors?: Record<string, string>,   // only on 'invalid': why, keyed by input name
}
```

It is `undefined` when no run page is mounted, and is cleared on unmount so a stale snapshot
never outlives the page that wrote it. `invalid` is a **page** state, not a run status: no row
ever carries it, and it is deliberately absent from the persisted `RunStatus` vocabulary.

And stable `data-testid`s: `run-status[data-state=…]`, `step[data-key][data-state]`,
`run-outputs`, and on the kickoff page `kickoff-auto` / `kickoff-invalid` (plus, inside the
hello bundle's own poster island, `island-sign-error`). `data-testid`s are a **contract**
(Studio rule): the driver depends on them, a UI change that breaks one breaks headless.

**Islands, unattended:** the pane is the only thing that mounts an island (Decision 11), and in
a headless run nobody clicks a chip — so the run page opens the oldest `running`/`waiting`
island itself whenever nothing is selected or the selected step has finished. Without it a
`headless: auto` island would sit at `running` until its wait budget expired.

**Results:** read `/api/workflow/run?id=<runId>` for the full record; download `file` outputs
via their `url` (`?download=1`). The driver never scrapes the DOM for data.

## Interactive steps without a person

Each `island` / `form` step declares what to do under `run.headless`:

| `headless` | behaviour |
|---|---|
| `skip` / `{ mode: skip, outputs: {…} }` | step is `skipped` without ever being queued; its outputs are the literal `outputs` (expressions allowed; must satisfy the declared map — a value that does not fails `HEADLESS_SKIP`). **Lint error** if a declared output that a later expression references has no skip value |
| `auto` | the island/form is still mounted; an island reads `hostContext.bffless.headless` and must `workflow.submit` on its own; a `form` auto-submits its defaults through the same path a person's submit takes (defaults its own fields refuse → `HEADLESS_FORM`). Timeout → `HEADLESS_TIMEOUT` |
| *(none)* | the run **fails fast** at that step — `HEADLESS_REQUIRED`, plus a run annotation `step <key> needs a person; declare headless:` — never hangs |

> When `run.headless`, the host sets `hostContext.bffless.headless = true` (delivered on
> `ui/initialize`, readable as `app.getHostContext().bffless`); a `headless: auto` island must
> `workflow.submit` on its own within its budget (Decision 10) or fails `HEADLESS_TIMEOUT`.

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

Headless runs **do not resume**; a failed CI step re-runs the workflow. That is a rule the
harness leans on, not just advice: a `headless: auto` form that was `waiting` when the run died
replays as `waiting` with its wait clock re-armed and nothing re-fires its auto-submit, so a
resumed headless run would sit there until `HEADLESS_TIMEOUT`. Re-running the workflow is the
supported answer, and the one that leaves CI a clean record.

A headless run that dies still leaves a `running` row like any other (the lease expires; anyone
can open it and see where it got to) — and because the interactive path is untouched, a person
who opens that row can resume it and submit the waiting step by hand.
