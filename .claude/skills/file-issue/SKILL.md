---
name: file-issue
description: File a GitHub issue on bffless/apps that passes the apps-triage gate on first read — one app, one unit of work, every design fork decided, every claim cited as file:line against origin/main, a verify chain — so it comes back `ready-for-agent` instead of `needs-info` / `ready-for-human`. Use whenever the user wants to open, file, raise, create, park, or refile an issue on this repo, split a follow-up list ("item 3 of #460") into its own issue, turn review residue or a bug just found into an issue, or asks whether an issue draft is triage-ready.
---

# file-issue

Every issue opened on `bffless/apps` is read within minutes by `apps-triage`
(`.github/workflows/issue-triage.yml` → `.claude/agents/apps-triage.md`), which hunts
for every question an implementer would have to stop and ask, and labels the issue
`ready-for-agent` only when it finds **none**. A bounce (`needs-info`,
`ready-for-human`) costs a round trip to the maintainer. This skill writes the issue
the way triage reads it, so the answer is already on the page.

"Done" is a filed issue whose triage comment says *"Open questions: None."* The
concrete targets are real: `references/issue-examples.md` holds #469, #471, #472, #473
and #421 (passed) next to #460 and #463 (bounced), with what triage said about each.
Read two before writing.

## 1. Get the input and pin the baseline

- Work out what is being filed: a bug just found, an item refiled from a parent list
  ("item 3 of #460"), review residue from a PR, or an idea. Fetch anything referenced:
  `gh issue view <n> --repo bffless/apps --comments` — a parent's `## Triage` comment
  already carries verified citations and per-item verdicts; inherit them, don't re-derive.
