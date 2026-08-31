# Workflow harness backend — BFFless proxy rule sets

One authored set: `workflow` (run records, lease, files quartet — spec 05/06). Through M2 this
directory also carried `hello` (the hello test implementation: echo, slow+poll,
fail, analyze). As of M3 Task 7 (Decision 5, "one source") `hello` lives outside this monorepo
— first in `bffless/workflow-hello`, now (M4) as the `hello/` package of
[`bffless/workflow-implementations`](https://github.com/bffless/workflow-implementations): its
rule set, workflow YAMLs, islands and scripts are authored and published from there, via
`bffless/publish-workflow@v1` in that repo's own `deploy-hello.yml` (see
`docs/writing-an-implementation.md`). This monorepo pins the commit it stages for local
dev/CI in `apps/workflow/hello.ref` and no longer owns hello's sources.

## Manual setup (admin panel)

- **Project**: the harness expects its own BFFless project (phase 1: `bffless/workflow` on
  j5s.dev) — discovery lists *this project's* aliases, so co-tenanting with unrelated apps
  only adds harmless 404 probes.
- **Discovery scope** (apps#363): `deploy-workflow.yml` builds the harness with `VITE_BFFLESS_PROJECT:
  bffless/workflow`, baked in at build time — the discovery relay preserves the query string
  (Decision 4), so only that project's aliases are probed and an unrelated co-tenanted app never
  shows up as a foreign 404 probe. Unset (local dev, `?mocks=on`, CI's `workflow-app.yml`) is
  unscoped by design: the relay then answers every alias the calling session can see. Runtime
  self-discovery for a catalog install — reading the installed-into project instead of baking one
  in at build time — is M4, the other half of apps#363.
- **Members need a project role** (found on the M2 live walk, 2026-08-26): CE answers a scoped
  alias list (`?repository=owner/name`) with `{ data: [] }` — not an error — for any non-admin
  who has **no role on that project** (`deployments.service.ts` `listAliases` →
  `getUserProjectRole`), and the harness then reads "No implementations found". Nothing else in
  the harness needs one (every rule is `auth_required` only, and the *unscoped* list has no
  project gate at all — bffless/ce#701), so a member who ran M1 fine can see an empty M2. Grant
  each harness member at least **`viewer`** on the project (admin panel → project → Permissions,
  or `POST /api/projects/<owner>/<name>/permissions/users` `{ userEmail, role: "viewer" }`). The
  scoped build's empty state says so.
- **Aliases + domains**: alias `workflow` (the harness SPA) on `workflow.<domain>`, alias
  `hello` (the test implementation bundle, published by `bffless/workflow-implementations`'s
  own `deploy-hello.yml`) on `hello.<domain>`. Rule set `workflow` is attached to alias
  `workflow` by this repo's deploy; rule set `hello` is attached to BOTH the `hello` alias and
  the `workflow` (harness) alias by `bffless/publish-workflow@v1` running in
  workflow-implementations' own CI (ADR-0001 single origin) — nothing in this repo's deploy
  touches it. The harness domain is
  the manual half: `workflow.<domain>` → alias `workflow`, path `/apps/workflow/dist`, **SPA
  fallback on**, `unauthorizedBehavior: redirect_login` + `requiredRole: authenticated` (a
  signed-out member lands on the login page instead of a 404). An implementation domain is
  **optional** since 2026-08-28 (the forwarder no longer goes through it — see below); j5s
  keeps `hello.<domain>` → alias `hello`, path **`/dist`** for humans who want the bundle
  directly — `bffless/upload-artifact` keeps the uploaded directory name as the bundle's root,
  so `hello`'s deployment root is `dist/` (`dist/index.html`, `dist/islands/*.html`,
  `dist/.bffless/workflows/index.json`, …); a domain path of `/` (or empty) 400s or 404s.
- **Rule-set isolation**: `workflow` lives in project `bffless/workflow`, NOT in
  `.bffless/config.json`'s `ruleSets` globs — that file drives the nightly drift check against
  project `bffless/apps`. Keep them out of it.
- **Mocks**: the MSW mock backend (and its `?as=admin` identity switch) is only ever loaded
  behind `import.meta.env.DEV` — `src/main.tsx` returns before importing `mocks/browser` in any
  other build — so no mock and no identity switch can reach a production build regardless of
  query string or `MOCKS_ENABLED`.
- **Storage**: a default storage backend must be configured (bucket or local ≥ CE 0.3.15) —
  the files trio (presigned PUT → register → serve) is the upload path. **Bucket CORS must
  list the harness origin** (`https://workflow.<domain>`): the presigned PUT goes straight from
  the browser to the bucket, and GCS/S3 answer the preflight with no `Access-Control-Allow-Origin`
  for an unlisted origin, so every browser upload — a kickoff `file` input, a `form` step's file
  field, a `script` step's Blob output, the >256 KB `{"$file"}` offload — fails with
  `the upload PUT failed` and a CORS error in the console. Add the origin per
  [docs › Google Cloud Storage › Step 2](https://docs.bffless.dev/storage/google-cloud-storage#step-2-configure-bucket-cors)
  (`gcloud storage buckets update gs://<bucket> --cors-file=cors.json`; wildcards are not
  supported, list each origin). Seen live 2026-08-25: `j5s-dev` listed `j5s.dev`/`admin.`/
  `studio.` but not `workflow.j5s.dev`, so the first Phase-2 run failed at `card/0/draw`.
- **External connections / AI tokens**: none. **Secrets**: none.
- **Response-header rules**: two, both on project `bffless/workflow`, both created via MCP
  `create_response_header_rule` (a project setting, not part of the rule sets, so every new
  install has to add them by hand until bffless/ce#700 lets rules-as-code carry them):
  - required from M2 Phase 1 — **`**/islands/*.html` → `Cache-Control: no-transform,
    no-cache`** (rule "Islands: no Cloudflare script injection"). Why: see *Islands (M2) →
    Cloudflare* below.
  - required from M2 Phase 2 — **`**/scripts/*.js` → `Cache-Control: no-transform,
    no-cache`**. Worker module text is fetched by the harness and handed to the sandbox
    verbatim — an edge-injected script would break the import; same reason as islands.
    Not yet automatable — bffless/ce#700.

  (COOP/COEP only becomes relevant if a script needs threads — `SharedArrayBuffer`,
  ffmpeg core-mt — which nothing in hello does.)
- The `/w/hello/[...path]` forwarding rule is no longer authored here: `bffless/publish-workflow@v1`
  generates it as part of workflow-implementations' own `deploy-hello.yml`. Since v1.2.0 its `targetUrl` is the
  CE backend's own serve route for the alias, in-process —
  `http://localhost:3000/public/bffless/workflow/alias/hello/dist`, `forwardCookies: true` (the
  member's session is what makes the private alias answer 200 instead of 404). "In-process" is
  literal: a rule with no `authTransform` is never rendered into nginx, so the **backend**
  matches `/w/hello/*` itself (`proxy.service.ts` `buildTargetUrl`) and calls itself at
  `localhost:3000` — the assumption is that it can reach itself there, not that nginx can. So **no
  per-install hostname lives in a rule set**, an implementation domain is optional, and a
  preview alias is browsable at `/w/<alias>/…` — its alias *is* `hello-pr-N` — with nothing set
  up by hand. `target-url` overrides
  it with a public host (legacy), `backend-url` if the backend is not on `localhost:3000`. See
  the ADR-0001 amendment (2026-08-28); CE's `targetUrl: alias://hello` (ce#698) would only be a
  more declarative spelling.
- **Run deletion** (`POST /api/workflow/run/delete`, M2 Phase 3): deletes the run's storage
  prefix `workflows/<impl>/<workflow>/runs/<runId>/` **first** (`file_delete`, idempotent), then
  the `workflow_files` records under it, then the step rows, then the run row — bytes before
  rows, so a retried half-delete never leaves a record pointing at objects that are gone. The
  per-workflow `inputs/` area is **never** touched (D18): kickoff uploads outlive the runs that
  reference them, and Re-run reuses them. Owner (`startedBy == user.id`) or admin only; a run
  still `running` is refused with 409 — cancel it first. Because the refusal statuses are
  literal (`response_handler` will not take an expression for `status`), the rule carries three
  one-line responders (404/409/403), each gated on its own flag from `gate.fn.js`. **Edit this rule
  as rules-as-code only** — it is a multi-branch conditional `response_handler` rule, and saving it
  from the admin panel drops the second conditional responder (bffless/ce#502). Its 200 reports both
  sweeps, `{"deleted":{"files":n,"records":n}}`: `records: 0` beside a non-zero `files` means the
  `workflow_files` filter stopped matching (it deletes nothing rather than failing).

  **If it fails part-way, call it again.** Files-first has a cost worth naming: when `recs`,
  `stepRows` or `row` fails *after* `file_delete` succeeded, the pipeline stops and the run row
  survives with its bytes already gone. That run is not stuck — every step is idempotent, so
  re-POSTing the same `{ id }` resumes: the gate still passes (the row is there, still terminal,
  same owner), `file_delete` answers `{ deleted: 0 }` for a prefix matching nothing rather than
  erroring, and the three deletes run again. The successful retry therefore reports
  `files: 0` — expected on a retry, not a regression. A **persistent** `recs` failure (a missing
  schema, a filter CE rejects) fails every retry at the same step and does leave a run this rule
  cannot delete; that is an operator fix — correct the schema or filter and retry, or drop the row
  from the admin panel. There is deliberately no `dryRun` mode: a preview would be a second code
  path over the same filters, and `records` already reports the sweep after the fact.

  **The `workflow_files` filter is an anchored `sub_dir LIKE 'workflows/<impl>/<wf>/runs/<id>/%'`**
  (apps#381) — tighter than the `storage_path ILIKE '%<prefix>%'` it replaced, because a `%` or `_`
  in an implementation or workflow name can no longer widen the match beyond this run's rows. The
  anchor holds because CE stores `sub_dir` as the key's uploads-relative directory — no leading
  slash, no `<owner>/<repo>/uploads/` head — confirmed by a 2026-08-30 live read of the newest
  rows on this instance (e.g. `workflows/workflow-studio/studio/runs/run_…/blog/0/bundle`), which
  released the hold the earlier `storage_path` pattern was kept under (the 2026-08-26 walk had
  proven it end to end, `records: 3`, while `sub_dir`'s stored shape was unobserved). `storage_path`
  is the FULL object key, so an anchored pattern there would silently match nothing — the
  `records: 0`-beside-non-zero-`files` signature above. Note the live schema has not yet adopted
  the authored snake_case fields (needs the hand `bffless rules push --adopt-fields` per the
  standing sync gap), but filtering on an undeclared column is proven to work here — the
  `storage_path` filter returned `records: 3` while equally undeclared.
- **`GET /api/workflow/whoami`** (M2 Phase 3): `{ id, email, role }` for the calling session —
  the one thing the SPA cannot derive, and what the run header uses to decide whether to offer
  Delete. `no-store`. A caller CE cannot tie to a person (an API key with no user) gets empty
  strings rather than an error, so readers must tolerate them. The body is built by `me.fn.js`
  and rendered with `{{{steps.me}}}`, not spliced into a JSON string in a template: a `"` or a
  `\` in an email or a role would otherwise produce a body no client can parse, and escaping is
  not something a template can do for you.
- **Global roles are `admin | user | member`** (ce `users.dto.ts`), so the `owner` entry in the
  delete gate's admin allow-list is **inert** — CE never hands a pipeline that role. It is kept
  per the M2 plan's wording and pinned by a test, not relied on. The practical consequence:
  **an API-key caller is resolved as `role: user`**, so an admin's key cannot delete another
  member's run (403, the owner-mismatch branch — confirmed in the 2026-08-26 walk below).
  Deleting someone else's run needs an admin's browser session.
- **`POST /api/workflow/files/sign`** (M3 Task 10): `{ path }` → `{ url, expiresIn: 3600 }`, a
  presigned GET for one object. Nothing manual to do — the rule ships with the set and
  `deploy-workflow.yml` deploys it on merge. It exists for the sandboxed island: an
  opaque-origin frame sends no cookie, so `/api/uploads/…` 401s on it and an `<img>`/`<video>`
  can only be pointed at a signed URL the *host* fetched on its behalf (`workflow.sign`, spec
  04/Decision 6). `confine.fn.js` narrows the signable set to the harness prefix (an
  uploads-relative key under `workflows/`, no traversal, and the project prefix comes from
  `deployment.owner`/`deployment.repo`, so an import into any project signs its own objects);
  anything else is a literal-status 400. Like the delete rule this is a **multi-branch
  conditional `response_handler` rule — edit it as rules-as-code only** (bffless/ce#502).
  **Both storage backends presign** — CE's `signed_url` calls the adapter's `getUrl`, and the
  local-FS adapter mints an HMAC-signed `/api/storage/presigned/local?key=…&exp=…&sig=…`
  (`local.adapter.ts`); there is no 501. The local-FS caveat is that this URL is **relative
  unless `PUBLIC_ORIGIN` is set**, and a relative `src` cannot resolve inside an opaque-origin
  `srcdoc` frame — so bucket storage (GCS/S3) needs nothing, and a local-storage install must
  set `PUBLIC_ORIGIN` or island media will not load. j5s.dev is GCS, so it signs absolute live.

- **Headless / unattended runs (M3)**: the harness always runs in a browser, so an unattended
  run is a headless browser on the *same page* — `GET /<impl>/<workflow>/run?auto=1&inputs=<base64url(JSON)>`,
  followed on `window.__workflow` (spec `docs/spec/07-headless.md`). The driver is
  `@bffless/workflow-headless` (`packages/workflow-headless`), and its exit code is the contract
  CI reads: `0` succeeded · `1` the run failed/cancelled · `2` a driver-side fault · `3` the page
  refused the start · `4` the driver timed out · `130` SIGINT after Cancel. Nothing manual to set
  up on the BFFless side — no rule, no key, no domain: a headless run is an ordinary member
  session and leaves an ordinary run row (`headless: true`).
  - **Credentials are the two repo secrets `WORKFLOW_EMAIL` / `WORKFLOW_PASSWORD`** on
    `bffless/apps` — the member `workflow-ci@bffless.app` the M1/M2 live walks used (which needs
    at least `viewer` on the project, per *Members need a project role* above). They are what
    `.github/workflows/workflow-headless-run.yml` passes to the driver. An **API key is not an
    alternative**: it cannot mint a SuperTokens session, and two of the harness's relays forward
    the caller's cookies, so `WORKFLOW_TOKEN` is only ever an extra `X-API-Key` on
    `/api/workflow/*` GETs, never a replacement for the login.
  - **Every interactive step needs a `headless:`** or the run fails fast at it (`HEADLESS_REQUIRED`)
    rather than hanging on a person who is not there. Hello's `interactive` workflow declares both
    shapes — `headless: auto` on the island (it submits itself) and `headless: { mode: skip, … }`
    on the form — and `index.json` marks each workflow `headlessSafe` so the UI can say so before
    a run is attempted.
  - **CI proves the whole chain without a deployment**: `apps/workflow/e2e/headless.spec.ts` spawns
    the built driver against the Playwright dev harness in `--mocks` mode and reads the artifacts
    back off disk. The live half is the dispatch below.

### Islands (M2)

Island HTML is served straight out of the hello bundle at `/w/hello/islands/*.html` (the
same forwarder as the workflow YAMLs) and injected verbatim into a sandboxed
`<iframe sandbox="allow-scripts">` `srcdoc` host — an opaque origin, so no cookies, no
storage, no same-origin fetch (Decision 9); the harness never parses, sanitises or rewrites
the HTML. Tool names between the island and the host are dot-canonical, slash-tolerant
(Decision 1): `workflow.submit`, `workflow.annotate` and `workflow.sign` are the three host
tools every island gets, and pipelines-as-tools are restricted to the implementation's own
`/api/<impl>/` namespace. Hello's surface is still 5/5 (Task 6) — `analyze` is a pipeline, not a rule-set
addition — and the staged bundle now carries `islands/*.html` (`pick-line.html`,
`line-viewer.html`) alongside `index.html` and the two workflow YAMLs.

**Cloudflare.** On a Cloudflare zone with Bot Fight Mode (the Free plan), the edge injects its
JavaScript-Detections `<script>` into **every** `text/html` response — including the island
HTML the harness fetches. Inside the opaque-origin frame that script (it creates a hidden
iframe and reads `contentWindow.document`) throws
`SecurityError: Failed to read a named property 'document' from 'Window'` at
`about:srcdoc:<line>`, once per Cloudflare pass. Until 2026-08-28 the forwarder re-fetched
through the edge, so it fired twice; with the in-process target only the browser's own request
to `workflow.<domain>` crosses the edge (confirm on the next live walk). The island still
works — the error is the injected script's, not ours — but the fix is the response-header rule
above: Cloudflare skips the injection when the origin answers `Cache-Control: no-transform`
([docs](https://developers.cloudflare.com/bots/additional-configurations/javascript-detections/)).
Both rules stay **required** — they match the harness-facing path. Cache rules cannot
express `no-transform` (they only take max-age numbers). Seen and fixed 2026-08-25;
rules-as-code follow-up: bffless/ce#700.

**Trust boundary.** Which bundle an island loads from is the run's `impl`, and on the
read-only run page that value comes from the **run row** — a field any project member can
write when they `POST /api/workflow/runs` (the rule is gated by `auth_required`, nothing
narrower). It picks both the `/w/<impl>/` bundle the viewer's islands load *and* the
`/api/<impl>/` namespace the host proxies their `tools/call` into, under the **viewer's**
session — and since publish-workflow v1.2.0 every implementation and every PR preview
publishes its own forwarder, a planted `impl` would resolve. So the page validates it
(apps#364): the row's `impl` is only trusted once discovery lists it as a real,
**non-preview** alias of this project — a PR preview's bundle is never a legitimate target
for a finished run's islands. While discovery is still answering, or if the alias is
unknown, a preview, or discovery fails, the islands are withheld: each value renders its
ordinary non-island viewer plus a one-line `island withheld: unknown implementation` note,
and nothing mounts. The live run path needs no check — its `impl` comes from the
`run.started` event the same tab dispatched, not from a fetched row. Taking `impl` from the
route instead was rejected: a crafted link makes the route param equally attacker-supplied,
and D16 deliberately lets a deep link open a run of an implementation the route does not
name.

### Scripts (M2 Phase 2)

A `script` step's module is served straight out of the hello bundle at
`/w/hello/scripts/<file>.js` (the same forwarder as the islands and the workflow YAMLs). The
**page** fetches it — the bundle is behind the member's session — and hands the text to a
hidden `sandbox="allow-scripts"` iframe, which spawns the Worker from two `data:` URLs (the
module and the shim). The Worker therefore runs on an **opaque origin**: the module is
imported verbatim, it has no cookies of its own, a `fetch` of its own has no origin to reach
the harness with, and it reaches the network only through the host's relay (03). The page
still does the fetching, so the `**/scripts/*.js` `no-transform` header rule above is still
required. Scripts are copied into the bundle
**verbatim** by `scripts/stage-hello.mjs` (no build step, unlike islands) and listed in
`index.json`'s `scripts` array; hello's first one is `scripts/poster-card.js`, the `card` job
of `interactive.workflow.yaml`.

**Oversized outputs.** An output whose JSON exceeds 256 KB is not stored in the row: the
runner uploads it as `<name>.json` under the step's own `runs/<runId>/<job>/<index>/<step>/`
prefix (the files trio, 06) and the row holds `{ "$file": <File ref> }` in its place. `register`
accepts either kind of `storageKey` a caller may have — the full key `prepare` mints, or the
bare uploads-relative path a pipeline step's own `outputs.<name>.value` can return per spec
02 — prefixing the latter itself, since CE's `register_upload` only accepts a full key. Every
read path hydrates it back before the page sees it, so nothing downstream — renderers,
expressions — knows the difference. The bytes therefore live under the run prefix and go with
the run when it is deleted.

## First-success checkpoint

Open `workflow.<domain>`, sign in as a project member: the Implementations screen lists
**hello**. Open *Hello workflow* → Start a run with the defaults → the run page shows
`greet` fan out, `slow` poll to done, `flaky` fail-then-recover, submit the confirm form →
run status **succeeded** with `report`, `poster`, `lines` under Outputs.

## Live verification checklist

Walked 2026-08-24 against j5s.dev (deploy runs 32754093965 → 32756238525 on
`fix/workflow-ruleset-yaml`). Each item is a Decision that assumed something:

- [x] **Decision 4 — DISPROVED, fallback built.** `GET workflow.j5s.dev/api/aliases` falls
  through to the SPA's `index.html` (the harness host has no CE alias API of its own), so the
  designed relay `rules/api/workflow/aliases/get/rule.yaml` (forwarding rule →
  `http://localhost:3000/api/aliases`, `forwardCookies`) is now the discovery call. The
  query string is preserved, so `?repository=owner/name` scopes it; without it CE answers
  every alias the member can see. CE's `SessionAuthGuard` answers the anonymous 401. The
  `/w/hello/[...path]` forwarder needed `forwardCookies: true` too — without it the private
  hello alias 404s every `index.json` probe.
- [x] **Decision 8 — DISPROVED as authored, fixed.** Two faults: CE's `file_serve_handler`
  derives the object only from a `/api/uploads/<subDir>/` request path (the
  `/api/workflow/files/[...path]` route answered 500 "No file path specified"), and
  `shape.fn.js` read fields `register_upload` never emits (the ref came back as
  `{ path: '', url: '/api/workflow/files/' }`). The serve rule now lives at
  `/api/uploads/workflows/[...path]` — also the `publicPath` `presigned_upload` mints — and
  the ref's `url` is that path. Verified: prepare → PUT → register → GET serves the exact
  bytes, `Range` → 206. `?download=1` got no `Content-Disposition` because CE's
  `file_serve_handler` had no attachment support; the serve rule now carries
  `download: request.query.download` (apps#362), which turns that on once
  [bffless/ce#714](https://github.com/bffless/ce/pull/714) merges and j5s.dev redeploys. Until
  then the key is inert — CE ignores unknown handler config keys — so files still open inline
  and the live walk below is unchanged.
- [x] **`project:` input names — DISPROVED for upload-artifact.** `bffless/upload-artifact@v1`
  has no `project:` input (it logs "Unexpected input(s)" and falls back to the calling repo —
  the deploy was refused with "rule set workflow not found for this project", which is the
  guard working). It takes `repository: bffless/workflow`; `bffless/deploy-proxy-rules@v1`
  takes `project:`. The workflow uses each action's own name.
- [x] **Rule-set isolation** — the sets are not in `.bffless/config.json` (see Manual setup).
- [x] **`ruleset.yaml` descriptions are quoted** — an unquoted `Spec: …` inside a plain scalar
  is a nested mapping to the YAML parser; `bffless rules validate <dir>` catches it locally.
- [x] **The hello bundle is dot-only.** `upload-artifact` < 1.4.2 skipped every dot-entry it
  walked, so `path: apps/workflow/hello-dist` uploaded zero files, and CE < 0.4.33 stripped
  nested `.bffless/` from zip uploads. Both fixed upstream (upload-artifact#21 → v1.4.2,
  ce#699 → v0.4.33; apps#361); the deploy uses the plain `path:` again. CE serves
  `/.bffless/workflows/*` fine once the files exist.
- [x] **`data_query` answers a bare array.** Every rule's `rows()` helper expected a
  `{ records | data | rows }` envelope, so `find` never matched: `run-step` always took the
  create branch with a partial patch (400 "job is required"), and `lease`/`run` said "run
  not found". CE's `data-query.handler.ts` returns `results` (or `results[0]` with
  `returnSingle`) directly — the helpers now accept the array.
- [x] **First-success checkpoint — PASSED 2026-08-24** as member `workflow-ci@bffless.app`
  (`localdev-tools/workflow-live.mjs`, run `run_01M0TKB4MDDDD22FX3WJMVFDWA`): hello listed →
  run with defaults → greet / slow poll / flaky fail-then-recover → Finish → **Succeeded** with
  `report`, `poster`, `lines` and the TEAPOT annotation. (Creating that member first needed
  the SuperTokens pre-flight DDL on j5s — bffless/ce#695.)
- [x] **M2 Phase 1 — interactive hello runs on `workflow.j5s.dev`** — walked 2026-08-25 after
  the #368 deploy: island loads in the sandboxed srcdoc host, `echo` tool call shouts the line,
  `workflow.annotate` shows as a step notice, "Submit nothing" is rejected with the step still
  `waiting`, submit finishes the run, the `render: island` viewer renders the picked line
  (Decision 9 holds live). **One finding:** five
  `SecurityError … Blocked a frame with origin "null"` console errors from `about:srcdoc` —
  Cloudflare's injected JS-detection script, not the island (see *Islands (M2) → Cloudflare*);
  fixed with the `no-transform` response-header rule, verified through both hops with a
  member session (zero `challenge-platform` scripts, bytes identical to the local build).
  Also confirmed: `hello.<domain>/` now serves the landing `index.html` (M1 minor closed).

**M2 Phase 3 — walked 2026-08-26** against the #378 deploy (run 32957995835) as member
`workflow-ci@bffless.app` with `localdev-tools/workflow-live.mjs --interactive` (mirrors
`e2e/interactive.spec.ts` in the real browser, plus the API-level probes CI cannot make); run
`run_01M0YV4G7JH6VF5C5ZQ1R6P7PH`, 27/27 checks. Console: only the two anonymous 401s on
`admin.j5s.dev` before sign-in — zero `SecurityError`s, so both `no-transform` rules hold.

- [x] **M2 Phase 3 — Decision 7 (run delete) — PASSED.** Owner delete answered
  `{"ok":true,"deleted":{"files":3,"records":3}}`: three objects under
  `runs/<id>/card/0/draw/` (two `<uuid>-poster.svg`, one `<uuid>-big.json`, exactly what the
  files trio registered) and three `workflow_files` rows — the `storage_path ILIKE '%<prefix>%'`
  sweep matches. `GET /api/workflow/run?id=` → `{ run: null, steps: [] }`; both poster URLs 200
  before → 404 after; the mid-run `inputs/<uuid>-extra.png` 200 before **and after**. Refusal
  matrix: `POST run/delete` while the run sat at the island step → **409** `cancel the run
  first`; an admin's **API key** on the finished run → **403** `only the run owner or an admin
  can delete a run` (the key resolves to `{ id: <that user>, role: user }`, so this is the
  owner-mismatch branch). Another *member session* deleting a foreign run was not exercised —
  there is one member account; it is the same branch.
- [x] **M2 Phase 3 — Decision 8 (scoped discovery) — PASSED, one precondition DISPROVED.**
  Network log: exactly one `GET /api/workflow/aliases?repository=bffless%2Fworkflow`, then only
  `/w/workflow/.bffless/workflows/index.json` (the harness's own alias — SPA fallback answers
  200 HTML, no bundle) and `/w/hello/…/index.json`; no foreign alias probed. **But** the first
  walk showed "No implementations found": the scoped list needs a *project role* and
  `workflow-ci` had none (see Manual setup → *Members need a project role*; CE side
  bffless/ce#701). Fixed by granting `viewer`; the empty state now names the project and the
  cause when the build is scoped.
- [x] **M2 Phase 3 — Decision 14 (form step, mid-run upload) — PASSED.** The `extra` upload
  registered as `workflows/hello/interactive/inputs/<uuid>-extra.png` (scope `inputs`, served
  200, untouched by the delete); the tile picker showed one tile and the picked value was the
  poster's path; the markdown preview rendered `## Notes` as an `h2`; `Previewed Hello, world!`
  landed in Annotations. `cover` rendered as the PATH chip
  (`workflows/hello/interactive/runs/<id>/card/0/draw/<uuid>-poster.svg`, no Download) — Ruling
  P5 holds, no surprise; the M3 follow-up stays in #382.
- [x] **M2 Phase 3 — renderers — PASSED.** `transcript`, `chart` (one `<canvas>`), `code`
  (hljs spans), `images` (one `<img>`) all rendered; `posters` uploaded the bytes a second time
  — **two** distinct `<uuid>-poster.svg` objects (CE's uuid key strategy), both served, both
  404 after delete. Script side: `script-log` shows "drawing", the `card/0/draw` row holds `big`
  as `{"$file": …/<uuid>-big.json}` (636 891 bytes) and the page hydrates it (`[12000]`).
- [x] **M2 Phase 3 — whoami — PASSED.** Session → `{ id: 25464c18…, email:
  workflow-ci@bffless.app, role: user }`, `Cache-Control: no-store`, and `role` equals
  `users.role` from `GET /api/users/:id` — the global role. API key → `{ id: <key's user>,
  email: "", role: user }`, and that admin's key could not delete the member's run (403).
  Observed aside: `workflow-ci` read `member` (MCP `list_users`, 10:37) before the admin-UI
  project grant and `user` after it (`updatedAt` 10:49:17) — CE promotes on grant (noted in
  ce#701); either way the pipeline's `user.role` matched the record.
- [ ] **M2 Phase 3 — apps#362 `?download=1` — fix authored, awaiting a CE deploy.** Observed
  2026-08-26: `GET …-poster.svg?download=1` → 200 `image/svg+xml` with **no**
  `Content-Disposition` (none without the query either). The serve rule now sets
  `download: request.query.download`, and the CE side is
  [bffless/ce#714](https://github.com/bffless/ce/pull/714) (closes bffless/ce#697) — open, not
  deployed. Re-walk once it is: expect `Content-Disposition: attachment;
  filename="<original_name>"` on `?download=1`, nothing on a plain GET, and `Range` → 206
  unchanged.
- [ ] **M2 Phase 3 — Annotations column.** Shows real counts for the new (M2) run and an em dash
  `—` for pre-M2 rows that predate `annotationCounts`.

### M3 — sandbox and `workflow.sign`

- [x] **M3 Phase 3a — `workflow.sign` and the sandboxed Worker — PASSED 2026-08-28.** After
  apps#408, runs `run_01M13ZRAKGPBDDJBK4YM1EXVQB` (hello) and
  `run_01M13ZRZTNJQ7QH9KEJ478S7HR` (interactive) on `workflow.j5s.dev` both succeeded, the
  `card` job's poster script having run inside the sandbox frame. On the interactive run the
  `poster_view` viewer's `<img src>` was a `storage.googleapis.com` presigned URL
  (`X-Goog-Expires=3600`) that decoded 640×360 and fetched **credential-less**;
  `island-sign-error` was empty. So the sign rule (`order: 19`), `confine.fn.js` and the
  opaque-origin `<img>` path all hold live on bucket storage. A **local-FS** install would need
  `PUBLIC_ORIGIN` set — its presigned URL is relative — and that is still unproven live.

### M3 — headless

Walked 2026-08-30 with `pnpm workflow-live:walk headless --dispatch` (`packages/workflow-live`,
apps#359 Task 25). Each row names the walk's check ids.

- [x] **M3 Task 15 — the dispatch runs live — PASSED 2026-08-30.** Actions run
  [33316611080](https://github.com/bffless/apps/actions/runs/33316611080) →
  `run_01M19GSRMQPBAVMABH66TEAJ2K` **succeeded**, `run.headless: true`, `pick/0/choose → succeeded`
  (the island's own submit under `hostContext.bffless.headless`), `review/0/confirm → skipped` with
  `outputs.cover` a File ref, `outputs/poster.svg` in the `workflow-run-output` artifact. The same
  through the local driver: `run_01M19GP5MADDENBFZSBCG4NZPD`, exit 0 in ~40 s. Negative: an
  `inputs` of `{ "greeting": 42 }` → exit 3 and no run row. 15/15: `driver.exit0`, `run.succeeded`,
  `run.headlessFlag`, `D7.islandSelfSubmitted`, `D11.reviewSkippedWithOutputs`, `run.posterIsFileRef`,
  `driver.savedPoster`, `driver.wrongTypeIsExit3`, `dispatch.jobGreen`, the same five under
  `dispatch.`, `dispatch.savedPoster`.
- [x] **M3 Task 15 — the mock-only download caveat does not bite live — PASSED 2026-08-30.** Proven by
  the Studio headless run `run_01M19GV5DDXBB3QHFN8BHH7896` (see
  `workflow-studio/bffless/README.md`, now in `bffless/workflow-implementations`): the driver uploaded the 3.6 MB fixture clip as the
  `recordings` **file input** and every downstream step from `per-video/0/audio` on read its bytes from
  the bucket.

### M3 — Task 25: hello via `bffless/workflow-hello` (2026-08-30)

Walked with `pnpm workflow-live:walk hello` — run `run_01M19H571QZMC4FV40C978CKY7` on
`workflow.j5s.dev` as `workflow-ci`:

- [x] **Decision 5 — hello is discovered through the generated forwarder.** `200 GET
  /w/hello/.bffless/workflows/index.json` and the run URL is `/hello/interactive/…`
  (`D5.helloDiscoveredViaForwarder`, `D5.implIsHello`). Found on the first pass: while
  bffless/workflow-hello#5 is open the Implementations list shows the `hello-pr-5` preview *above*
  `hello`, so a walk must pick the implementation by exact alias — the walks now do.
- [x] **Decision 6 — the viewer draws a presigned image, credential-less.** `poster_view`'s
  `<img src>` is `https://storage.googleapis.com/j5s-dev/…/poster.svg?X-Goog-…`, decoded 640 px
  wide; `island-sign-error` (a testid *inside* the island's iframe, not the harness's) is empty
  (`D6.viewerImgIsPresigned`, `D6.noSignError`).
- [ ] **Decision 4 — the script ran in a sandboxed Worker.** `D4.scriptSandboxed` reads
  `origin=null` off the `card/0/draw` script log; that log line ships in bffless/workflow-hello#5
  (open at walk time — the `hello-pr-5` preview already carries it, the `hello` alias does not).
  Re-run `walk hello` after #5 merges and deploys.
- [x] **No console errors after login** (`page.noConsoleErrors`). The two pre-login SuperTokens 401s
  on `admin.j5s.dev/api/auth/session[/refresh]` are the relay's normal path; the session counts
  errors only after the relay login (they stay in `network.log`).

### M4 Phase 1 — the move was deploy-neutral (2026-08-31)

The implementations left this monorepo for
[`bffless/workflow-implementations`](https://github.com/bffless/workflow-implementations)
(M4 plan Phase 1: `hello` from `bffless/workflow-hello`, now archived; `workflow-studio` from
`apps/workflow-studio`, removed here in apps#541). Decision 9's proof obligation — the move
changes the publishing repo only, never an alias, rule-set name, `/api/<impl>/…` or
`/w/<impl>/…` prefix — held on the live instance:

- [x] **`walk interactive` — 27/27** (`packages/workflow-live`, via `apps-live-walk`).
- [x] **`walk hello` — 7/7** — hello discovered and run from its new publisher.
- [x] **`walk studio-audit` — 7/7** — workflow-studio's rule set serving unchanged.
- [x] **`walk headless --dispatch` — 16/16** (post-#542 — the run record seals before the
  browser closes, so the sealed-row checks count too).
- [x] **`bffless rules diff hello --project bffless/workflow` — no drift** after Task 2's
  cutover deploy from the new repo.
- [x] **`bffless rules diff workflow-studio --project bffless/workflow` — no drift** after
  Task 3's cutover deploy from the new repo.

### M4 Phase 2 — the #363 probe: `deployment.*` names the serving project (2026-08-31)

Decision 6's fork ("probed before designed") resolved on the live instance. A **temporary**
pipeline rule on the live `workflow` alias (created and deleted 2026-08-31; alias restored)
ran a `function_handler` that echoed its context root. Its exact output, verbatim:

```json
{"keys":["user","request","steps","deployment","utils"],"deployment":{"owner":"bffless","repo":"workflow","commitSha":"55a8cbaf6c57a1185fb18691c0c2c33e5e3a13cd","alias":"workflow"},"userRole":"user"}
```

So `deployment.owner`/`deployment.repo` name the **serving BFFless project**
(`bffless/workflow`) — not the git repository the bundle was built from (`bffless/apps`,
whose deploy commit is what `commitSha` echoes) — and `deployment.alias` is available too.
Option (a) of Decision 6 holds; **no CE issue needed**. `GET /api/workflow/project`
(`order: 25`, `auth_required` + `allowApiKey`, `Cache-Control: no-store`) answers
`{"repository":"<owner>/<repo>"}` (or `{"repository":null}` when provenance is absent) from
exactly this root. Like every rule in this set it goes live on merge — there is no PR
preview deploy for the harness.
