# Uploads via signed URL; views through BFFless, except video

**Decision.** Bytes never stream through the app on the way *in*: all uploads (Files and Site
assets) go directly from the browser to the storage bucket via a presigned `PUT` URL the app mints
after an auth/ACL check. On the way *out*, viewing goes **through BFFless's content serving**
(same-origin) for everything **except video files**, which are served via a presigned `GET` URL
straight from the bucket.

**Why.**
- **Uploads signed/direct** avoids the edge request-body cap and keeps the app serverless (no
  byte-handling backend), consistent with the Studio app's presigned direct-to-bucket rule.
- **Views through BFFless** means a [[Site]]'s relative asset paths (`assets/app.js`,
  runtime `fetch()`) resolve same-origin with zero rewriting. A naive "iframe src = per-object
  signed URL" would 403 on every relative asset, because an S3/MinIO presigned URL signs one object
  via a query-string token that relative paths drop. Serving same-origin sidesteps that entirely.
- **Video is the exception** because large media wants native browser Range/seek and shouldn't be
  streamed through the backend; a direct presigned `GET` lets the browser talk to the bucket/CDN
  directly.

**Consequence.** Per-folder access control is enforced at two choke points the app controls: when
minting an upload URL, and on the view path (see ADR for ACL enforcement). BFFless's built-in
visibility is project/alias-wide only, so the per-folder [[Grant]] check is the app's own logic, not
BFFless deployment visibility.

**Security note — the Site iframe is intentionally same-origin and unsandboxed.** Because a [[Site]]
is served same-origin (so its relative asset paths and runtime `fetch()` resolve without rewriting),
the `<iframe>` rendering it is **not** given a `sandbox` attribute — an uploaded Site's JavaScript runs
with access to the app origin (cookies/session). This is **accepted for v1**: Handoff is an *internal,
permissioned* file server whose uploaders are trusted members of the same organization, and a Site is
only reachable by principals who already pass the folder ACL. `sandbox="allow-scripts"` would
re-introduce the relative-asset/`fetch()` breakage this ADR exists to avoid, so it is a real tradeoff,
not a free hardening. Revisit if Handoff ever hosts untrusted or cross-tenant uploads (e.g. serve Sites
from a separate origin/subdomain).
