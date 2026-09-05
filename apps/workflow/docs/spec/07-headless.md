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

- **`wait=park`** (with `auto=1`; ADR-0006). An `island`/`form` step that declares no `headless:`
  **parks** the run instead of failing `HEADLESS_REQUIRED`: the step is queued and mounted as it
  would be for a person, its row reaches `waiting`, and once nothing else is queued, running or
  polling the page clears the lease (the same `run/update` patch `run.finished` writes; the
  status stays `running`), stops driving, and publishes `status: 'parked'`. Releasing the lease
  tears the run's live machinery down, so **only a `form` stays answerable on screen**: an
  island's handle is disposed with every other bridge and its frame goes, and a person who wants
  to answer it clicks *Resume* — which re-mounts the island on its recorded inputs. A `headless: auto`
  step still submits itself and a `skip` still stands its outputs in; a run whose only waiting
  steps are `auto` never parks. A parked step runs no clock at all — a parked tab holds no
  lease and must not write a terminal row; a declared `timeout-minutes` applies again once the
  run is resumed, re-armed from the step's recorded `startedAt` exactly as §Resume already says
  (a run adopted after its budget has passed fails `HEADLESS_TIMEOUT` immediately). The
  `HEADLESS_AUTO_DEFAULT_MS` budget is never applied to an undeclared step.
- **`runId=<run_ulid>`** (with `auto=1`). The row is inserted under this id instead of a minted
  one, so a caller can hand the id out before the browser exists. Malformed → `invalid`,
  `errors.runId`; already in use → `invalid`, `errors.runId` (and the create rule answers
  `409 RUN_EXISTS` as a backstop).
- **`resume=1`** (on a run page, optionally with `wait=park`). The page adopts the lease without
  the confirm and relaunches non-terminal steps through Resume (05). Held by someone else →
  `status: 'busy'`, nothing driven. A terminal run → its terminal status; nothing to do.

**Observe:** every run page — headless or not — publishes

