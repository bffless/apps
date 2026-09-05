# file-issue skill — memory

Lessons about *improving this skill*, not instructions for running it (those live in
SKILL.md). Append a dated entry whenever a run, an eval, or user feedback teaches
something. Two or three sentences per day; fold a lesson into SKILL.md once it is
settled and delete it here.

## 2026-08-30

- Built from the diff between the refiles that passed triage on sight (#469, #471,
  #472, #473 after one answer) and the parents that bounced (#460, #463). The rule set
  is triage's own Step 2/3 list turned around; if `apps-triage.md` changes, re-read it
  and re-derive.
- `grade.py` calibration (18 checks): #471 18/18; #469 17; #421, #472, #473 15; #460 16;
  #463 15. Raw score does not separate pass from bounce — *which* check fails does:
  #463 fails ` and ` in title + 8 boxes, #460 fails done-items, #473 fails both
  citation checks. Read the failing check names, not the count. First pass had
  a false positive on #421 ("blocked on ce#697" in a Notes line about a *different*
  issue) — the block check now reads only the title and opening paragraph.
- `cite_check.sh` on #469 reports the same wrong path triage corrected
  (`studio.workflow.yaml` lives under `.bffless/workflows/`); on #471 the paths resolve
  but the printed lines have drifted since merge — that drift is why the sha line exists.

- Iteration 1, eval 0 (refile #463 item 4, decision given): with-skill 18/18 scripted,
  21/21 citations, rubric 9/9, zero open questions, judged `ready-for-agent`
  (157k tokens, 17 min, 2 fresh-grader rounds). Baseline 14/18 + rubric 8/9
  (105k, 6 min): all citations resolved and it found the triage docs itself, but it
  wrote a 9.5k-char design spec with no checkboxes or Verify line, and the judge
  called its scope ~3x the with-skill draft's. So the skill's value here is *shape and
  restraint*, not citations — a capable agent cites on its own. Watch whether the
  skill's step-4 "Design" prose invites the same spec creep on larger issues.
- `cite_check.sh` flagged a real ambiguity in the with-skill draft: a bare `:224` after a
  `build.test.ts` mention that meant `stage.mjs`. Keep the shorthand resolver strict
  (last path wins) — the SHORT it prints is the reader's confusion made visible.
- The with-skill agent reported sandbox friction (worktree guard refusing `for` loops
  over `git show` and heredoc writes) — environment, not skill; nothing to encode.

## Open questions

- Only one eval prompt (a refile). A "bug found in the wild, no parent" prompt and a
  "fork the source can't settle" prompt (expected: one batched question, not a guess)
  would test distinct behaviours; add them when there is a real case to freeze.
- Whether the user wants the parent's `- [x] → #N` tick done by the skill (house
  pattern, #460) or by hand — currently in step 6 behind the same confirmation.

## 2026-08-30 (later) — splitting #496 into #504–#507

- Four refiles from one 25-item parent, all `ready-for-agent` on first triage read with
  zero questions. Two fresh-grader rounds each; round 1 caught a **false premise inherited
  from the parent** (#496 said a red dispatch job has no artifact; `workflow-headless-run.yml`
  uploads with `if: always()`), a decided command that does not work (`gh run list -u @me`
  returns `[]` on gh 2.95 — resolve the login first), and a "delete the class" clause that
  broke the package's own re-export. Lesson for step 1: a parent's bullets are claims, not
  citations — verify the *mechanism* against the tree, not only the paths.
- `grade.py`'s scope check runs `git ls-tree` from the draft's directory, so a draft in the
  session scratchpad (outside the repo) falls back to a stale hardcoded package list and
  fails "prefix exists". Stage drafts under `<repo>/node_modules/.drafts/` (gitignored,
  inside the work tree) and delete after filing.
- `cite_check.sh`'s "last path wins" resolver bites in dense paragraphs: a bare `:NN` after a
  bold `**`path`.**` lead-in resolved to the previous paragraph's file. Write the full
  `path:NN` on the first cite of every paragraph.
- The user chose a 4-way split where one child (tests/hygiene) carried ~12 nits across
  three boxes grouped by surface (checks / tests / docs); triage accepted it, so "N nits =
  N issues" is a guideline — tight grouping under one `chore(...)` title passes.

## 2026-09-05 — show-me sketch added to the body shape

- The user asked every repo-local PR/issue writer (`apps-implement`, this skill,
  `to-issues`) to use the `show-me` skill. Added a `<Sketch: …>` slot to the refile
  shape, a rule with its reason in step 4, and rubric item 10. `grade.py` was left
  alone on purpose: its calibration set (#421, #469, #471–#473) predates the rule and
  a scripted "has a fenced sketch" check would fail every one of them. Recalibrate if
  a scripted check is ever added. Not yet exercised on a real filing — the first run
  after this should record whether triage reads the sketch or ignores it.
