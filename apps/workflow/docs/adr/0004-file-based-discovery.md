---
status: accepted
date: 2026-08-19
---
# Discovery is file-based: a deploy is the publish

The harness must learn which implementations and workflows exist in its project. The truth
could be a registration table the implementation's CI writes to, or the implementation's own
deployed files.

**Decision:** files. Implementation CI copies `.bffless/workflows/*.yaml` and a generated
`index.json` into the deployed bundle; the harness lists the project's aliases and probes each
for `/w/<alias>/.bffless/workflows/index.json`. No registration, no second sync path; preview
aliases appear as implementations automatically; what you see is what is deployed (GitHub
works the same way — the repo's files are the registry).

**Considered:** a `workflows` data table written by CI (rejected: a second sync path that can
drift from what the alias actually serves).

**Consequences:** discovery is a probe with caching, not a query; each run snapshots the
definition it started from, because the alias moves on.
