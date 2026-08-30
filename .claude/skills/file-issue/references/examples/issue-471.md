# workflow-studio: useSigned resolves all-or-nothing — sign per sheet (#460)

Refiled from #460 item 2. `apps/workflow-studio/islands/lib/useSigned.ts:110-141` signs every path via `Promise.all`, so the clip waits for the last sheet before the first renders. Only `cut-editor` uses it now (`islands/cut-editor/App.tsx:255`; `blog-editor` has its own on-demand cache since #433).

- [ ] Resolve per path: each entry moves to `ready` as its `workflow.sign` returns; the hook's shape stays the same for callers.
- [ ] One failed sign marks only that entry, not the batch.
- [ ] Test in the hook's existing test file (or add one beside it) with a delayed second sign.

Verify: `pnpm workflow-studio:lint && pnpm workflow-studio:stage && pnpm workflow-studio:build && pnpm workflow-studio:test`. Rules go live on merge only. Citations against `origin/main` `bd7e005`.

