# Workflow harness backend — BFFless proxy rule sets

Two authored sets: `workflow` (run records, lease, files trio — spec 05/06) and, from M1
Phase 3, `hello` (the workflow-hello test implementation: echo, slow+poll, fail).

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
- **Response-header rules**: none in M1 (COOP/COEP only becomes relevant with M2 scripts).
- The `/w/hello/[...path]` forwarding rule bakes `targetUrl: https://hello.j5s.dev` — edit it
  for a different install domain (CE follow-up `targetUrl: alias://hello` removes this).

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
- [x] **The hello bundle is dot-only.** `upload-artifact` skips every dot-entry it walks, so
  `path: apps/workflow/hello-dist` uploads zero files. The workflow roots the walk inside
  `hello-dist/.bffless` with `base-path: /apps/workflow/hello-dist`; CE serves
  `/.bffless/workflows/*` fine once the files exist. Presigned uploads only — CE's zip
  fallback strips nested `.bffless/` (`deployments.service.ts` `isHiddenFile`).
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
