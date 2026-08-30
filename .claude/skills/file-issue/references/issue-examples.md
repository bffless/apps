# Real issues, and what triage said about them

Bodies are in `examples/issue-<n>.md` in the draft format `grade.py` reads (`# title`,
body). They are the calibration set for `grade.py` and the concrete targets for the
skill. All were triaged by `apps-triage` against `origin/main` `bd7e005` on 2026-08-30.

## Passed — `ready-for-agent` on first read

| Issue | Shape | Why triage accepted it (its own words) |
| --- | --- | --- |
| #469 | refile, bug, 3 boxes | "the design call was made in the body (**decided**: fail the run), and the source settles the mechanism, the detection condition, the failure cascade and the test to change." Triage also *corrected a path* (`studio.workflow.yaml` lives under `.bffless/workflows/`) — cite from the repo root and run `cite_check.sh`. |
| #471 | refile, enhancement, 3 boxes | "single app, no rule/schema change, three tightly-scoped checkboxes, and every choice the checklist leaves open is settled by a sibling precedent in this same directory." Names the sha it cites; triage: "nothing has moved under it". |
| #472 | refile, bug, 3 boxes | Shortest of the set: provenance, mechanism with the rule file, two outcomes plus "add the test", verify chain. Enough. |
| #421 | found-in-the-wild bug | The long shape: `## What happens` (with the code), `## Why it is still like this` (the stale comment), `## Expected`, `## Suggested fix` mirroring `FinalCutBar`, `## Notes` (no rule change; unrelated to #362). No parent; provenance is "found while checking ce#697". |

## Bounced once, then passed — the decision was the only thing missing

| Issue | First verdict | What unblocked it |
| --- | --- | --- |
| #473 | `ready-for-human` — "the transport for the signal is an undecided design fork (new persisted column vs. pipeline join)". Triage laid out (a)/(b)/(c) with a recommendation and three sub-decisions. | The maintainer answered in one comment ("**(b)** — join at list time … carry a list … inside the Status cell … copy: waiting on <step name>") and re-triage went `ready-for-agent`. Had the body said `**decided**: (b)` plus those three lines, it would have passed first time. |

## Bounced — shape, not detail

| Issue | Verdict | Why |
| --- | --- | --- |
| #460 | `ready-for-human` | "five follow-ups in one issue, one of which is a workflow-contract feature and one of which still has an open design question; it needs splitting". Every citation checked out. Items 1 and 2 became #470 and #471 and passed on sight. Item 5's premise was already retired on `origin/main` — check freshness before filing. |
| #463 | `ready-for-human` | "eight items span six surfaces under one `chore(...)` title", and item 7 turned out to be nine files, not one. Also: the verify chain omitted `typecheck` and `rules:test`, which CI runs — use `app_facts.sh`. |

## The house title shape

`<app>: <symptom or gap> — <what to do> (#parent)` — e.g.
`workflow-studio: useSigned resolves all-or-nothing — sign per sheet (#460)`.
The maintainer marks the parent's item `- [x] → #471 …` once the refile exists (#460).
