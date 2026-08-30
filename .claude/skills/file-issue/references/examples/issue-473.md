# workflow: surface waiting steps on the Past runs list (#461)

Refiled from #461; **decided**: the Past runs surface (not a new run-level state). An interactive `form` step with no `timeout-minutes` waits forever, so a run whose upstream failed sits in `running` while any downstream job still runs. `waiting` is already a step status.

- [ ] On the Past runs list, for a `running` run that has a step in `waiting`, show "waiting on <step name>" beside the status.
- [ ] Link it to that step on the run page.
- [ ] Test with a run fixture containing one waiting form step.

Verify: `pnpm workflow:lint && pnpm workflow:test && pnpm workflow:build`.

