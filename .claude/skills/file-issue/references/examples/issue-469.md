# workflow-studio: an all-silent run succeeds with empty outputs — fail it with an annotation (#459)

Refiled from #459 item 7; **decided**: fail the run. When no recording has spoken audio, every `sheets` leg is `if:`-skipped (`apps/workflow-studio/studio.workflow.yaml:106`, `if: ${{ length(matrix.plan.times) > 0 }}`), the `director` job at `:119` has no guard and runs on empty inputs, everything after it skips, and the run finishes **`succeeded`** with empty outputs.

- [ ] In the `plan` job, detect "no spoken audio in any recording" and write a run-level annotation saying exactly that.
- [ ] Fail the run there (the plan step exits non-zero / sets an error output) so `director` and later jobs never start and the run shows `failed` with the annotation as the reason.
- [ ] Test: a plan fixture with zero times across all sources → run fails with the annotation; existing partial-silent fixtures unchanged.

Verify: `pnpm workflow-studio:lint && pnpm workflow-studio:stage && pnpm workflow-studio:build && pnpm workflow-studio:test` plus `workflow-lint` on the spec (`pnpm workflow-lint:build && pnpm workflow-lint:test`).

