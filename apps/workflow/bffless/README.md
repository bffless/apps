# Workflow harness backend — BFFless proxy rule sets

Two authored sets: `workflow` (run records, lease, files trio — spec 05/06) and, from M1
Phase 3, `hello` (the workflow-hello test implementation: echo, slow+poll, fail, and — from
M2 Task 6 — analyze; 5/5 hello surface rules).

## Manual setup (admin panel)

- **Project**: the harness expects its own BFFless project (phase 1: `bffless/workflow` on
  j5s.dev) — discovery lists *this project's* aliases, so co-tenanting with unrelated apps
  only adds harmless 404 probes.
- **Aliases + domains**: alias `workflow` (the harness SPA) on `workflow.<domain>`, alias
  `hello` (the test implementation bundle) on `hello.<domain>`. Attach rule set `workflow`
  to alias `workflow`; attach rule set `hello` to BOTH aliases (ADR-0001 single origin).
  The deploy workflow creates both aliases (and attaches the sets) on its first run — the
  domains are the manual half: `workflow.<domain>` → alias `workflow`, path
  `/apps/workflow/dist`, **SPA fallback on**, `unauthorizedBehavior: redirect_login` +
  `requiredRole: authenticated` (a signed-out member lands on the login page instead of a
  404); `hello.<domain>` → alias `hello`, path `/apps/workflow/hello-dist`, no SPA fallback.
- **Rule-set isolation**: these two sets live in project `bffless/workflow`, NOT in
  `.bffless/config.json`'s `ruleSets` globs — that file drives the nightly drift check against
  project `bffless/apps`. Keep them out of it.
- **Storage**: a default storage backend must be configured (bucket or local ≥ CE 0.3.15) —
  the files trio (presigned PUT → register → serve) is the upload path.
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
- The `/w/hello/[...path]` forwarding rule bakes `targetUrl: https://hello.j5s.dev` — edit it
  for a different install domain (CE follow-up `targetUrl: alias://hello` removes this).
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
