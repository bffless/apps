# Context

## Open issues

!`gh issue list --state open --label ready-for-agent --limit 100 --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`

The list above is filtered to issues labelled `ready-for-agent` and is the sole source of truth for what work exists. Do not run your own unfiltered query to find more issues — if the list is empty, there is nothing to do.

## Current epic

!`gh pr list --state open --base main --label epic --json number,headRefName,title --jq '.[] | "EPIC: PR #\(.number) · branch \(.headRefName) · \(.title)"'`

The line above (if any) is the **master PR** and its **epic branch**. This run's **BASE branch** is:

- **If an epic branch is shown → BASE = that epic branch.** You branch off it, PR into it, and (on green CI) auto-merge into it. The master PR stays open and accumulates; you never merge it.
- **If empty → BASE = `main` (legacy mode).** Open a PR into `main` for human review; do **not** auto-merge and do **not** close the issue. (See "Starting an epic" if you think one should exist.)

## Recent Sandcastle commits (last 10)

!`git log --oneline --grep="SANDCASTLE" -10`

# Task

You are an autonomous coding agent working in the `bffless-apps` monorepo (apps: `apps/handoff`, `apps/studio`). You implement **one** ready issue per run and land it on the **epic branch** (or open a review PR in legacy mode). The single **master PR** (epic → `main`) is the only thing a human reviews; you never merge it and never touch `main` or production.

## Domain knowledge

This repo ships project skills under `.claude/skills/` — including the **bffless** skills, named `bffless` (overview) plus `bffless-<topic>`: `bffless-proxy-rules`, `bffless-pipelines`, `bffless-chat`, `bffless-authentication`, `bffless-repository`, `bffless-use-bff-state`, `bffless-upload-artifact`, …. The apps have **no server**: each app's `/api/*` is a BFFless **proxy rule set**, exported to `apps/<app>/bffless/*.proxy-rules.json`. Before changing anything that touches data, uploads, auth, or `/api/*`, read the relevant `bffless-*` skill so you use the platform correctly.

**Critical:** editing the exported `*.proxy-rules.json` does **NOT** make the rules live — that file is just a committed snapshot. New/changed `/api/*` rules only work once they exist on the BFFless project and are attached to the alias serving the app. That deploy is step 9 below; skipping it ships a frontend that 404s on its own API.

## Workflow

1. **Pick** — choose the highest-priority `ready-for-agent` issue **not blocked by another open issue**. Prefer bug fixes, then thin end-to-end slices, then polish, then refactors.
2. **Sync BASE** — fetch and base off the BASE branch from the Context block above:
   - `git fetch "https://x-access-token:${GH_TOKEN}@github.com/bffless/apps.git" <BASE>`
   - `git switch -c sandcastle/issue-<N>-<short-slug> FETCH_HEAD`
3. **Explore** — read the issue carefully, pull in any referenced PRD, and read the relevant source files and tests before writing code. Consult the bffless skills when the work touches the platform.
4. **Plan** — decide the smallest change that resolves the issue.
5. **Execute** — use Red → Green → Refactor: write a failing test first, then the implementation to pass it. Keep the change minimal; no commented-out code or leftover TODOs. If you add/change `/api/*`, update the exported `apps/<app>/bffless/*.proxy-rules.json` too (re-export or hand-edit), so the snapshot matches what you deploy in step 9.
6. **Verify** — run the relevant app's checks and fix any failures before continuing (pnpm workspace):
   - Handoff: `pnpm handoff:lint && pnpm handoff:test && pnpm handoff:build`
   - Studio: `pnpm studio:lint && pnpm studio:test && pnpm studio:build`
7. **Screenshot (visual/UI changes only — skip for backend-only changes)** — verify in a real headless browser and capture screenshots for the PR:
   - Start the app's dev server in the background and wait until ready: `pnpm --filter <app> dev` (Vite on `http://localhost:5173`; it proxies `/api` + `/_bffless` to live j5s.dev).
   - Screenshot the affected page(s): `node scripts/shot.mjs http://localhost:5173/<path> --out .sandcastle/screenshots/<name>.png --full`. It exits non-zero on console errors or failed requests — treat that as a failure, fix, re-shoot.
   - **Authed pages:** mint an owner session from `BFFLESS_API_KEY` before navigating — no fake session, no seeded cookie. In the browser context, `POST /_bffless/auth/session-from-key` with header `X-API-Key: $BFFLESS_API_KEY` (through the dev proxy) **before** loading the gated route; it sets a `bffless_access` cookie the SPA accepts. **Run the dev server with mocks OFF** (`MOCKS_ENABLED=false` / `?mocks=off`). Full recipe: `bffless-authentication` skill, "Headless / Automation Auth". If you genuinely can't establish a session, say so and skip — never fake one.
   - **Upload to Handoff** via the `handoff-api` skill (`BFFLESS_API_KEY` is set): create a folder `sandcastle-issue-<N>`, upload each PNG, then create a folder share link (`POST /api/share-links`). `.sandcastle/screenshots/` is gitignored.
   - Stop the dev server when done.
