# workflow-hello

The `hello` implementation for the BFFless Workflow harness. Trimmed excerpt
for the workflow-cli rename-engine fixture (test/rewrite.test.ts) — see
`bffless/workflow-implementations` `workflows/hello/README.md` for the real
thing.

`preview.yml` (pull requests): publishes a per-PR alias (`hello-pr-<N>`) on
open/sync/reopen and tears it down when the PR closes — for example
`hello-pr-1` for the very first open PR.

Decoys planted for the rename engine's tests: this implementation is not
`othello`, and it definitely isn't `shellhello` either.