```ts
window.__workflow = {
  runId: string,           // '' when a start was refused before a run existed
  status: 'running'|'succeeded'|'failed'|'cancelled'|'invalid'|'parked'|'busy',
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
navigation lands. `invalid`, `parked` and `busy` are **page** states, not run statuses: no row
ever carries them, and they are deliberately absent from the persisted `RunStatus` vocabulary.

And stable `data-testid`s: `run-status[data-state=…]` (now also `parked` and `busy`, the page
states of a driven run), `step[data-key][data-state]`, `run-outputs`, and on the kickoff page
`kickoff-auto` / `kickoff-invalid` (plus, inside the hello bundle's own poster island,
`island-sign-error`). `data-testid`s are a **contract** (Studio rule): the driver depends on
them, a UI change that breaks one breaks headless.

**Islands, unattended:** the pane is the only thing that mounts an island (Decision 11), and in
a headless run nobody clicks a chip — so the run page opens the oldest `running`/`waiting`
island itself whenever nothing is selected or the selected step has finished. Without it a
`headless: auto` island would sit at `running` until its wait budget expired.

**Results:** read `/api/workflow/run?id=<runId>` for the full record; download `file` outputs
from their `url`, with **no** `?download=1` — the harness serves the bytes either way, so the
flag is not something the driver relies on (apps#362). The driver never scrapes the DOM for
data.

## Interactive steps without a person

Each `island` / `form` step declares what to do under `run.headless`:

| `headless` | behaviour |
|---|---|
| `skip` / `{ mode: skip, outputs: {…} }` | step is `skipped` without ever being queued; its outputs are the literal `outputs` (expressions allowed; must satisfy the declared map — a value that does not fails `HEADLESS_SKIP`). **Lint error** if a declared output that a later expression references has no skip value |
| `auto` | the island/form is still mounted; an island reads `hostContext.bffless.headless` and must `workflow.submit` on its own; a `form` auto-submits its defaults through the same path a person's submit takes (defaults its own fields refuse → `HEADLESS_FORM`). Timeout → `HEADLESS_TIMEOUT` |
| *(none)* | the run **fails fast** at that step — `HEADLESS_REQUIRED`, plus a run annotation `step <key> needs a person; declare headless:` — never hangs |

> When `run.headless`, the host sets `hostContext.bffless.headless = true` (delivered in the
> `ui/initialize` result, readable as `app.getHostContext().bffless`); a `headless: auto` island
> must `workflow.submit` on its own within its budget (Decision 10) or fails `HEADLESS_TIMEOUT`.

The budget an `auto` step is bounded by is its own `timeout-minutes` (01) when it declares one,
and otherwise **5 minutes** — `HEADLESS_AUTO_DEFAULT_MS`, applied only in a headless run, because
a person is allowed to take as long as they like. It is measured from the step's recorded
`startedAt`, not from when the clock was armed (see *Resume*).

A `skip` produces its outputs the way a submit would: they are validated against the step's own
declared map — a `form`'s *evaluated* fields, an `island`'s `outputs` — and a `choice` over File
refs may be given the whole ref, since the field is picked by path either way. **Any** `headless: skip`
counts as a **producing** step — a bare `skip` as much as one with an `outputs:` map, because a
bare skip produces an empty map rather than nothing — so its job reads `success` and a headless
run's job and run outputs match an interactive run's. Narrowing that to "a skip that produced
*values*" would leave a job whose only step is a bare skip reading `skipped` unattended and
`success` attended, and gate every downstream `needs` on it differently: the exact divergence
this rule exists to prevent. An `if:`-skipped step carries nothing at all and still skips its
job.

## Unattended — "Don't wait for me"

An **interactive** run can honour the same declarations without a driver (apps#432): the
kickoff form offers a run-level toggle, **"Don't wait for me"**, whenever the workflow has an
`island`/`form` step that declares `headless:`. With it on, `run.unattended = true` goes on
the row (a separate column — `headless` stays what the driver sets, and the two are never
conflated), and:

| step declares | headless run | unattended run |
|---|---|---|
| `skip` | skipped with its declared outputs | the same |
| `auto` | mounted; `hostContext.bffless.headless = true`; must self-submit | the same — the island sees the one flag and cannot tell the two apart |
| *(none)* | `HEADLESS_REQUIRED`, fails fast | **waits for the person**, who is there |

The tab keeps driving as an interactive run does (the same lease, the same page, the same
`window.__workflow`); the person can watch, and the page keeps a `headless: auto` island in
the pane by itself as it would headless. The **5-minute default budget is not applied**: it
exists because nobody is there to notice a hang, and here somebody is (a declared
`timeout-minutes` still is). `unattended` is a person's choice on an interactive run;
`headless` is the driver's — a headless run never sets `unattended`, and a run started from
the kickoff form never sets `headless`.

### Per step — `auto-accept`

The same choice can be made for **one step** by the workflow author (apps#435): an
`island`/`form` step may declare `auto-accept: ${{ expr }}` (01). It is evaluated when the
step is reached, against the same contexts as its `if:`; when truthy on an interactive run the
harness applies *that step's* `headless:` declaration exactly as an unattended run would —
`auto` → mounted self-driving (`hostContext.bffless.headless = true`, and the page keeps it in
the pane by itself), `skip` → its declared outputs — and every other step is left to the person.
The usual shape hands the question back to the person as an ordinary kickoff input: Studio's
`trim` declares `auto-accept: ${{ inputs.accept_cuts }}`, offered as **"Auto-accept the cut
edits"** (default on) directly above "Don't wait for me" — only the cut editor, every scene,
while the blog review and the cover pick still wait. The answer lives in the run's persisted
`inputs`, so Resume reads it for free and nothing new goes on the row. Under `run.unattended`
the key is redundant (unattended already honours every declaration); under `run.headless` it is
not read at all. `auto-accept` on a step with no `headless:` is a lint error
(`auto-accept-headless`) — there is nothing to apply — and a bad expression fails the step with
`AUTO_ACCEPT`.

Unattended is the person's run-level choice made once at kickoff; `auto-accept` is the author's
per-step choice, usually handed back to the person as an input. Both are decided before the
island mounts — nothing is told to change its mind mid-flight, and nothing remounts. There is
no per-step control on the run page: an island's own **Done** is always on screen now that
islands open inline (04), and a second button that did the same thing was only confusion.

The linter reports every interactive step lacking `headless` as a notice ("not headless-safe"),
and `index.json` marks each workflow `headlessSafe: true|false` so the UI and the CLI can say
so before a run is attempted.

## The driver — `packages/workflow-headless`

`@bffless/workflow-headless` (Node + Playwright, Chromium from `~/.cache/ms-playwright`), bin
`workflow-headless`:

```
workflow-headless run    <harness-url> <impl>/<workflow> --inputs inputs.json
                         [--out ./artifacts] [--timeout 60m] [--mocks] [--headed]
                         [--wait fail|park] [--run-id run_…] [--grace 5m]
