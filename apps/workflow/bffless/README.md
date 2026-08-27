# Workflow harness backend — BFFless proxy rule sets

One authored set: `workflow` (run records, lease, files trio — spec 05/06). Through M2 this
directory also carried `hello` (the workflow-hello test implementation: echo, slow+poll,
fail, analyze). As of M3 Task 7 (Decision 5, "one source") `hello` lives in its own repo,
[`bffless/workflow-hello`](https://github.com/bffless/workflow-hello): its rule set, workflow
YAMLs, islands and scripts are authored and published from there, via
`bffless/publish-workflow@v1` in that repo's own `deploy.yml` (see
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
  `hello` (the test implementation bundle, published by `bffless/workflow-hello`'s own
  `deploy.yml`) on `hello.<domain>`. Rule set `workflow` is attached to alias `workflow` by
  this repo's deploy; rule set `hello` is attached to BOTH the `hello` alias and the
  `workflow` (harness) alias by `bffless/publish-workflow@v1` running in workflow-hello's own
  CI (ADR-0001 single origin) — nothing in this repo's deploy touches it. The domains are the
  manual half: `workflow.<domain>` → alias `workflow`, path `/apps/workflow/dist`, **SPA
  fallback on**, `unauthorizedBehavior: redirect_login` + `requiredRole: authenticated` (a
  signed-out member lands on the login page instead of a 404); `hello.<domain>` → alias
  `hello`, path **`/dist`** — `bffless/upload-artifact` keeps the uploaded directory name as
  the bundle's root, so `hello`'s deployment root is `dist/` (`dist/index.html`,
  `dist/islands/*.html`, `dist/.bffless/workflows/index.json`, …); a domain path of `/` (or
  empty) 400s or 404s.
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
    no-cache`**. Worker module text is fetched by the harness and turned into a Blob URL
    verbatim — an edge-injected script would break the import; same reason as islands.
    Not yet automatable — bffless/ce#700.

  (COOP/COEP only becomes relevant if a script needs threads — `SharedArrayBuffer`,
  ffmpeg core-mt — which nothing in hello does.)
- The `/w/hello/[...path]` forwarding rule is no longer authored here: `bffless/publish-workflow@v1`
  generates it (`targetUrl` = the deployed `hello` alias URL) as part of workflow-hello's own
  `deploy.yml`. A different install domain follows from `target-url` in that action's inputs,
  not from anything in this repo (CE follow-up `targetUrl: alias://hello` would remove even that).
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
- **`GET /api/workflow/whoami`** (M2 Phase 3): `{ id, email, role }` for the calling session —
  the one thing the SPA cannot derive, and what the run header uses to decide whether to offer
  Delete. `no-store`. A caller CE cannot tie to a person (an API key with no user) gets empty
  strings rather than an error, so readers must tolerate them.

### Islands (M2)

Island HTML is served straight out of the hello bundle at `/w/hello/islands/*.html` (the
same forwarder as the workflow YAMLs) and injected verbatim into a sandboxed
`<iframe sandbox="allow-scripts">` `srcdoc` host — an opaque origin, so no cookies, no
storage, no same-origin fetch (Decision 9); the harness never parses, sanitises or rewrites
the HTML. Tool names between the island and the host are dot-canonical, slash-tolerant
(Decision 1): `workflow.submit` and `workflow.annotate` are the two host tools every island
gets, and pipelines-as-tools are restricted to the implementation's own `/api/<impl>/`
namespace. Hello's surface is still 5/5 (Task 6) — `analyze` is a pipeline, not a rule-set
addition — and the staged bundle now carries `islands/*.html` (`pick-line.html`,
`line-viewer.html`) alongside `index.html` and the two workflow YAMLs.

**Cloudflare.** On a Cloudflare zone with Bot Fight Mode (the Free plan), the edge injects its
JavaScript-Detections `<script>` into **every** `text/html` response — including the island
HTML the harness fetches. Inside the opaque-origin frame that script (it creates a hidden
iframe and reads `contentWindow.document`) throws
`SecurityError: Failed to read a named property 'document' from 'Window'` at
`about:srcdoc:<line>`, once per proxy hop (the `/w/hello` forwarder re-fetches through the
edge, so twice). The island still works — the error is the injected script's, not ours — but
the fix is the response-header rule above: Cloudflare skips the injection when the origin
answers `Cache-Control: no-transform`
([docs](https://developers.cloudflare.com/bots/additional-configurations/javascript-detections/)),
and the forwarder passes the header through so both hops come back clean. Cache rules cannot
express `no-transform` (they only take max-age numbers). Seen and fixed 2026-08-25;
rules-as-code follow-up: bffless/ce#700.

**Trust boundary.** Which bundle an island loads from is the run's `impl`, and on the
read-only run page that value comes from the **run row** — a field any project member can
write when they `POST /api/workflow/runs` (the rule is gated by `auth_required`, nothing
narrower). That is safe today only because `/w/` forwards to exactly one fixed alias
(`/w/hello`), so a planted `impl` resolves to nothing else. Before `targetUrl: alias://`
generalises the forwarder (apps#364 / ce#698, M4), `run.impl` must be validated against the
discovered aliases — or taken from the route rather than the row — or a member-planted run
row could point another member's viewer at a foreign bundle while the host proxies its
`tools/call` under the viewer's own session.

### Scripts (M2 Phase 2)

A `script` step's module is served straight out of the hello bundle at
`/w/hello/scripts/<file>.js` (the same forwarder as the islands and the workflow YAMLs). The
**page** fetches it — the bundle is behind the member's session — and hands the text to a
Worker as a Blob URL, so the module is imported verbatim; it has no cookies of its own and
reaches the network only through the host's relay (03). Scripts are copied into the bundle
**verbatim** by `scripts/stage-hello.mjs` (no build step, unlike islands) and listed in
`index.json`'s `scripts` array; hello's first one is `scripts/poster-card.js`, the `card` job
of `interactive.workflow.yaml`.

**Oversized outputs.** An output whose JSON exceeds 256 KB is not stored in the row: the
runner uploads it as `<name>.json` under the step's own `runs/<runId>/<job>/<index>/<step>/`
prefix (the files trio, 06) and the row holds `{ "$file": <File ref> }` in its place. Every
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
  bytes, `Range` → 206. Still open: `?download=1` gets no `Content-Disposition`
  (`file_serve_handler` has no attachment support — CE follow-up).
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
- [x] **M2 Phase 3 — apps#362 `?download=1` — observed 2026-08-26.** `GET …-poster.svg?download=1`
  → 200 `image/svg+xml` with **no** `Content-Disposition` (none without the query either);
  bffless/ce#697 still open.
- [ ] **M2 Phase 3 — Annotations column.** Shows real counts for the new (M2) run and an em dash
  `—` for pre-M2 rows that predate `annotationCounts`.
