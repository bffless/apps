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

- [ ] **Decision 4**: `GET https://workflow.j5s.dev/api/aliases` returns the alias list under a member session (else: build the designed `/api/workflow/aliases` relay rule from Task 1's note).
- [ ] **Decision 8**: upload a kickoff photo → the returned ref's `url` serves the bytes (files-trio `subDir` mapping) — else adjust the serve rule's `subDir`/url minting together.
- [ ] **`project:` input names**: confirm both actions accept `project:` for a non-default project (memory: the two deploy actions have different project fallbacks) — else set repo var scoping.
- [ ] **Rule set isolation**: do **not** add these sets to `.bffless/config.json`'s `ruleSets` globs — that file drives the nightly drift check against project `bffless/apps`; the workflow sets live in `bffless/workflow` (note this in the README).
