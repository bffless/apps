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
- A `file` input's value is a **whole File ref** — `{ path, name, contentType, size, url }`,
  exactly the object `/api/workflow/files/register` hands back (06) — not a bare path. The
  driver uploads through `prepare` → PUT → `register` before it opens the page and puts the
  registered ref in the JSON; run inputs are stored verbatim, and nothing on this side turns a
  path into a ref, so a bare string fails validation like any other wrong-shaped value. The
  page never fetches a url a caller handed it; `https://` input values are deliberately not
  supported.
- The values are validated against `on.manual.inputs` by the very same function the kickoff
  form's own Start runs (`lib/autoStart.ts`), so a driver's inputs and a person's are never
  judged differently.
- Valid → the run starts immediately (no Start click) with `run.headless = true` on the row, and
  the page navigates to it. In place of the form the kickoff page shows a `kickoff-auto`
  ("Starting…") notice — auto mode never renders a form, since there is nobody to fill it in.
- Invalid → nothing starts, and `status: 'invalid'` goes on the global below. **Everything** that
  can stop a `?auto=1` start publishes it — they are one fact to a driver ("this is not going to
  start"), and hanging is not an acceptable way to say it — but only two of them also render the
  `kickoff-invalid` list, because the rest already have their own screen:

  | cause | `kickoff-invalid` | what the page shows |
  |---|---|---|
  | values that do not validate | yes | the per-input errors |
  | an `inputs` parameter that does not decode | yes | one error under `inputs` |
  | the workflow does not lint | no | the usual lint report |
  | the workflow file could not be fetched | no | "Couldn't read the workflow file" |
  | no such implementation / workflow | no | "No such workflow" |
  | discovery itself failed | no | the discovery error |

  So a driver waits on the **global**, not on `kickoff-invalid`: waiting on the testid (or on
  `run-status`) hangs through the last four rows, which are also the likeliest ways a CI run
  goes wrong — a typo'd alias, an unreachable instance.

**Observe:** every run page — headless or not — publishes

```ts
window.__workflow = {
  runId: string,           // '' when a start was refused before a run existed
  status: 'running'|'succeeded'|'failed'|'cancelled'|'invalid',
  currentSteps: string[],  // keys whose status is running | polling | waiting
  outputs: Record<string, unknown>,  // the run's outputs, filled at completion (File refs, not bytes)
  steps: Record<string, StepStatus>, // every step the run has reached → its status
  errors?: Record<string, string>,   // only on 'invalid': why. Keyed by the input that
                                     // failed, or by the part of the start that did:
                                     // `inputs`, `workflow`, `discovery`.
}
```

It is `undefined` when no run page is mounted, and is cleared on unmount so a stale snapshot
never outlives the page that wrote it. That includes the seam a start goes through: between the
kickoff page navigating and the run page's first publish there is one commit with no global at
all, so a driver **polls for `runId` to appear** rather than reading the global the instant the
navigation lands. `invalid` is a **page** state, not a run status: no row
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

## The driver — `packages/workflow-headless`

`@bffless/workflow-headless` (Node + Playwright, Chromium from `~/.cache/ms-playwright`), bin
`workflow-headless`:

```
workflow-headless run  <harness-url> <impl>/<workflow> --inputs inputs.json
                       [--out ./artifacts] [--timeout 60m] [--mocks] [--headed]
workflow-headless runs <harness-url> <impl>/<workflow> [--last 10] [--mocks]
```

**Auth is a member login through the admin relay** (Decision 13) — `WORKFLOW_EMAIL` /
`WORKFLOW_PASSWORD`, required unless `--mocks`. The driver opens the harness, is bounced to the
relay's `/login`, fills the two fields and waits for the URL to come back to the harness origin,
exactly as a person does.

> This replaces an earlier claim in this file that the driver injects `X-API-Key` on every
> request via route interception and needs no session exchange. That is **wrong** and was never
> implemented: two of the harness's relays forward the caller's cookies, and an API key cannot
> mint a SuperTokens session. `WORKFLOW_TOKEN` (`--token`) survives only as an *optional extra*
> header on `/api/workflow/*` **GETs** — never on a write, because a CE API key is pinned to role
> `user` regardless of who owns it, so a POST carrying both a cookie and a key can resolve to a
> different identity than the member who logged in.

Every HTTP call the driver makes is an **in-page `fetch`**, not `page.request`: the session
cookie is the credential, and in `--mocks` mode the backend is an MSW service worker that
`page.request` bypasses entirely. The one exception to the credentials rule is the
direct-to-bucket PUT, which is sent `same-origin` — the same thing the harness's own upload
does — because `include` cross-origin additionally requires the bucket to answer
`Access-Control-Allow-Credentials`, which typical S3/GCS CORS configs do not set.

What it does: uploads `file` inputs through the files trio (so the values in the URL are whole
File refs), opens the start URL, follows `window.__workflow`, and — with `--out` — writes
`run.json` (the `/api/workflow/run?id=` record), `outputs/<name>.<ext>` for every File-ref
output, `steps.log`, `console.log` and milestone screenshots (`01-start.png`,
`02-<status>.png`, `failed.png`). It logs step transitions as they happen.

**Exit codes** (the contract CI reads):

| code | |
|---|---|
| `0` | the run succeeded |
| `1` | the run `failed` or was `cancelled` |
| `2` | usage, an unreadable `--inputs`, a refused login, or any other driver-side fault — never a run that ran and failed |
| `3` | the page refused the start (`status: 'invalid'`) |
| `4` | the driver timed out (the run may still be going) |
| `130` | SIGINT: Cancel was clicked and the run reached `cancelled` |

SIGINT is the driver's own (Playwright's handler is disabled at launch, because it kills the
browser and exits 130 immediately, which loses the Cancel-then-wait). A second Ctrl-C closes the
browser and leaves. `SIGTERM`/`SIGHUP` stay Playwright's, so a CI cancellation closes the browser
under the driver and ends as exit 1, not 130.

A GitHub Action `bffless/run-workflow` is a thin wrapper around the CLI (Playwright + Chromium
install step, inputs from `with`, outputs as step outputs / artifacts). It is **not** a
server-side runner: it is Playwright in CI.

## Resume

Headless runs **do not resume**; a failed CI step re-runs the workflow. That is a rule the
harness leans on, not just advice: a `headless: auto` **form** that was `waiting` when the run
died replays as `waiting` and nothing re-fires its auto-submit, and because the wait clock is
measured from the step's recorded `startedAt` — not from when the timer was armed — a run
adopted after its budget has passed fails `HEADLESS_TIMEOUT` *immediately* rather than waiting
again. Either way the step is lost. Re-running the workflow is the supported answer, and the one
that leaves CI a clean record.

An `island` is the exception that proves the rule: the resume path re-mounts a `waiting`/
`running` island on its recorded inputs, so a `headless: auto` island reads
`hostContext.bffless.headless` again and submits itself as it did the first time. It still rides
the same `startedAt`-based clock, so a long-dead run fails it just as fast.

A headless run that dies still leaves a `running` row like any other (the lease expires; anyone
can open it and see where it got to) — and because the interactive path is untouched, a person
who opens that row can resume it and submit the waiting step by hand.
