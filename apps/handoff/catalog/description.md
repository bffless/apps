Handoff is an internal, permissioned file server that runs entirely on your BFFless project —
no separate backend to deploy or maintain.

Upload documents, prototypes, images, videos, or whole static Sites; organize them into
folders; and control exactly who sees each folder with per-folder access grants, group
sharing, and share links for people outside your team. Uploaded HTML bundles are served
back live, so a designer can hand off a clickable prototype the same way they hand off a PDF.

## Highlights

- **Per-folder access control** — grant people or groups access folder by folder; everything
  else stays private to its owner.
- **Share links** — hand a token-scoped link to someone without an account. Links can be set
  to expire, and revoked at any time.
- **Live Sites** — uploaded static bundles (HTML/CSS/JS) are served as browsable sites,
  including a chromeless embed mode other tools can iframe.
- **Comments** — Google-Docs-style margin comments, anchored to a text selection or a pin on
  an image, with replies and reactions.
- **RSS feeds** — follow a public folder's updates from any feed reader.
- **Built-in viewers** — PDFs, images, markdown, video, and audio render inline; anything else
  falls back to a clean download card.

## How it works

Handoff's frontend is a static React app; its entire backend is a BFFless proxy rule set —
pipelines for presigned uploads, an access-controlled node tree, serving, grants, and share
links. Installing it from the catalog deploys the frontend and attaches the rule sets to a
`handoff` alias on your instance in one click.
