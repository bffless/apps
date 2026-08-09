# Recall backend — BFFless proxy rule set

Recall (video transcript RAG search & chat) has no app server. Its `/api/*` endpoints are a
**BFFless proxy rule set**. To run Recall against your own BFFless project you import that rule
set and attach it to the alias serving the app.

Recall's rule set is **authored** under
[`apps/recall/.bffless/proxy-rules/recall/`](../.bffless/proxy-rules/recall/) — that's the source
of truth, not a committed JSON export.

This is a scaffolding-only task (bffless/apps Task 2) — no rules exist yet. The endpoint table,
import instructions, and data-table schemas land in Task 12 alongside the actual pipelines.

## Manual setup (admin panel)

TODO (Task 12): document the manual admin-panel steps Recall needs — likely an AI provider token
for embeddings/chat, a storage bucket for transcripts, and the data-table schemas backing search.

## First-success checkpoint

TODO (Task 12): document the one end-to-end action that confirms Recall is wired up correctly
once its rule set is imported and attached.
