---
status: accepted
date: 2026-08-19
---
# The browser talks only to the harness host

Implementations deploy to their own aliases (separate hosts) inside the harness's project, but
the harness page must call their pipelines and load their islands/scripts. Calling
`studio.<domain>` directly from `workflow.<domain>` fails twice: module scripts and `fetch` are
CORS-gated (deployments emit no `Access-Control-Allow-Origin`), and the session cookie is
per-host, so every cross-host call would be unauthenticated.

**Decision:** single origin. An implementation's rule set is attached to **its own alias and
the harness alias** (paths namespaced `/api/<impl>/...`), and it ships one forwarding rule
`GET /w/<impl>/[...path] → https://<impl>.<domain>/[...path]` so its static files are
same-origin on the harness. Islands run in opaque-origin sandboxes and reach everything through
the harness bridge, so they inherit this for free.

**Considered:** CORS headers on implementation aliases + cross-host cookies (rejected: cookies
don't cross hosts; also the house rule is "reach another BFFless host via a proxy rule, never
CORS"); mounting the implementation under the harness alias via `base-path` (rejected:
`base-path` is only a zip prefix, not a mount).

**Consequences:** `publish-workflow` must attach to two aliases and write a per-install
`targetUrl`; a CE follow-up `targetUrl: alias://<impl>` would make the forwarding rule
declarative. Implementation API paths must be prefixed with the implementation name.
