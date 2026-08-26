# Writing an implementation

A workflow is two things you write by hand, tied together by a naming convention. Nothing
generates one from the other.

| You write | Where | What it is |
|---|---|---|
| **Workflow YAML** | `.bffless/workflows/<name>.yaml` | *What* runs: inputs, jobs, steps. Spec 01. |
| **Rule set** | `.bffless/proxy-rules/<alias>/rules/api/<alias>/<path>/<method>/rule.yaml` | *How* each pipeline step works: a BFFless pipeline (handlers, `.fn.js`). Rules-as-code. |

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
implementation's alias; spec 01 *Paths*). So a rule must exist at
`rules/api/<alias>/echo/post/rule.yaml`. Rules-as-code derives the route from the directory:
`api/hello/echo/post` → `POST /api/hello/echo`. A typo on either side is a 404 at run time —
there is no build step that checks the two agree ([issue](#what-the-tooling-does-not-do-yet)).

`hello` (`apps/workflow`, alias `hello`) is the reference implementation: copy it.

## 1. Pick an alias

`<alias>` is the implementation's name in the harness's project: `^[a-z][a-z0-9-]*$`,
unique, not `workflow` / `w` / `auth` / `_bffless`. It names the deploy alias, the rule set,
the API prefix `/api/<alias>/…` and the files prefix `/w/<alias>/…` (spec 06 *Names*).

## 2. Write the workflow

`.bffless/workflows/<name>.yaml`, per spec 01. Keep every `path` and `src` **relative** —
never write `/api/hello/…` in YAML, so the same file runs on a preview alias unchanged.

Lint it: `pnpm --filter @bffless/workflow-lint build && node packages/workflow-lint/dist/cli.js lint .bffless/workflows/<name>.yaml`.

## 3. Write one rule per pipeline step

For each distinct `path` (+ method) a step uses, one directory:

```
.bffless/proxy-rules/<alias>/
  ruleset.yaml                              # name: <alias>
  rules/api/<alias>/echo/post/rule.yaml     # targetUrl: pipeline + the handler chain
  rules/api/<alias>/echo/post/echo.fn.js    # a function_handler, referenced as ./echo.fn.js
  rules/w/<alias>/[...path]/get.rule.yaml   # the forwarding rule (step 5)
```

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
A `poll:` block uses a second rule, `GET` by default (`rules/api/<alias>/job/get/`).

## 4. Build the bundle

What the alias serves (spec 06 `index.json`):

```
dist/
  .bffless/workflows/*.yaml   # the YAMLs, copied
  .bffless/workflows/index.json  # generated: spec, impl, name, version, commit, workflows[], islands[], scripts[]
  islands/*.html              # one self-contained file per island (Vite single-file build)
  scripts/*.js                # copied verbatim — the Worker imports the module text as written
```

`index.json` is **generated, never hand-written** — `hello` does it in
`scripts/stage-hello.mjs` (lints every YAML first; a failing lint fails the build). The harness
finds an implementation by fetching `/w/<alias>/.bffless/workflows/index.json` — a deploy *is*
the publish; there is no registration step.

## 5. Deploy: bundle + rules, attached to both aliases

Two actions, in this order (see `.github/workflows/deploy-workflow.yml`):

1. `bffless/deploy-proxy-rules@v1` with `path: .bffless/proxy-rules/<alias>` and
   `prune: true` — syncs the rule set named `<alias>`.
2. `bffless/upload-artifact@v1` with `path: dist`, `alias: <alias>`,
   `proxy-rule-set-names: <alias>` — deploys the bundle and attaches the set.

The set must also be attached to the **harness** alias (`workflow`), because the browser only
ever talks to the harness host (single origin, ADR-0001): add `<alias>` to the harness deploy's
`proxy-rule-set-names`. The `rules/w/<alias>/[...path]/get.rule.yaml` forwarder
(`targetUrl: https://<alias>.<domain>`, `forwardCookies: true`) is what makes the bundle
reachable on the harness host as `/w/<alias>/…`.

Manual, once per install: the `<alias>.<domain>` domain → alias `<alias>` (no SPA fallback), and
the bucket's CORS allow-list must include the harness origin (browser presigned PUTs). Islands
and scripts need the `Cache-Control: no-transform` response-header rules (`bffless/README.md`).

## Checklist

- [ ] every relative `with.path` has a `rules/api/<alias>/<path>/<method>/rule.yaml`
- [ ] every `poll.path` has a `…/<poll.method or get>/` rule
- [ ] every `src:` (island, script, `render: island`) is a file in `dist/`
- [ ] `index.json` is generated by the build, and the lint passes
- [ ] the rule set is attached to `<alias>` **and** `workflow`
- [ ] the forwarding rule's `targetUrl` is the deployed alias URL

## What the tooling does not do yet

- **No cross-check between YAML and rules.** The linter validates the YAML alone; a `path` with
  no matching rule directory is a run-time 404. Tracked as a lint rule: bffless/apps#388.
- **The prefix is typed by hand.** `hello` bakes `api/hello/…` into its rule directories. Spec
  06's `publish-workflow` (M3) will let you author `rules/api/echo/post/…` with no prefix and
  rewrite it per alias at deploy (`--path-prefix`), generate `index.json` and the forwarder,
  and attach the set to both aliases — one action instead of steps 4–5 above.
