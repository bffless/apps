Recall turns a library of video transcripts into something you can search and talk to — with
answers that cite the exact second they came from, not just the video.

**How it works**

1. **Upload** a video (or point at one you already have), and Recall transcribes it with
   word-level timestamps.
2. **Publish is index** — publishing a video chunks and embeds its transcript into your BFFless
   project's pgvector store. There's no separate "hide from search" toggle: a draft simply has
   zero embeddings, so it structurally can't surface in search or chat until you publish it.
3. **Visitors search or chat** on the public site. Search runs a straight vector lookup over
   every published transcript; chat is a RAG assistant that calls that same search as a tool and
   always cites the moment it found, as a clickable link that seeks the inline player to that
   exact second.

**What it needs**

Recall is a static app; every backend step — presigned uploads, transcription, chunking and
embedding, search, and chat — is a BFFless pipeline running on your own instance. Bring a
Replicate token (transcription, both embedding call sites) and an Anthropic key (the chat model),
enable the AI Data Tools plugin so chat can call its search tool, and a storage bucket with
presigned uploads and CORS open to your app's origin. The install steps walk through each.
