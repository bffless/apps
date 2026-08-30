# workflow-studio: small fixes and nits from the Studio port review (#425)

Split from #425 (review residue of #424; epic #359) — the **small fixes and nits**. Every item is located and one-line-ish; intended as **one PR** (`chore(workflow-studio): …`). Citations against `origin/main` at `bd7e005`; paths under `apps/workflow-studio/` unless stated.

- [ ] Typo: `.bffless/proxy-rules/workflow-studio/rules/refine-scene/post/fallback.fn.js:11` — "same same contact sheets".
- [ ] `vite.scripts.config.ts:26-29` only checks `if (!entry)`; validate `WORKFLOW_SCRIPT` like `vite.islands.config.ts:40-45` validates `WORKFLOW_ISLAND` (reject `!/^[a-z0-9-]+$/`).
- [ ] Drop the inert `tsBuildInfoFile` options — they live in `tsconfig.{islands,scripts,node}.json:2`, not in the Vite configs.
- [ ] `scripts/stage.mjs:223` — the no-`import` regex (`/(^|[\s;}])import\s*[({'"*]/`, `/(^|[\s;}])from\s*['"]/`, mirrored in `src/stage.test.ts:91-92`) fires on a bundled string literal containing `\nimport {`. Tighten it (or strip string literals first) and add the failing case to `stage.test.ts`.
- [ ] `.github/workflows/workflow-lint.yml:67` step name still reads "Lint the spec examples with the built CLI".
- [ ] `.github/workflows/deploy-workflow-studio.yml` `paths:` (`:19-28`) omit `packages/workflow-lint/**`; the deploy builds that bin. (There is no `lint-version` input to pin — `:74` is a bare comment; nothing to do there until the workspace build and the published `^1.0.0` diverge.)
- [ ] Comment wording in `rules/blog/post/rule.yaml:49-50`: "every ai_handler step in this set uses `responseMode: message`" is imprecise — `blogClaude` sets none and gets `message` by default (CE `ai.handler.ts:138`). Reword to "uses or defaults to". The `ai.handler.ts:665` citation on `:49` is **correct** against CE `origin/main` (96ec1ac) — leave it.
- [ ] `rules/refine-scene/post/prep.fn.test.yaml` header overclaims for the no-dead-space case — narrow the wording.

Verify: `pnpm workflow-studio:lint && pnpm workflow-studio:stage && pnpm workflow-studio:build && pnpm workflow-studio:test`; the `.github` edits need no build.

