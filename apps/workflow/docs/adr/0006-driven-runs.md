---
status: accepted
date: 2026-09-05
---
# Driven runs: a parked headless run, resumed by a dispatched driver

`workflow.start` over the MCP endpoint had nothing to start a run with, and a step answered in
claude.ai left a run nobody was driving (apps#598). ADR-0005 rejected a server-side engine.

**Decision:** there is **no second engine**. D11 stands — the harness is always in a browser;
headless is Playwright — and the driver is `@bffless/workflow-headless` on GitHub Actions in
the implementation's repo. What changes: (1) a headless run started with `wait=park` **parks**
at an `island`/`form` that declares no `headless:` — row `waiting`, lease cleared, the job
exits 0 — instead of failing `HEADLESS_REQUIRED`; the rows are the checkpoint, and Resume is
the resume. (2) A harness rule, `POST /api/workflow/run/drive`, sends a `repository_dispatch`
(`workflow-drive`) to the repo the implementation's `index.json` names (`driver.repo`), through
CE's `github_api` handler and the project's GitHub integration. The endpoint's `workflow.start`
(a pre-minted id, `pending` until the row exists) and `workflow.resume` call it;
`workflow.submitStep` calls it after its write. (3) The browser owns what it claimed: a person
who resumes on the harness page drives to the end in their tab; only a server-side submit
re-dispatches. (4) A grace window after a park lets the same job pick up an answer given within
minutes.

**Why:** one engine to keep honest (spec 09's purity fence, the same rows, the same history);
no owned service (the implementation repo already runs Actions for its deploy); nothing
app-aware in CE (D22 — `github_api` is generic, the rule is the app's); the run row already
held every fact a resume needs (05).

**Considered:** a controller inside CE's `function_handler` (rejected: the sandbox has no
`fetch` and no timers, and a `polling` step needs a controller that can poll — a browser
already is one); a Playwright sidecar next to CE (rejected: CE would know the app); a
self-hosted driver loop (deferred: the same binary polling for runs wanting a driver — the
`drive` contract is written so it can replace the dispatch); handing a page-resumed run back
to the server after its submit (rejected: a minute of cold start on a path that was free, and
the person's tab is already an engine); `workflow_dispatch` (not what CE's handler sends).

**Consequences:** three additive page-contract parameters and two page states (07); the driver
gains `resume` and exit 5; `index.json` gains `driver`; `@bffless/workflow init` writes
`workflow-drive.yml`; the catalog's `start`/`resume` words change; `on.schedule`/`on.webhook`
are now a `schedule:` block or a second dispatch type on that file (01 §Triggers); the GitHub
integration and the driver job's three secrets — `WORKFLOW_EMAIL` / `WORKFLOW_PASSWORD` (the
`run` verb still signs in through the admin relay) plus `WORKFLOW_APP_TOKEN`, optional until
the app-token-only session lands (apps#588) — are provisioned per instance by a person.
