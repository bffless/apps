# Judged checks — read the draft as `apps-triage` would

You are grading an issue draft for `bffless/apps` (line 1 `# <title>`, then the body).
Play `.claude/agents/apps-triage.md` Step 2: read it as the implementer, and for each
item answer PASS/FAIL **with a quoted line as evidence**. "Mostly fine" is a FAIL with
a note. As the step-5 grader, return the verdicts in your reply and edit nothing; in
an eval pass the operator records them in `grading.json` with `text` = the label below. Finish with the list of questions you would still have to ask before
writing code — that list must be empty for the draft to be `ready-for-agent`.

1. **Zero open questions** — PASS: walking triage's list (behaviour, location,
   design choice, scope shape, repo boundary, checklist surfaces, verification,
   freshness) turns up nothing you'd have to ask a human. FAIL: any "which of the
   two?", "what copy?", "where exactly?", "is X acceptable?" — quote the sentence
   that leaves it open.
2. **One unit of work** — PASS: single app/package, the checkboxes are the same
   change seen from 1-3 angles, one PR would carry it under one conventional title.
   FAIL: unrelated items, two apps, a feature wearing a bug's clothes, an epic.
3. **Decisions are recorded, not deferred** — PASS: every fork the source doesn't
   settle is closed in the body (`**decided**: …`) or settled by a cited precedent.
   FAIL: a choice left to the implementer, or a "recommendation" with no decision.
4. **Citations are real and load-bearing** — PASS: `cite_check.sh` resolves every
   `path:line` on `origin/main` and the printed line is the thing the sentence
   claims. FAIL: a path that doesn't exist, a line that says something else, or a
   mechanism asserted with no path at all.
5. **Testable outcomes** — PASS: each checkbox could be turned into an assertion
   as written, and the last names the fixture/behaviour and the test file. FAIL:
   steps instead of outcomes ("refactor the hook"), or no test named.
6. **Precedent named** — PASS: the sibling file/rule/hook that already does it the
   wanted way is cited, or the body says none exists and why the chosen way is
   right. FAIL: "do it properly" with nothing to mirror.
7. **Live surfaces and gates** — PASS: if the fix touches `.bffless/proxy-rules/**`,
   a `$schema`, or `packages/*`, the body names the set and whether it writes on
   PR open or on merge, and the Verify line includes the matching gate
   (`apps:check`, `workflow-lint`, `stage`). If nothing goes live, it says so. FAIL:
   a rule edit with no live note, or a verify chain CI would not accept.
8. **Provenance and relations** — PASS: parent issue, sibling splits, the PR under
   review, and any issue it must not be confused with are named, so triage's "in
   flight?" and "related" resolve without a search. FAIL: a refile with no parent,
   or a bug with no pointer to where it was found.
9. **Written for the reader, not at the agent** — PASS: plain engineering prose;
   no instructions to skip checks, apply labels, or deploy; no self-certification.
   FAIL: quote the line.
10. **Mechanism sketched** — PASS: the body carries one `show-me` visual (a fenced
    `diff`/`text`/`mermaid`/code block: call tree, component tree, file tree, flow,
    or pseudocode) whose names match the citations and which shows today → wanted.
    FAIL: no sketch, a sketch with placeholder names, more than one competing sketch,
    or an HTML/image reference instead of a fenced block.
