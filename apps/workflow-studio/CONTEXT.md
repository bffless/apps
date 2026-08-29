# Workflow Studio

Workflow Studio re-authors `apps/studio`'s video-cutting pipeline (upload → transcribe →
scene director → per-scene cut editor → export) as a **Workflow-harness implementation** —
see `apps/workflow/CONTEXT.md` for the harness vocabulary (workflow, job, step, island,
script, run). It ships no harness of its own: it deploys to its own alias inside the
`bffless/workflow` project (like `bffless/workflow-hello`) and is discovered the same way.

It reuses `apps/studio`'s pure logic and cut editor as a **workspace dependency** —
`studio/lib/*` and `studio/components/Studio/CutEditor` — rather than forking the source
(see `apps/studio/CLAUDE.md` → "Public surface (consumed by workflow-studio)"). Everything
Studio-specific that isn't pure (the Redux store, the RTK Query API layer, the app shell) is
re-authored here against the harness's step/payload model instead.

## Status

Complete and publishable. The tree is:

| Piece | Where | What it is |
| --- | --- | --- |
| The workflow | `.bffless/workflows/studio.workflow.yaml` | 9 jobs, upload → short + blog + cover |
| The backend | `.bffless/proxy-rules/workflow-studio/` | 13 rules over 2 data schemas |
| The skills | `.bffless/skills/` | Studio's `image-prompts`, `video-description`, `bffless-docs`, verbatim — loaded by the `thumbnail/draft`, `describe` and `blog` rules from this bundle |
| The `script` steps | `scripts/*.ts` | 5 modules (`sheet-plan`, `scene-inputs`, `final-script`, `frame-times`, `blog-bundle`) |
| The one island | `islands/cut-editor/` | the `trim` step, mounting Studio's own `CutEditor` |
| The bundle | `scripts/stage.mjs` | type-check → island → scripts → skills → `workflow index` |

`pnpm build` **is** the stager (`node scripts/stage.mjs`), and
`.github/workflows/deploy-workflow-studio.yml` runs it and hands `dist/` to
`bffless/publish-workflow@v1`. What has NOT happened is the live side: the one-time project
setup and the first end-to-end run — see [`bffless/README.md`](bffless/README.md) for the
checklist and the first-success checkpoint.
