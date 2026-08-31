# Context Map

The `bffless-apps` monorepo holds independent apps; each app that has resolved its own
vocabulary keeps a `CONTEXT.md` (+ `docs/adr/`) in its folder.

## Contexts

- [Handoff](./apps/handoff/CONTEXT.md) — private file sharing / handoff of content with per-folder access
- [Reader](./apps/reader/CONTEXT.md) — per-user RSS/feed reader
- [Studio](./apps/studio/CONTEXT.md) — long screen recording → short video in the creator's own voice (cut-first)
- [Workflow](./apps/workflow/CONTEXT.md) — browser-driven, GitHub-Actions-style workflow harness; runs workflows declared by implementation repos

## Relationships

- **Workflow → Studio**: `workflow-studio` (a package in `bffless/workflow-implementations`, not in this monorepo) ports Studio's pipelines path-in/path-out and its cut editor as an island, from copies of Studio's libs frozen at the M4 move; Studio itself is unchanged. Shared vocabulary stays in each context — a Studio *scene* is just a matrix item's payload to Workflow.