workflow-headless runs   <harness-url> <impl>/<workflow> [--last 10] [--mocks]
workflow-headless resume <harness-url> <run-id>
                         [--out ./artifacts] [--timeout 60m] [--grace 5m] [--mocks] [--headed]
```

**Auth is a member login through the admin relay** (Decision 13) — `WORKFLOW_EMAIL` /
`WORKFLOW_PASSWORD`, required unless `--mocks`. The driver opens the harness, is bounced to the
relay's `/login`, fills the two fields and waits for the URL to come back to the harness origin,
exactly as a person does. There is deliberately no `--token` flag to match `WORKFLOW_TOKEN`: a
credential on a command line lands in process listings and CI logs, so the environment is the
only way in.

> This replaces an earlier claim in this file that the driver injects `X-API-Key` on every
> request via route interception and needs no session exchange. That is **wrong** and was never
> implemented: two of the harness's relays forward the caller's cookies, and an API key cannot
> mint a SuperTokens session. `WORKFLOW_TOKEN` survives only as an *optional extra*
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
`run.json` (the `/api/workflow/run?id=` record verbatim, i.e. `{ run, steps }` — the run's status
is `run.json.run.status` and each step's settled status is a row of `run.json.steps`),
`outputs/<name>.<ext>` for every File-ref output, `steps.log`, `console.log` and milestone
screenshots (`01-start.png`, `02-<status>.png`, `failed.png`). It logs step transitions as they
happen; `steps.log` is a 1 s sampler, so it is a narrative, not evidence that a status never
occurred — assert on `run.json`. An output is downloaded when its **value** is a File ref, not
when its declared type is `file`: a run-level output that forwards a step's file declares no type
at all.

**Driven runs** (ADR-0006). `--wait park` (default `fail`) parks at a step that needs a person
instead of failing: the driver stops driving, leaves with 0, writes `03-parked.png`, and reports
`parkedOn` — the CLI's `parked: <run id> (<step keys>)` line. Which keys those are is the
driver's own read of the page (`currentSteps`), not a field of the record: `run.json` is the
record verbatim, and a parked run's row still says `running`. `--run-id run_…` inserts the row
under a pre-minted id, so a `--wait park` run and its `resume` name the same one. `--grace`
(default 5 m) keeps re-reading the record every 10 s after a park: once every parked step's row
has settled and nobody took the lease, the driver re-opens the run page with `?resume=1` and
finishes the run **in the same job**; the window running out — or a live lease, a person's tab
or a second job — ends the job at 0, parked. `resume <harness-url> <run-id>` picks that up
later: `impl`/`workflow` come off the record, it opens the run page with `?resume=1&wait=park`,
writes `01-resume.png` and follows the run home under the same park rules (a second interactive
step parks again). A run that has already ended is reported at its own status without being
opened; a run someone else is driving is exit 5, untouched. `--timeout` bounds each **follow
leg** — a start or a `resume` to the next park or terminal status — not the job as a whole, so
a park-and-resume job may take up to N × `--timeout`.

Each leg's start is separately capped at **120 s** within `--timeout`, because a harness that
has not published a `runId` by then is not slow. A start that times out still writes
`failed.png`, `console.log` and `steps.log` before it leaves with 4 — it is the one refusal with
no run record behind it, since everything the page can explain comes back as `invalid` (3).

**Exit codes** (the contract CI reads):

| code | |
|---|---|
| `0` | the run succeeded, or parked (`--wait park`): it waits on a person and the report says where |
| `1` | the run `failed` or was `cancelled` |
| `2` | usage, an unreadable `--inputs`, a refused login, or any other driver-side fault — never a run that ran and failed |
| `3` | the page refused the start (`status: 'invalid'`) |
| `4` | the driver timed out (the run may still be going) |
| `5` | another tab or job holds the lease, so nothing was driven — `resume`, or a `run --wait park` that resumed after its grace window and lost the race for the lease |
| `130` | SIGINT: the driver was interrupted — before the run page exists it closes the browser and leaves; once the run is up it clicks Cancel and follows the run to `cancelled` first |

SIGINT is the driver's own (Playwright's handler is disabled at launch, because it kills the
browser and exits 130 immediately, which loses the Cancel-then-wait). A second Ctrl-C closes the
browser and leaves. `SIGTERM`/`SIGHUP` stay Playwright's, whose handlers close the browser without
exiting the process — the driver survives, its in-flight call rejects, and that is a driver fault,
so a CI cancellation ends as **exit 2** with the run left `running` (not 130, and not 1).

## In CI

Three things exist, and a fourth does not.

- **`.github/workflows/workflow-headless-run.yml`** (`bffless/apps`) — the live run.
  `workflow_dispatch` only, deliberately: a run there writes a real row, uploads to the
  deployment's storage and calls whatever pipelines the workflow calls. Inputs `workflow`,
  `inputs`, `harness_url` (default `https://workflow.j5s.dev`) and `timeout_minutes` (digits
  only, a **string** so `fromJSON` is defined; the job ceiling is that + 10). Credentials are the
  repo's existing `WORKFLOW_EMAIL` / `WORKFLOW_PASSWORD` secrets. Every input reaches the shell
  through `env:` rather than being interpolated into a `run:` string. It uploads `output/` as the
  `workflow-run-output` artifact and writes the run id and status to the step summary.
  `concurrency` queues rather than cancels, because cancelling would SIGTERM the driver — exit 2
  with the run left `running` (above), not a cancelled run.
