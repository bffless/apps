# CLAUDE.md — Workflow Studio

Guidance for Claude Code when working in `apps/workflow-studio`.

## What this app is

A re-authoring of `apps/studio`'s video-cutting pipeline as a **Workflow-harness
implementation** (`apps/workflow`) — see [`CONTEXT.md`](CONTEXT.md) for the vocabulary and
[`README.md`](README.md) for commands. It is not a standalone SPA: it ships a workflow YAML,
islands and scripts that the harness fetches and runs, plus the pipelines they call. Read
`apps/workflow/docs/spec/` (start at `00-overview.md`) and
`apps/workflow/docs/writing-an-implementation.md` before adding any of those — this app
follows the same contract `bffless/workflow-hello` does.

## Source of truth

`.bffless/workflows/studio.workflow.yaml` is the contract: every rule, script and island
here exists to serve a step in it, and the workflow lint
(`pnpm --filter workflow-studio stage`, or `workflow lint … --rules … --path-prefix
/api/workflow-studio`) is what proves the four halves still agree. `CONTEXT.md` is the map
of the tree, `bffless/README.md` is the backend + one-time project setup, and the port's
own design record is the M3 plan under
`.superpowers/sdd/2026-08-27-workflow-m3-publish-headless-studio/` (the `R###` markers in
the comments here are its rulings — cite them the same way when you add one).

`apps/studio` is the other source of truth: this app is a PORT, so where a prompt, a
constant or a piece of arithmetic came from Studio, it is Studio's — verbatim, and the
fixtures assert it. Change Studio's, not the copy, unless the harness genuinely forces a
deviation (and then say so in a comment, with the ruling).

## Reusing Studio

Depend on `apps/studio`'s pure logic through the workspace package rather than copying files:

```ts
import { planAutoTrim } from 'studio/lib/autoTrim'
import { CutEditor } from 'studio/components/Studio/CutEditor'
import 'studio/index.css'
```

`studio`'s `package.json` `exports` is the contract (`./lib/*`, `./components/Studio/CutEditor`,
`./components/Studio/clipPlayer`, `./components/Studio/MarkdownBody`,
`./components/Studio/MermaidDiagramView`, `./index.css`) — see `apps/studio/CLAUDE.md` → "Public
surface (consumed by workflow-studio)". If a lib module workflow-studio needs isn't exported
yet, add it to that map (and keep it store-free) rather than reaching into `studio/src/...`
directly, which the `exports` map blocks.

## Layout

- `islands/` — React micro-UIs (MCP Apps format) rendered by the harness in a sandboxed
  `srcdoc` iframe. Built one-per-island by `vite.islands.config.ts` (`WORKFLOW_ISLAND` env),
  type-checked under `tsconfig.islands.json` (DOM + `react-jsx`, no Node types).
- `scripts/` — `script`-step ES modules that run in a Worker on an opaque origin (no DOM, no
  Node). Built one-per-script by `vite.scripts.config.ts` (`WORKFLOW_SCRIPT` env, lib mode,
  `inlineDynamicImports: true`), type-checked under `tsconfig.scripts.json` (`WebWorker` lib
  only — no DOM, no Node types).
- The two Vite build configs are Node-side tooling, not browser code — they're checked
  separately under `tsconfig.node.json` so neither browser project's types leak `process`/
  `Buffer`/`node:*` into a `scripts/**` or `islands/**` module (apps/studio's own
  `tsconfig.node.json` is the same split, for the same reason).
- `.bffless/proxy-rules/workflow-studio/` — the authored rule set (backend), isolated in
  project `bffless/workflow` (never in `.bffless/config.json`'s `ruleSets` globs — see
  `apps/workflow/bffless/README.md` → "Rule-set isolation").
- `.bffless/skills/` — the AI skills the `thumbnail/draft`, `describe` and `blog` rules
  `load_skill` (`image-prompts`, `video-description`, `bffless-docs`): a verbatim copy of
  `apps/studio/.bffless/skills/`, pinned by `src/skills-drift.test.ts` — refresh the copy,
  never edit it. The stager puts them at `dist/.bffless/skills/`, and each rule's
  `skills:` block names that path on alias `workflow-studio`, so a publish is the skills
  deploy (no project-level Skills Source needed).