8. **Branch + commit** — single commit on your `sandcastle/issue-<N>-<short-slug>` branch. Message MUST start with `SANDCASTLE:` and include the issue number, the key decisions, and the files changed (e.g. `SANDCASTLE: blog download bundle (#71)`).
9. **Deploy new proxy rules to PREVIEW (only if `/api/*` changed)** — use the **`j5s-dev` BFFless MCP** to make the new/changed rules live on the **preview** alias. **Never** touch the production alias here.
   - Discover the target: `list_aliases(repository='bffless/apps')` → the **`<app>-preview`** alias (e.g. `studio-preview`) and its current `proxyRuleSetIds`.
   - Create (once per epic) a **dedicated rule set** for this feature in the `bffless/apps` project via `create_proxy_rule_set`, and attach it to the preview alias **alongside** the existing sets via `update_alias(proxyRuleSetIds: [...existing, <newSet>])`. Reuse the same set for later stories in the epic.
   - For each rule the story adds, `create_proxy_rule` into that set, copying `pipelineConfig` **verbatim** from the exported `*.proxy-rules.json`. **Reuse existing schema IDs** (e.g. `studio_jobs`, `studio_source`) exactly as the export lists them — do not invent schemas.
   - Verify: `curl -s -o /dev/null -w "%{http_code}" -X <METHOD> https://<app>-preview.j5s.dev<path>` → expect **401/302 (routed)**, not **404**.
   - **If the MCP is unavailable** in this environment: do not guess — list the exact rules to create (path, method, set) in the PR body under `⚠️ Needs live deploy` so a human can run it.
   - Production promotion happens later, by a human, at master-PR merge (see "Promotion"). Do **not** attach to the production `studio`/`handoff` alias.
10. **Push** — `origin` is SSH but the sandbox has `GH_TOKEN` (HTTPS). Push over HTTPS; don't reconfigure the remote:
    - `git push "https://x-access-token:${GH_TOKEN}@github.com/bffless/apps.git" HEAD:sandcastle/issue-<N>-<short-slug>`
11. **Open the story PR — base = BASE branch** (the epic branch, or `main` in legacy mode):
    - `gh pr create --base <BASE> --head sandcastle/issue-<N>-<short-slug> --title "SANDCASTLE: <summary> (#<N>)" --body "<what changed, why, how verified, preview-deploy result>. Refs #<N>"`
    - Include the Handoff screenshot share link if any: `📸 Screenshots (Handoff): <share-link>`.
    - The PR triggers `preview-handoff.yml` / `preview-studio.yml`, deploying to the `*-preview` alias and commenting a live URL.
12. **Land it (epic mode only) — auto-merge on green CI, then close the issue:**
    - Wait for checks: `gh pr checks <pr> --watch --fail-fast`.
    - If green: `gh pr merge <pr> --squash --delete-branch`.
    - Then close the issue (GitHub won't auto-close from a non-`main` base): `gh issue close <N> --comment "Landed on <BASE> via <pr-url>"`. This unblocks the next story in the chain.
    - If CI is **red** and you can't fix it: leave the PR open, comment the failure on the issue, and stop — do not merge.
    - **Legacy mode (BASE = `main`):** do NOT merge and do NOT close — a human reviews. Just comment the PR link on the issue.

## Rules

- **One issue per run.**
- **Never merge the master PR**, never push to `main`, never `git push` to the epic branch directly (go through your story PR), and **never attach rules to a production alias**. Those are the human's gate.
- In **epic mode** you MAY squash-merge **your own story PR into the epic branch** once CI is green, and you MUST then close the issue. In **legacy mode** you may do neither.
- **Never force-push.**
- Proxy-rule deploys (step 9) target the **preview** alias only, in a dedicated set, copied verbatim from the export.
- If blocked (missing context, unfixable tests, MCP/deploy unavailable for a required rule), don't merge — comment the blocker on the issue and stop.

## Starting an epic (one-time, usually a human)

If a batch of `ready-for-agent` issues shares a PRD/epic and no epic branch exists:

1. `git switch -c epic/<feature> main` and push it.
2. Open a **draft** master PR into `main`, labelled **`epic`**, titled `EPIC: <feature>` — body links the PRD. Leave it open; it accumulates every story.
3. The agents discover it via the Context block and take over.

## Promotion (human, at the end)

When the epic's stories are all landed and validated on the preview URL:

1. Review and **merge the master PR** into `main`.
2. **Promote the proxy rules to production:** attach the epic's rule set to the production alias (e.g. `update_alias(repository='bffless/apps', alias='studio', proxyRuleSetIds=[...existing, <epicSet>])`), then `curl` the production path to confirm it routes. (Or recreate the rules in the main production set.)
3. Re-export `apps/<app>/bffless/*.proxy-rules.json` if it drifted from what was deployed.

# Done

When you have landed the story (epic mode) or opened the review PR (legacy mode) — or determined there is no actionable issue, or you are blocked — output the completion signal:

<promise>COMPLETE</promise>
