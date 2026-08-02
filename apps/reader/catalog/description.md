Rivulet is a quiet, self-hosted RSS/Atom reader that runs entirely on your BFFless project —
no separate backend to deploy or maintain, no third-party reading service holding your
subscriptions.

Subscribe to feeds by pasting a site URL (Rivulet discovers the feed for you), organize them
into folders, and read in a calm three-pane layout built for keyboard-first triage. A
background schedule refreshes every feed every 15 minutes, so new items are already there
when you arrive; a nightly retention pass prunes old read items so the backlog never becomes
a chore. Multiple people can share one install — everyone signs in with their own account and
gets their own subscriptions, read state, and stars.

## Highlights

- **The river** — one reverse-chronological stream of everything unread across all your
  feeds, alongside per-feed, per-folder, starred, and all-items views.
- **Feed auto-discovery** — paste a site's homepage and Rivulet finds its RSS/Atom feed
  server-side, dodging CORS.
- **Keyboard-first reading** — j/k through items, mark read, star, archive without touching
  the mouse; read/unread badges keep the sidebar honest.
- **Background refresh + retention** — installer-created schedules ingest every 15 minutes
  and prune read, unstarred items after 30 days. Starred and archived items are kept forever.
- **Multi-user** — per-user subscriptions, read state, stars, and folders on one shared
  install; a feed shared by several readers is fetched once.
- **OPML import/export** — bring subscriptions from your old reader, leave with them any
  time.
- **Private by default** — the whole app sits behind your instance's sign-in; nothing is
  exposed anonymously.

## How it works

Rivulet's frontend is a static React app; its entire backend is a BFFless proxy rule set —
pipelines composing `xml_feed_parse`, data tables, and scheduled runs for ingest and
retention. Installing it from the catalog deploys the frontend, attaches the rule set to a
`reader` alias, and creates the two background schedules in one click.