`scripts/` holds the workflow's six `script` steps (`sheet-plan`, `scene-sheet-plan`,
`scene-inputs`, `final-script`, `frame-times`, `blog-bundle`) plus `scripts/lib/` support code — shared
`ctx.inputs` guards and a test-only fake context, neither of which is a build entry.
`islands/` holds `cut-editor/` — the `trim` step's editor, which mounts Studio's own
`CutEditor` — and `blog-editor/` — the blog job's `review` step, which renders the post on
Studio's `MarkdownBody` with its Change-frame picker over the frames the run already
captured (apps#429) — plus `islands/lib/` (the MCP Apps handshake and the `workflow.sign`
helpers both share) and `islands/test/` (the fake host every island suite renders against).
An island is a *bundle file*: the harness fetches it and injects it into an
`<iframe sandbox="allow-scripts">` as `srcdoc`, so the frame has an opaque origin and can
fetch nothing. Everything it needs is inlined by `vite-plugin-singlefile`, and media is
reached by exchanging a `FileRef`'s `path` for a presigned URL over the `workflow.sign`
host tool (`islands/lib/useSigned.ts`).

## Testing

`vitest.config.ts` splits by directory via `test.projects`: `scripts/**` runs under `node`
(closest to the Worker's no-DOM environment), `islands/**` runs under `jsdom` with the React
plugin and React Testing Library, with jest-dom's matchers from `islands/test/setup.ts`. The
exceptions are the islands' `build.test.ts` files, which inspect a built artefact and so
override their own environment back to `node` (`@vitest-environment node` — under jsdom,
`import.meta.url` is a `http://localhost:3000/…` document URL, not a path into `dist/`).

`tsconfig.scripts.json` carries `DOM` in its `lib` for TYPES ONLY: Studio's pure libs reach
`src/lib/frames.ts` (browser frame capture) through an erased `import type`, so no DOM code is
bundled. The runtime fence is the `node` environment above — a script that actually touched
`document` would fail its suite.

`scripts/build.test.ts` asserts each built `dist/scripts/<name>.js` is one self-contained ES
module (no surviving `import`/`require`, a `default` export). It skips when the file isn't
built, so run the builds first to exercise it:

```sh
WORKFLOW_SCRIPT=scripts/<name>.ts pnpm exec vite build -c vite.scripts.config.ts
```

`islands/<island>/build.test.ts` is the same idea for an island: the built
`dist/islands/<island>.html` must reference nothing external AND must already carry the
Tailwind utilities the Studio components it renders are styled with (and, for `blog-editor`,
must NOT carry `mermaid`'s code — its ```mermaid fences load the library at runtime from the
pinned CDN URL in `islands/blog-editor/mermaid.ts`, so the built HTML carries that URL and
nothing of the library; apps#441). Build it the same way, then open it standalone
to smoke-check it renders. A built island with no host on the other end keeps its "waiting"
shell, and the handshake race in `islands/lib/mount.tsx` stamps the shell
`data-handshake-state` once the handshake settles (apps#523): standalone that is
`"rejected"` almost immediately — a top-level window posts `ui/initialize` to itself and the
SDK answers its own request with "Method not found" — while a host that attaches the island
but never answers hits the 5 s timer and reads `"timeout"` / "no workflow host" (both
branches are proven in `islands/lib/mount.test.tsx`). The `--wait` below asserts the
handshake actually ran and settled — a bundle that crashed on load stamps nothing, so the
check fails (and a clean run still reports `consoleErrors:0`):

```sh
WORKFLOW_ISLAND=cut-editor pnpm exec vite build -c vite.islands.config.ts
node ~/bffless/localdev-tools/shot.mjs "file://$PWD/dist/islands/cut-editor.html" --out /tmp/island.png --wait '[data-handshake-state]'
```

## Styling an island

Studio's components are Tailwind utilities over Studio's `@theme` tokens, and both halves have
to be generated INTO the island's own file. `islands/<island>/styles.css` imports
`studio/index.css` (tokens, base layer, `.rule`/`.pill-cta`) and then declares its sources
explicitly — `@import 'tailwindcss/utilities.css' layer(utilities) source(none)` first, to
switch off Tailwind's automatic content detection, which resolves a project root well above
this app and sweeps in every other app's class names. See the comment at the top of
`islands/cut-editor/styles.css`; `postcss.config.js` at the app root is what runs Tailwind
(Vite finds it by searching up from the island directory it roots each build at).
