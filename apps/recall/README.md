# Recall

Video transcript RAG search & chat — search across your video transcripts and chat with an AI
that cites the moments it found, down to the second.

Recall is a static app with no server. Every backend step — presigned uploads, transcription,
chunking/embedding, search, and chat — is a BFFless pipeline running on your own instance, so you
bring the credentials (Replicate + Anthropic) and the storage bucket.

## How it works

1. **Admin uploads a video** (or points at an existing file), Recall transcribes it with word-level
   timestamps.
2. **Publishing a video indexes it** — its transcript is chunked and embedded into pgvector.
   Nothing unpublished is ever searchable or chattable: there's no separate visibility flag, a
   draft simply has zero embeddings.
3. **Visitors search or chat** on the public site. Search does a straight vector lookup over every
   published video's transcript; chat is a RAG assistant that calls the same search as a tool and
   always cites the exact video + timestamp it found, as a clickable link that seeks the inline
   player to that second.

## Development

```bash
pnpm install
pnpm --filter recall dev          # http://localhost:5173 — proxies /api + /_bffless to j5s.dev
pnpm --filter recall dev -- --open "/?mocks=on"   # fully offline: mocked search/chat/videos
```

`pnpm --filter recall build|lint|test:run` — build, lint, and unit tests. Root aliases:
`pnpm recall:dev|build|lint|test`.

## Setup (your own BFFless project)

See [`bffless/README.md`](bffless/README.md) for the rule set import steps, the manual admin-panel
setup (Replicate + Anthropic connections, bucket CORS), the embedding-model swap recipe, and the
end-to-end first-success checkpoint.