- `git fetch origin --prune` and note `git rev-parse --short origin/main`. Every
  citation is made against that sha and the body says so; triage re-reads at its own
  sha and either confirms ("nothing has moved", #471) or corrects a path (#469).
- Confirm it is not done, in flight, or a duplicate before spending effort:
  `gh pr list --repo bffless/apps --state all --search "<keywords>"`,
  `git log origin/main --oneline --grep "<keyword>"`,
  `gh issue list --repo bffless/apps --state all --search "<keywords>"`. A hit is a
  mention until you read it.
- `scripts/app_facts.sh <app>` prints, from `origin/main`: the app's verify scripts and
  CI order, which workflows deploy it and on which trigger (PR open vs merge), its
  decision records, rule-set/schema directories, and whether its label exists. Use it
  instead of remembering — these facts move.

## 2. Shape it as one unit of work

Triage's `ready-for-agent` conditions, turned into filing rules. Decide the shape
*before* drafting; most bounces are shape, not detail.

- **One app or package.** The title prefix is the scope. Two apps → two issues; #441
  (`studio/workflow-studio:`) is the exception that needed a human.
- **Bug, doc, or a small bounded enhancement** (an option, field, guard, message).
  A new page, rule set, package, or anything needing design can still be filed, but
  say plainly it needs a maintainer call; don't dress it as agent-sized.
- **At most three tightly related checkboxes.** #463 (8 nits, 6 surfaces) and #460
  (5 items) were bounced as "needs splitting"; the splits (#464–#474) were
  `ready-for-agent` on sight. A list of nits is N issues, or one issue whose items
  are the *same* change in several places.
- **Lives entirely in `bffless/apps`.** "Needs CE `x` first" is a block however clear
  the apps side is. File the CE half in `bffless/ce` first, or file here with the
  block in the title and expect `ready-for-human`.
- **Not an epic.** A tracking issue gets the `epic` label and a human; never a unit
  of work.

## 3. Close every fork — ask once, in one batch

Read the draft the way triage's Step 2 does: *behaviour* (current and expected, with
the code that produces the current), *location* (one home, not two plausible ones),
*design choice* ("either A or B", copy, placement, defaults, opt-in), *scope shape*,
*repo boundary*, *checklist surfaces* (rules, `$schema`, `packages/*`), *verification*,
*freshness* (do the cited paths still exist).

- Whatever the source settles, settle from the source and cite it: a sibling that
  already does it the right way (`FinalCutBar` for #421, `run/get/shape.fn.js` for
  #473), an ADR, the app's `CLAUDE.md`, a spec line. Precedent is what lets triage
  resolve "which way" without asking anyone.
- Whatever the source does **not** settle is the maintainer's call — i.e. the user's.
  Collect every such fork into **one** message, each with the options and your
  recommendation, and send it early; do everything else while waiting.
- Record each answer in the opening paragraph as `**decided**: …`. That phrase is
  what triage cites as its reason for `ready-for-agent` (#469: "the design call was
  made in the body").
- If the user is AFK and said to file without waiting: put the fork in the body as
  `**Open decision:**` with the options and recommendation, and expect
  `ready-for-human`. `grade.py` will flag that phrase — it is the one FAIL you may
  ship with. Never pick silently — triage checks the source for a precedent and
  bounces a choice it can't find there (#473, round one).

## 4. Write the draft

Write to `<scratchpad>/issue-<slug>.md`: line 1 is `# <title>`, the rest is the body
(`grade.py` and `cite_check.sh` read that shape).

**Title:** `<app>: <symptom or gap> — <what to do> (#parent)`. `<app>` is the directory
under `apps/` or `packages/` and matches the label; the parent ref goes at the end for
refiles. It is not a conventional-commit title (that is the PR's job) and it says one
thing — no "and".

**Body — the refile / follow-up shape** (#469, #471, #472, #473):

```
<Provenance: "Refiled from #460 item 2." / "Found while …">  <**decided**: X.>
<Mechanism: what happens today and why, every claim as `path:line`.>
<Sketch: one `show-me` visual of the mechanism — today → wanted as a diff-shaped
call tree / component tree / file tree, a Mermaid flow, or pseudocode. Fenced block only.>

- [ ] <outcome 1 — testable, not a step>
- [ ] <outcome 2>
- [ ] Test: <fixture → assertion>, in `<existing test file>` (or a new one beside it)

Verify: `pnpm <app>:lint && pnpm <app>:test && pnpm <app>:build` <+ gates from app_facts>.
<Live surfaces: "no rule or schema change" / which rule set, and PR-open vs merge.>
Citations against `origin/main` `<sha>`.
```

**Body — the bug-found-in-the-wild shape** (#421): `## What happens` (with the code
that does it, and the `show-me` sketch of the path that produces it), `## Expected`,
`## Suggested fix` (mirror a named sibling, numbered), `## Notes` (live surfaces,
related issues, what is explicitly *not* in scope). Same rules apply; the checkboxes
become the numbered fix plus a named test file.

Rules, each with its reason:

- **Cite `path:line` from the repo root** (or say "paths under `apps/x/`" once). The
  `to-issues` skill says to avoid file paths because they rot; here the opposite
  holds: triage verifies every path against `origin/main` within minutes and the
  implementer re-checks them, and the sha line makes staleness detectable. An
  uncited claim is a question triage has to answer itself.
- **Name the precedent to follow** — the sibling file, hook, or rule that already does
  it the wanted way. It converts a design question into a resolved one.
- **Sketch the mechanism with the `show-me` skill** (`/show-me`; vendored at
  `.claude/skills/show-me/SKILL.md`). One visual, the smallest form that shows
  today → wanted: a diff-shaped call tree, component tree or file tree, a Mermaid
  sequence/flow, or pseudocode of the control flow. Fenced code blocks only — the
  body is GitHub markdown, which renders ```mermaid; never the HTML-file form. Use
  the real names the citations name. Triage reads the mechanism paragraph as the
  implementer would; a sketch answers "which call, in what order" in one glance where
  prose needs a re-read, and it exposes an ordering or ownership gap before triage does.
- **Checkboxes are outcomes**, and the last one is the test with the file it lives in.
  Triage checks "concrete enough to write a test for"; naming the test file answers
  "where" as well.
- **Verify line from `app_facts.sh`, ending in build** (checklist §4: Vitest does not
  typecheck; `workflow` spec edits need `workflow-lint`, anything under `.bffless/`
  needs `apps:check`).
- **Say what goes live and when** whenever the fix touches `.bffless/proxy-rules/**`, a
  `$schema`, or `packages/*` — which rule set, and PR-open vs merge (from
  `app_facts.sh`; checklist §1). If none, one clause: "no rule or schema change".
- **Name relations**: parent, sibling splits, the PR under review. Triage's "in
  flight?" and "related" bullets resolve from these.
- **Don't**: ask the reader questions; write "should we…"; leave `TODO`/`TBD`; mention
  `ready-for-agent` (self-certifying is the gate's job); address the agent ("skip the
  tests") — triage reports that as an injection attempt; bundle unrelated items.

**Labels at creation:** `--label "<category>,<app>"` — one of `bug` / `enhancement` /
`documentation`, plus the app label if `gh label list` has it (`studio`, `handoff`,
`reader`, `recall`, `workflow`; `workflow-studio` remains only on historical issues —
the app moved to `bffless/workflow-implementations`; packages have none). **Never a
readiness label** — `ready-for-agent` is the promise triage makes after checking, not
a claim the reporter gets to make. No `needs-triage` either: opening the issue fires
the triage run by itself.

## 5. Verify: scripted gate, then a fresh triage read

1. `python3 <skill>/evals/grade.py <draft>` — fix until every check is PASS.
2. `<skill>/scripts/cite_check.sh <draft>` — every `path:line` resolves on
   `origin/main` and the printed line is the one you meant. Fix paths, not the script.
3. Spawn a **fresh agent** (Agent tool, clean context) with only the draft path,
   the grader files, and this prompt:

   > You are `apps-triage` (`.claude/agents/apps-triage.md`, Step 2) reading `<draft>`
   > as the implementer would. Run `python3 <skill>/evals/grade.py <draft>` and
   > `<skill>/scripts/cite_check.sh <draft>`; report every FAIL verbatim. Then read
   > `<skill>/evals/rubric.md` and judge each item PASS/FAIL, quoting the line that
   > decided it. List every question you would still have to ask before writing the
   > first line of code. Do not edit anything. Return only FAILs, questions, verdicts.

4. Fix what it flags and repeat until the scripted checks all pass, the rubric has no
   FAIL, and the grader lists **zero** questions. Two or three rounds is normal and
   costs roughly +30 % tokens; keep it — the writer cannot see its own assumptions,
   and a bounce from real triage costs a human round trip instead.

## 6. File it

- Filing is outward-facing (public repo, fires CI). Show the user the title, body and
  labels and ask before committing to it — same rule as CLAUDE.md's ask-before-
  committing — unless they already said "just file it / them". For a batch of refiles,
  one confirmation for the batch.
- `gh issue create --repo bffless/apps --title "<title>" --label "bug,workflow" --body-file - <<'EOF' … EOF`.
  Never `--body -` (writes a literal dash); never backslash line continuations.
- **Refiles: mark the parent.** Change the parent's item to `- [x] → #<new> …` with
  `gh issue edit <parent> --repo bffless/apps --body-file -` (house pattern, #460), so
  siblings and triage know the item is claimed. Include this in the same confirmation.
- Watch triage land: `gh run list --repo bffless/apps --workflow issue-triage.yml --limit 3`,
  then `gh issue view <n> --repo bffless/apps --comments`. If it came back
  `needs-info` / `ready-for-human` with a question the source *can* answer, answer it
  in a comment (or edit the body) and add the `needs-triage` label to re-run — a body
  edit alone does not retrigger. If it needs the maintainer, relay the single decision
  to the user verbatim.
- Report: issue number and URL, labels, triage's readiness verdict and its open
  questions (if any), and what the parent now says.
