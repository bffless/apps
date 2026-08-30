# Evals for the `file-issue` skill

Nothing here runs automatically. These files make a manual test pass repeatable
when the skill changes. (Per-artefact quality control is SKILL.md step 5, which
reuses `grade.py`, `rubric.md` and `../scripts/cite_check.sh` on every draft; this
directory is regression testing for the skill itself.)

## What's here

- `evals.json` — frozen test prompt(s) + expected output + assertion names.
- `grade.py` — scripted checks on a draft (`--json` emits a grading.json body).
  Calibrate it on `../references/examples/*.md` after changing a check: the five
  agent-ready issues should keep scoring above the two bounced ones.
- `rubric.md` — judged checks; a *fresh* agent grades them playing `apps-triage`.
- `results/` — one folder per iteration. Gitignored on **both** sides
  (`.claude/skills/*/evals/results/` and `.agents/skills/*/evals/results/`) because
  `pnpm skills:sync` mirrors this whole directory byte-for-byte into `.agents/skills/`
  and `skills:check` fails CI on any drift.

## Running a pass (ask Claude Code: "re-run the file-issue evals")

1. Snapshot the current skill if comparing old vs new (`cp -r <skill> <ws>/skill-snapshot`).
2. Spawn agents in isolated worktrees, same prompt, with-skill and baseline. The
   prompt says "draft only" — no `gh` writes, no commits. Copy each draft to
   `results/iteration-N/eval-K/<config>/run-1/outputs/issue-draft.md`.
3. `python3 grade.py <draft> --json > grading.json`; run `cite_check.sh`; append rubric
   verdicts from a fresh agent; write `timing.json` from the task notification.
4. Aggregate + static viewer via the skill-creator plugin (see create-skill SKILL.md §6).
5. Iterate; note the outcome in `MEMORY.md`.

After editing anything under this skill: `pnpm skills:sync` and commit the
`.agents/skills/file-issue/` mirror with it, or `skills-parity.yml` fails.

## Iterations

- 2026-08-30 iteration 1: with-skill 27/27 (scripted 18 + rubric 9), baseline 22/27. `results/iteration-1/review.html` (local only).
