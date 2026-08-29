# Writing an implementation

A workflow is two things you write by hand, tied together by a naming convention. Nothing
generates one from the other.

| You write | Where | What it is |
|---|---|---|
| **Workflow YAML** | `.bffless/workflows/<name>.yaml` | *What* runs: inputs, jobs, steps. Spec 01. |
| **Rule set** | `.bffless/proxy-rules/<alias>/rules/<path>/<method>/rule.yaml` | *How* each pipeline step works: a BFFless pipeline (handlers, `.fn.js`). Authored **prefix-free** — `bffless/publish-workflow@v1` prepends `/api/<alias>/` at publish time. Rules-as-code. |

Mental model: the **rule set is the backend** (every pipeline step is an HTTP endpoint, a
BFFless pipeline you author as code) and the **workflow YAML is the frontend's script** — it
says which endpoints to call, in what order, with what data, and where a person steps in. The
"frontend" itself is the harness: one generic app that reads the YAML and runs it in the
browser. Islands and scripts are the parts of the frontend an implementation supplies.

The link is the step's `path`:

```yaml
- id: say
  uses: pipeline
  with: { path: echo, body: { text: "Hello" } }     # method defaults to POST
```

At run time the harness calls `POST /api/<alias>/echo` (`path` is relative to the
implementation's alias; spec 01 *Paths*). So a rule must exist at `rules/echo/post/rule.yaml`
— authored **prefix-free**; `bffless/publish-workflow@v1` rewrites it to `/api/<alias>/echo`
at publish time (`--path-prefix`, step 4). A typo on either side would be a 404 at run time, so
the linter's `rule-missing` check holds every relative `with.path` / `poll.path` to the rule
directory that serves it whenever it can see the rule set — which `publish-workflow` always
gives it, and a failing lint fails the publish.

[`bffless/workflow-hello`](https://github.com/bffless/workflow-hello) (alias `hello`) is the
reference implementation: a separate repo, not part of this monorepo — copy it, or read it
alongside this doc for the layout every step below refers to.

For a full-size one, [`apps/workflow-studio`](../../workflow-studio/) (alias `workflow-studio`)
is the worked example: the Studio port, in this monorepo. Nine jobs over thirteen rules and two
schemas, five `script` modules built from TypeScript, one React island, a matrix job, async
video ops behind a job-poll, and `headless:` declarations that keep the whole thing runnable
without a person. Where hello shows the smallest shape of each piece, workflow-studio shows what
each one looks like at scale — including the parts this doc only gestures at: its
[`scripts/stage.mjs`](../../workflow-studio/scripts/stage.mjs) is step 4's build,
[`.github/workflows/deploy-workflow-studio.yml`](../../../.github/workflows/deploy-workflow-studio.yml)
its publish, and [`bffless/README.md`](../../workflow-studio/bffless/README.md) the per-project
setup that is not carried by any rule set.

## 1. Pick an alias

`<alias>` is the implementation's name in the harness's project: `^[a-z][a-z0-9-]*$`,
unique, not `workflow` / `w` / `auth` / `_bffless`. It names the deploy alias, the rule set,
the API prefix `/api/<alias>/…` and the files prefix `/w/<alias>/…` (spec 06 *Names*).

## 2. Write the workflow

`.bffless/workflows/<name>.yaml`, per spec 01. Keep every `path` and `src` **relative** —
never write `/api/hello/…` in YAML, so the same file runs on a preview alias unchanged.

Lint it: `pnpm --filter @bffless/workflow-lint build && node packages/workflow-lint/dist/cli.js lint .bffless/workflows/<name>.yaml`.

## 3. Write one rule per pipeline step

For each distinct `path` (+ method) a step uses, one directory — no alias prefix in the
path, that is added at publish time (step 4):

```
.bffless/proxy-rules/<alias>/
  ruleset.yaml                    # name: <alias>
  rules/echo/post/rule.yaml       # targetUrl: pipeline + the handler chain
  rules/echo/post/echo.fn.js      # a function_handler, referenced as ./echo.fn.js
```

The forwarding rule that makes the bundle reachable at `/w/<alias>/…` on the harness host is
**generated**, not authored here — `bffless/publish-workflow@v1` writes it (step 4).

The smallest possible rule (`hello`'s `echo`):

```yaml
targetUrl: pipeline
pipeline:
  steps:
    - id: echo
      handler: function_handler
      code: ./echo.fn.js                    # ({ request }) => ({ text: request.body.text })
    - id: respond
      handler: response_handler
      config: { body: "{{{steps.echo}}}", status: 200, contentType: application/json }
  validators:
    - type: auth_required
      config: { allowApiKey: true }         # members and the workflow-ci key; never public
```

Contract for a pipeline step's rule (spec 03): JSON in, JSON out; a non-2xx with
`{ code, error }` becomes the step's error; bodies carry storage **paths**, never file bytes;
a pipeline that writes files takes the prefix from its body (`outPrefix: "${{ step.prefix }}"`).
A `poll:` block uses a second rule, `GET` by default (`rules/job/get/`).

## 4. Build the bundle

What the alias serves (spec 06 `index.json`):

```
dist/
  .bffless/workflows/*.yaml   # the YAMLs, copied
  .bffless/workflows/index.json  # generated: spec, impl, name, version, commit, workflows[], islands[], scripts[]
  islands/*.html              # one self-contained file per island (Vite single-file build)
  scripts/*.js                # copied verbatim — the Worker imports the module text as written
```

`index.json` is **generated, never hand-written** — `workflow-hello`'s `scripts/build.mjs`
does it (`workflow index`, lints every YAML first; a failing lint fails the build). The harness
finds an implementation by fetching `/w/<alias>/.bffless/workflows/index.json` — a deploy *is*
the publish; there is no registration step.

## 5. Deploy: use `bffless/publish-workflow@v1`

One action does everything steps 3–4 used to take multiple hand-wired steps for: lints the
rule set against the YAMLs, pushes it with the path prefix rewritten per alias, generates and
uploads `index.json`, deploys the bundle, generates the `/w/<alias>/…` forwarder, and attaches
the rule set to **both** `<alias>` and the harness alias (`workflow` by default). See
`docs/spec/06-discovery-publishing-files.md` for the full contract; `deploy.yml` in
[`bffless/workflow-hello`](https://github.com/bffless/workflow-hello) is the reference:

```yaml
- uses: bffless/publish-workflow@v1
  with:
    alias: hello
    name: Hello
    description: '…'
    repository: bffless/workflow
    api-url: ${{ vars.BFFLESS_URL }}
    api-key: ${{ secrets.BFFLESS_WORKFLOW_API_KEY }}
```

No `target-url`: from `publish-workflow` v1.2.0 the generated `/w/<alias>/…` forwarder targets
the CE backend's own serve route for the alias in-process
(`http://localhost:3000/public/<owner>/<repo>/alias/<alias>/dist`, `forwardCookies: true` —
ADR-0001 amendment). **No domain is needed for the implementation or for any of its previews**:
a domain mapping is cosmetic, and the bundle is reachable through the harness at
`https://workflow.<domain>/w/<alias>/…` as soon as it publishes. Pass `target-url` only to
override the forwarder with a public host (the legacy per-domain mode), or `backend-url` if
the CE backend is not on `localhost:3000`.

PR previews pass `rules:` explicitly (the rule-set directory is named for the implementation,
not the per-PR alias) and tear themselves down on close with `mode: teardown`:

```yaml
- uses: bffless/publish-workflow@v1   # on push / dispatch
  with: { alias: hello-pr-12, rules: .bffless/proxy-rules/hello, … }

- uses: bffless/publish-workflow@v1   # on PR close
  with: { mode: teardown, alias: hello-pr-12, repository: bffless/workflow, api-url: …, api-key: … }
```

Manual, once per install: the bucket's CORS allow-list must include the harness origin
(browser presigned PUTs), and islands and scripts need the `Cache-Control: no-transform`
response-header rules (`bffless/README.md`). A `<alias>.<domain>` domain → alias `<alias>` is
**optional** — only for humans who want to open the bundle directly; if you add one its path
is **`/dist`** (`bffless/upload-artifact` keeps the uploaded directory name as the bundle's
root), no SPA fallback. Previews are reachable at `https://workflow.<domain>/w/<alias>/…` —
their alias is `<impl>-pr-N` — with no domain of their own.

## 6. Make it headless-safe

An unattended run (CI, a schedule) is the *same page* driven by a headless browser, so a step
that waits for a person is a step that hangs — the harness refuses to let it. **Every `island`
and `form` step must declare `headless:`**, or the run fails fast at it with `HEADLESS_REQUIRED`
and a run annotation naming the step (spec 07):

```yaml
- id: choose                       # island
  uses: island
  with: { src: islands/pick-line.html, … }
  headless: auto                   # the island submits itself; see below

- id: confirm                      # form
  uses: form
  with: { fields: { cover: { type: choice, options: "${{ steps.draw.outputs.posters }}" }, … } }
  headless:
    mode: skip                     # never queued at all; these stand in for the person's answers
    outputs:
      cover: "${{ needs.card.outputs.posters[0] }}"
```

- **`skip`** — the step is `skipped` without ever being queued and its declared `outputs` stand
  in. They are validated against the step's own map (a form's evaluated fields, an island's
  `outputs`), so a value the map refuses is `HEADLESS_SKIP`, not a silent difference. A `choice`
  over File refs accepts the whole ref — it is picked by path either way. A skip that carries
  outputs is a **producing** step: its job reads `success` and the run's outputs match an
  interactive run's.
- **`auto`** — the island or form is still mounted. A form auto-submits its defaults through the
  same path a person's click takes. An island must submit itself: read the flag and act.

  ```ts
  // hello's `pick-line`, at the END of `ontoolinput`: `hostContext` is only known after
  // `connect()`, and by here the choices the person would click already exist.
  const bffless = (app.getHostContext() as { bffless?: { headless?: boolean } } | undefined)?.bffless
  if (bffless?.headless && !autoPicked) {
    autoPicked = true                       // submit once, whatever the host re-delivers
    const first = lines.querySelector('button')
    if (first) void submitTheWayAClickWould(first)
  }
  ```

  Register `ontoolinput` before `connect()` as usual, and do the auto-pick at the end of it —
  reading the flag once up front is too early, because `hostContext` is only known after the
  handshake. Then submit the way a person would, through `workflow.submit`. The step is bounded
  by its own `timeout-minutes`, or 5 minutes if it declares none — a budget that applies only in
  headless runs — and overrunning it is `HEADLESS_TIMEOUT`.
- **Nothing** — legal, and a run with a person in front of it is unaffected; `index.json` simply
  marks that workflow `headlessSafe: false` and the linter says "not headless-safe".

Prove it with the driver rather than by reading: `workflow-headless run <harness-url>
<impl>/<workflow> --inputs inputs.json --out ./artifacts`
([`@bffless/workflow-headless`](../../../packages/workflow-headless/README.md)). Exit `0` is a
run that succeeded; `3` means the page refused the start; `2` is a driver-side fault, never a run
that ran and failed.

## Checklist

- [ ] every relative `with.path` has a `rules/<path>/<method>/rule.yaml` (prefix-free)
- [ ] every `poll.path` has a `…/<poll.method or get>/` rule
- [ ] every `src:` (island, script, `render: island`) is a file in `dist/`
- [ ] `index.json` is generated by the build, and the lint passes
- [ ] every `island` / `form` step declares `headless:` (or you accept `headlessSafe: false`)
- [ ] `publish-workflow`'s `repository` input is right for this install (`target-url` only if
      you are overriding the in-process forwarder)
