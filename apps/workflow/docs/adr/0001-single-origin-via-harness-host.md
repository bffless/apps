---
status: accepted
date: 2026-08-19
amended: 2026-08-28
---
# The browser talks only to the harness host

Implementations deploy to their own aliases (separate hosts) inside the harness's project, but
the harness page must call their pipelines and load their islands/scripts. Calling
`studio.<domain>` directly from `workflow.<domain>` fails twice: module scripts and `fetch` are
CORS-gated (deployments emit no `Access-Control-Allow-Origin`), and the session cookie is
per-host, so every cross-host call would be unauthenticated.

**Decision:** single origin. An implementation's rule set is attached to **its own alias and
the harness alias** (paths namespaced `/api/<impl>/...`), and it ships one forwarding rule
`GET /w/<impl>/[...path] → https://<impl>.<domain>/[...path]` (the target changed — see the
amendment) so its static files are same-origin on the harness. Islands run in opaque-origin
sandboxes and reach everything through the harness bridge, so they inherit this for free.

**Considered:** CORS headers on implementation aliases + cross-host cookies (rejected: cookies
don't cross hosts; also the house rule is "reach another BFFless host via a proxy rule, never
CORS"); mounting the implementation under the harness alias via `base-path` (rejected:
`base-path` is only a zip prefix, not a mount).

**Consequences:** `publish-workflow` must attach to two aliases and generate the forwarding
rule; implementation API paths must be prefixed with the implementation name. What that rule
targets changed — see the amendment.

## Amendment (2026-08-28) — the forwarder serves the alias in-process

The forwarding rule no longer targets the implementation's public host. From
`bffless/publish-workflow` **v1.2.0** it targets the CE backend's own serve route for that
alias, in-process:

```yaml
# rules/_custom/forward/get.rule.yaml   (generated)
pathPattern: /w/<alias>/*
targetUrl: http://localhost:3000/public/<owner>/<repo>/alias/<alias>/dist
stripPrefix: true   # the default — strips /w/<alias>
forwardCookies: true
```

`<owner>/<repo>` is the **harness project** (the action's `repository` input, e.g.
`bffless/workflow`) — the project the alias lives in, not the implementation's own GitHub
repo. The trailing `dist` is the publish `path` input as given (`dist` by default) — `upload-artifact`
keeps the uploaded directory as the bundle root.

Why it works, in two halves:

- **The route exists.** CE serves every alias at `/public/<owner>/<repo>/alias/<alias>/<path>`
  under `OptionalAuthGuard` (`apps/backend/src/deployments/public.controller.ts`) — with the
  caller's session a private alias answers 200, without it 404.
- **The hop is the backend's, not nginx's.** A rule with no `authTransform` is never rendered
  into an nginx location block (`domains.service.ts` filters `authTransform !== null` before
  generating them); plain rules like this forwarder — and the harness's own `/api/auth` relay,
  which has run this way since M1 — are proxied **in-process by the CE backend**.
  `proxy.service.ts` `forward()` → `buildTargetUrl()` strips the matched prefix and joins the
  remainder onto the target URL's *pathname* ("mimicking nginx behavior"), forwards the
  `cookie` header when `forwardCookies` is set and strips `host` — which is why a target URL
  **with a path** is honoured and why the member's session reaches the serve route.

Assumption: the CE backend can reach itself at `localhost:3000` — true for the CE compose
stack and for the platform's nginx+backend sidecar pod; the `backend-url` input overrides it.

**Consequences of the amendment:** a rule set carries no per-install hostname, and a domain
for an implementation alias is **optional** (cosmetic, for humans). PR-preview aliases need
nothing at all — CE's domain API is admin-only and a CI key is never admin, so
`publish-workflow` could not create one — and are browsable through the harness at
`/w/<alias>/…` (where `<alias>` is the preview alias itself, `<impl>-pr-N`) the moment they
publish. `target-url` remains as an explicit override
(the legacy per-domain mode). ce#698 (`targetUrl: alias://<impl>`) is demoted to a
nice-to-have: a declarative spelling of the same hop, not a dependency. This resolves the
forwarder half of apps#364.