- **`apps/workflow/e2e/headless.spec.ts`** — the proof without a deployment. It spawns the built
  `packages/workflow-headless/dist/cli.js` against the Playwright `webServer` in `--mocks` mode
  (no `page` fixture, so only the driver's Chromium runs) and reads the artifacts back off disk.
  From M3 the headless CLI *is* the e2e (09). It **fails**, rather than skipping, when the driver
  is not built.
- **`.github/workflows/workflow-drive.yml`** in the **implementation's** repo — the driver job a
  driven run dispatches (ADR-0006). `@bffless/workflow init` writes it; `index.json`'s
  `driver.repo` names the repo the harness's `drive` rule dispatches to. It listens on
  `repository_dispatch` `types: [workflow-drive]` and reads `client_payload`
  (`mode`, `run_id`, `harness_url`, and for `mode: run` a `workflow` and `inputs`), running
  `workflow-headless run --wait park --run-id …` or `workflow-headless resume …`. It carries
  three secrets: `WORKFLOW_EMAIL` / `WORKFLOW_PASSWORD` — the `run` verb still signs in through
  the admin relay — plus `WORKFLOW_APP_TOKEN`, optional until the app-token-only session lands
  (apps#588). The dispatch itself is authorised by the project's CE GitHub integration (Project
  Settings → Integrations), not by a repo secret.
- **There is no `bffless/run-workflow` GitHub Action.** Earlier drafts of this file promised one —
  a thin `with`-inputs wrapper around the CLI. It was not built: the repo-local dispatch workflow
  is the right shape for a single monorepo, and the Action is a follow-up for the day a second
  repo wants to run a workflow in CI. Either way it would be Playwright in CI, never a
  server-side runner.

## Driven runs — park and resume (ADR-0006)

| moment | `workflow_runs.status` | waiting step row | lease |
|---|---|---|---|
| job driving | `running` | — | job's owner, heartbeat every 15 s |
| parked | `running` | `waiting` | released (`lease_owner` null) |
| grace window | `running` | `waiting` | released; driver polls the run |
| answered over the endpoint | `running` | `succeeded` (outputs written by `submitStep`) | released → `drive` dispatches |
| answered on the page | `running` → … | `succeeded` | the person's tab |
| resumed by a job | `running` | — | job's owner |

The browser owns what it claimed: a person who resumes on the harness page drives to the end in
their tab; a server-side submit over the MCP endpoint re-dispatches the driver (10).

## Resume

**Driven runs are the exception:** a run the driver parked is a `running` row with a `waiting`
step and no lease; `workflow-headless resume <harness-url> <run-id>` (or a person on the page)
resumes it exactly as any abandoned run is resumed.

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
