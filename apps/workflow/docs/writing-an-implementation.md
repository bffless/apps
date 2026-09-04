# Writing an implementation

A workflow implementation is two things, tied together by a naming convention:

| What | Where | What it is |
|---|---|---|
| **Workflow YAML** | `.bffless/workflows/<name>.yaml` | *What* runs: inputs, jobs, steps. Spec 01. |
| **Rule set** | `.bffless/proxy-rules/<alias>/rules/<path>/<method>/rule.yaml` | *How* each pipeline step works: a BFFless pipeline (handlers, `.fn.js`). Authored **prefix-free** — `bffless/publish-workflow@v1` (CI) or `workflow publish` (local) prepends `/api/<alias>/` at publish time. Rules-as-code. |

Mental model: the **rule set is the backend** (every pipeline step is an HTTP endpoint, a
BFFless pipeline you author as code) and the **workflow YAML is the frontend's script** — it
says which endpoints to call, in what order, with what data, and where a person steps in. The
"frontend" itself is the harness: one generic app that reads the YAML and runs it in the
browser. Islands and scripts are the parts of the frontend an implementation supplies.

**`@bffless/workflow`** (`npx @bffless/workflow`) is the authoring CLI, and the primary path
through everything below: `init` creates an implementation from an existing one, `add`
scaffolds a new workflow with its rule stubs already lint-clean, `lint`/`index` validate and
build, `publish` deploys, and `rename` re-identifies a copy. This doc walks that path first.
The [appendix](#appendix-hand-authoring-reference) documents the underlying file formats —
what the CLI generates, useful when you're reading its output or hand-editing past it.

The link between the two halves is the step's `path`:

```yaml
- id: say
  uses: pipeline
  with: { path: echo, body: { text: "Hello" } }     # method defaults to POST
```

At run time the harness calls `POST /api/<alias>/echo` (`path` is relative to the
implementation's alias; spec 01 *Paths*). So a rule must exist at `rules/echo/post/rule.yaml`
— authored **prefix-free**; the prefix is rewritten at publish time (`--path-prefix`, §7). A
typo on either side would be a 404 at run time, so the linter's `rule-missing` check holds
every relative `with.path` / `poll.path` to the rule directory that serves it whenever it can
see the rule set — which both `publish-workflow` and `workflow publish` always give it, and a
failing lint fails the publish. `workflow add` scaffolds both sides together precisely so this
check is green from the start.

[`hello/`](https://github.com/bffless/workflow-implementations/tree/main/workflows/hello) in
[`bffless/workflow-implementations`](https://github.com/bffless/workflow-implementations) (alias `hello`)
is the reference implementation, and the CLI's own default `init` source — copy it, or read it
alongside this doc for the layout every step below refers to.

For a full-size one, [`workflow-studio/`](https://github.com/bffless/workflow-implementations/tree/main/workflows/workflow-studio)
(alias `workflow-studio`) in the same monorepo
is the worked example: the Studio port. Nine jobs over thirteen rules and two
schemas, five `script` modules built from TypeScript, one React island, a matrix job, async
video ops behind a job-poll, and `headless:` declarations that keep the whole thing runnable
without a person. Where hello shows the smallest shape of each piece, workflow-studio shows what
each one looks like at scale — including the parts this doc only gestures at: its
[`scripts/stage.mjs`](https://github.com/bffless/workflow-implementations/blob/main/workflows/workflow-studio/scripts/stage.mjs)
is the build the [appendix](#a3-the-bundle) describes,
[`.github/workflows/deploy-workflow-studio.yml`](https://github.com/bffless/workflow-implementations/blob/main/.github/workflows/deploy-workflow-studio.yml)
its publish, and
[`bffless/README.md`](https://github.com/bffless/workflow-implementations/blob/main/workflows/workflow-studio/bffless/README.md)
the per-project setup that is not carried by any rule set.

## 1. Pick an alias

`<alias>` is the implementation's name in the harness's project: `^[a-z][a-z0-9-]*$`,
unique, not `workflow` / `w` / `auth` / `_bffless`. It names the deploy alias, the rule set,
the API prefix `/api/<alias>/…` and the files prefix `/w/<alias>/…` (spec 06 *Names*).

An implementation is a package under `workflows/<alias>/` in
[`bffless/workflow-implementations`](https://github.com/bffless/workflow-implementations) —
add a directory there rather than forking a repo (though `init` can also target any other
readable repo, see §2). It declares its identity in **`.bffless/workflow.json`**:

```json
{ "alias": "<alias>", "harness": "workflow" }
```

`alias` must equal the `alias:` input of the package's deploy workflow (the monorepo's CI
`check-identity` step holds them together); `harness` names the harness alias the rule set
is also attached to. This is the identity anchor `workflow init/add/rename` (below) read and
write — `init` sets it on the copy it creates, `rename` rewrites it in place, and `add` reads
it to find the rule-set directory it scaffolds into.

## 2. Create the implementation: `workflow init`

```
npx @bffless/workflow init <alias> --from <owner>/<repo>|<path> [--path <dir>] [--ref <ref>] [options]
```

`init` clones `--from` (default `bffless/workflow-implementations`, shallow), finds the
package to copy via its `.bffless/workflow.json` (`--path`, or the conventional
`workflows/hello` default, or a search of the whole source tree), stages it in a disposable
temp directory, and runs it through the rename engine there — the old alias becomes
`<alias>` everywhere: the identity file, the `.bffless/proxy-rules/<old>/` directory, and
every `<old>_*.schema.yaml` file's name and `schemaId:` refs. Only the already-renamed result
is copied into `--dest` (default `./<alias>`; `.` for a repo-root implementation) — so the
rename pass never walks, and never rewrites, anything already sitting in a populated
destination.

A real invocation, copying `hello` into a fresh alias:

```bash
npx @bffless/workflow init myimpl --from bffless/workflow-implementations --path workflows/hello --project my-org/my-project
```

`init` also generates the host repo's `.github/workflows/deploy-<alias>.yml` and
`preview-<alias>.yml` (skipped only when copying a whole repo-root implementation into a
repo-root destination, whose own top-level CI travels with it) — which is why `--project
<owner/project>` is required exactly when generation would happen: it's the BFFless project
this implementation deploys to, and it's frequently **not** the same as the GitHub repo the
package lives in. Existing hand-edited workflow files at those paths are never clobbered;
they're reported as skipped.

It never clobbers an existing destination either: a path collision refuses the whole command
up front (exit 2, every colliding path listed, `--skip-existing` named as the way past it) —
`--skip-existing` keeps the host's version at each collision instead and reports it under a
"skipped (already exists) — merge by hand" section. When a collision is a load-bearing file
(`package.json`, `tsconfig.json`, a lockfile, `vite.config.*`), `--skip-existing` refuses too
(exit 2, nothing written) — skipping those orphans the copy or breaks the host's own build —
and recommends `--dest <subdir>` instead. The report also lists every pre-existing destination
directory the copy merges files into (e.g. `merged into existing scripts/ (1 file added)`).
`--dry-run` prints the full copy/rename/generate plan and writes nothing.

`init` finishes by printing the manual steps it can't do for you: create the GitHub repo (if
new), set the `BFFLESS_API_KEY` secret and `BFFLESS_URL` variable the generated workflows
read, get contributor role on the harness project, install the implementation from the
catalog if it isn't already, and — when `--dest` is a subdirectory — add it to
`pnpm-workspace.yaml` and re-run `pnpm install` (the generated workflow builds with `pnpm
--filter ./<dest> run build`, which only resolves once the workspace covers it).

See [the CLI's README](../../../packages/workflow-cli/README.md#init--start-a-new-implementation-from-any-source-repo)
for the full flag reference.

## 3. Renaming an implementation: `workflow rename`

```
npx @bffless/workflow rename <old> <new> [--dry-run]
```

Run from inside an already-`init`ed implementation directory. `<old>` must match what
`.bffless/workflow.json` actually declares, or the command refuses rather than guessing which
tree was meant. It's the same rename engine `init` runs on the staged copy, applied in place:
the `.bffless/proxy-rules/<old>/` directory, the identity file, schema file names and refs,
and every non-binary, non-vendored file's text content wherever `<old>` appears with a word
boundary on both sides (so `hello-pr-1` / `hello_jobs` are rewritten while `othello` is left
alone). Reach for this when a copy needs a different alias than the source it was cloned
from — `--dry-run` prints the rewrite diff first.

## 4. Add a workflow: `workflow add`

```
npx @bffless/workflow add <name> [--step <path>]…
```

Run from inside an already-`init`ed implementation directory (the alias, and therefore the
rule-set directory to scaffold into, is read from `.bffless/workflow.json`). Writes
`.bffless/workflows/<name>.workflow.yaml` — one job, one `uses: pipeline` step per `--step`,
defaulting to a single step named `<name>` when `--step` is omitted — plus a matching rule
stub (`rule.yaml` + `.fn.js` + `.fn.test.yaml`) per step path, so `workflow lint` reports zero
`rule-missing` findings immediately after `add`.

The stub is a starting point, not a finished workflow — fill in the pipeline's steps and
handlers, the workflow's inputs/jobs/outputs, and the poll/form/island steps a real workflow
needs, per spec 01. The [appendix](#appendix-hand-authoring-reference) documents the file
formats `add` scaffolds, for when you're editing what it generated.

## 5. Lint and index: `workflow lint` / `workflow index`

```
npx @bffless/workflow lint  <file...> [--json] [--quiet] [--rules <dir>] [--alias <alias>] [--path-prefix <p>]
npx @bffless/workflow index <workflows-dir> --out <dir> --impl <alias> --name <display> [options]
```

Same flags and the same exit-code contract as `@bffless/workflow-lint`'s own `workflow`
CLI — `lint` and `index` delegate straight into that package's `lintFile` / `buildIndex`, so
this is the same check `publish`/`publish-workflow` run before deploying. Exit `0` clean, `1`
lint errors/warnings, `2` usage/config/IO error.

Inside the monorepo: `pnpm --filter @bffless/workflow build`, then `pnpm workflow:cli lint …`
(or `node packages/workflow-cli/dist/cli.js lint …`).

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

## 7. Publish

Two paths deploy the same four moves (index → prepare/forwarder → rules sync → upload+attach;
spec 06): CI's `bffless/publish-workflow@v1` action, and the CLI's `workflow publish` for
local/manual use.

### CI: `bffless/publish-workflow@v1`

The action is still what CI uses — lints the rule set against the YAMLs, pushes it with the
path prefix rewritten per alias, generates and uploads `index.json`, deploys the bundle,
generates the `/w/<alias>/…` forwarder, and attaches the rule set to **both** `<alias>` and the
harness alias (`workflow` by default). See
`docs/spec/06-discovery-publishing-files.md` for the full contract; `deploy-hello.yml` in
[`bffless/workflow-implementations`](https://github.com/bffless/workflow-implementations) is the reference:

```yaml
- uses: bffless/publish-workflow@v1
  with:
    alias: hello
    name: Hello
    description: '…'
    repository: bffless/workflow
    api-url: ${{ vars.BFFLESS_URL }}
    api-key: ${{ secrets.BFFLESS_API_KEY }}   # contributor role on the harness project
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

The CLI has no teardown verb — preview lifecycle stays the action's job.

### Local/manual: `workflow publish`

```
npx @bffless/workflow publish [--api-url <url>] [--project <owner/name>] [--alias <alias>]
                              [--harness-alias <alias>] [--path <dir>] [--workflows <dir>]
                              [--rules <dir>] [--dry-run]
```

Run from inside an already-`init`ed implementation directory. Drives the same four moves the
action makes, in process, against a live BFFless instance — useful for testing a publish
before wiring CI, or a one-off deploy with no pipeline in front of it:

1. **index** — builds `<path>/.bffless/workflows/index.json` from `--workflows`, checked
   against `--rules`.
2. **prepare** — an alias-named copy of the rule set is staged under a disposable temp dir,
   plus a generated `/w/<alias>/*` forwarder rule, pointing at the alias served in-process by
   the CE backend — never written into the source tree.
3. **rules push** — spawns `npx --yes bffless rules push` against the staged copy, syncing it
   under `/api/<alias>/` on `--project`.
4. **upload + attach** — zips `--path` and deploys it to the `--alias`, then unions the synced
   rule set's id into `--harness-alias`'s own rule sets — idempotent, so publishing the same
   implementation twice is a no-op.

The API key comes from `BFFLESS_API_KEY` **only** — never a flag. `--dry-run` prints every
move with fully resolved values (URLs, alias, rule-set names, paths) and performs none of
them. Example, publishing from inside an initialized implementation directory:

```bash
BFFLESS_API_KEY=… npx @bffless/workflow publish --api-url https://admin.example.com --project my-org/my-project
```

See [the CLI's README](../../../packages/workflow-cli/README.md#publish--index-prepare-sync-deploy-attach)
for the full flag reference.

Manual, once per install (either path): the bucket's CORS allow-list must include the harness
origin (browser presigned PUTs), and islands and scripts need the `Cache-Control:
no-transform` response-header rules (`bffless/README.md`). A `<alias>.<domain>` domain →
alias `<alias>` is **optional** — only for humans who want to open the bundle directly; if you
add one its path is **`/dist`** (`bffless/upload-artifact` keeps the uploaded directory name
as the bundle's root), no SPA fallback. Previews are reachable at
`https://workflow.<domain>/w/<alias>/…` — their alias is `<impl>-pr-N` — with no domain of
their own.

## 8. Your workflow inside an agent host

Nothing to add: an implementation's islands and forms already work inside claude.ai (spec 10).
What a member sees there, once the harness's MCP connector is on:

- the workflow listed and described (`workflow.list`, `workflow.describe`), its runs and their
  status and outputs;
- a run waiting on an **island** step: the island, unchanged, in the chat — its pipelines fenced to
  your implementation exactly as on the page;
- a run waiting on a **form** step: the form's fields as the page would draw them (defaults and
  `options` expressions already evaluated), submitted with the same validation. A `file` field
  cannot be attached from the chat — a required one sends the person back to the harness page.

What the chat does **not** do: start or drive a run. A run is driven by a browser on the harness
page — the person, or an agent through the page's own tools. Write forms with that in mind: keep
`file` fields optional where a chat completion should be possible.

## Checklist

- [ ] every relative `with.path` has a `rules/<path>/<method>/rule.yaml` (prefix-free) —
      `workflow add` guarantees this for what it scaffolds
- [ ] every `poll.path` has a `…/<poll.method or get>/` rule
- [ ] every `src:` (island, script, `render: island`) is a file in `dist/`
- [ ] `index.json` is generated by `workflow index` (or `publish`'s index move), and the lint
      passes
- [ ] every `island` / `form` step declares `headless:` (or you accept `headlessSafe: false`)
- [ ] `publish-workflow`'s `repository` input (or `workflow publish`'s `--project`) is right
      for this install (`target-url` only if you are overriding the in-process forwarder)
- [ ] forms that should complete in a chat have no required `file` field

## Appendix: hand-authoring reference

What follows is the file-format reference the CLI generates for you — read it to understand
`workflow add`'s output, or when you need to hand-edit past what the tool scaffolds. It isn't
a separate path: everything here is what §§4–7 above operate on.

### A.1 The workflow YAML

`.bffless/workflows/<name>.yaml`, per spec 01. Keep every `path` and `src` **relative** —
never write `/api/hello/…` in YAML, so the same file runs on a preview alias unchanged.

### A.2 The rule set

For each distinct `path` (+ method) a step uses, one directory — no alias prefix in the
path, that is added at publish time:

```
.bffless/proxy-rules/<alias>/
  ruleset.yaml                    # name: <alias>
  rules/echo/post/rule.yaml       # targetUrl: pipeline + the handler chain
  rules/echo/post/echo.fn.js      # a function_handler, referenced as ./echo.fn.js
```

The forwarding rule that makes the bundle reachable at `/w/<alias>/…` on the harness host is
**generated**, not authored here — the publish step writes it.

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

### A.3 The bundle

What the alias serves (spec 06 `index.json`):

```
dist/
  .bffless/workflows/*.yaml   # the YAMLs, copied
  .bffless/workflows/index.json  # generated: spec, impl, name, version, commit, workflows[], islands[], scripts[]
  islands/*.html              # one self-contained file per island (Vite single-file build)
  scripts/*.js                # copied verbatim — the Worker imports the module text as written
  .bffless/skills/<name>/SKILL.md  # optional: skills an `ai_handler` step loads (see below)
```

An implementation may ship the **skills** its rules' `ai_handler` steps load. CE lists a
step's skills from a *deployment*, and the rule set runs under the harness alias, so a step
names its own bundle explicitly — `skills: { mode: selected, alias: <alias>, path:
<deploy path>/.bffless/skills, enabled: [<name>] }` — where `<deploy path>` is the `path`
the deploy uploads (`workflows/<alias>/dist` in the implementations monorepo — see its
`deploy-*.yml` `path:` inputs; `dist` for a standalone repo). A
publish is then the skills deploy; nothing project-level needs setting.
`workflow-implementations/workflows/workflow-studio` is the reference (`scripts/stage.mjs`, `rules/thumbnail/draft`).

`index.json` is **generated, never hand-written** — `workflow index` (or `publish`'s index
move) does it, lints every YAML first; a failing lint fails the build. The harness finds an
implementation by fetching `/w/<alias>/.bffless/workflows/index.json` — a deploy *is* the
publish; there is no registration step.
