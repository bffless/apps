# Handoff backend — BFFless proxy rule set

Handoff has no app server. Its `/api/*` endpoints are a **BFFless proxy rule set** (handler chains:
permissioned file listings, presigned uploads, folder management, access-control enforcement).
To run Handoff against your own BFFless project you import that rule set and attach it to the alias
serving the app.

`handoff.proxy-rules.json` will be exported here in **slice #14** (coming soon). It contains no
secrets — credentials are referenced by name or use the project's configured provider tokens.

## Import (once the JSON is available)

**Dashboard:** BFFless project → Proxy Rules → **Import** → upload `handoff.proxy-rules.json`.

**Claude / MCP:** ask Claude (with the BFFless MCP connected) to import
`apps/handoff/bffless/handoff.proxy-rules.json` into your project. It creates the `handoff` rule set
and all rules (IDs are remapped on import).

After import, **attach the `handoff` rule set to the alias** your deploy uploads to (e.g. the
`handoff` alias / `handoff.<your-domain>`). `/api/*` only serves on aliases the rule set is attached
to.

## Prerequisites (provision these in the target project first)

- **Storage backend** (default bucket) — Handoff stores uploaded files under a project-relative
  prefix (`<owner>/<repo>/handoff/…`), created on demand.
- **Auth** — Handoff uses BFFless cookie-based sessions (`/_bffless/auth/*`) for access control.
  Configure an admin login relay (see the BFFless auth docs) so the app can gate private files.
- **Data table** for folder/file metadata — added in slice #7 and referenced by the proxy rules.

## Portability

Proxy rule functions derive the storage prefix from deployment context:

```js
function handler({ request, deployment }) {
  var storagePath = deployment.owner + '/' + deployment.repo + '/handoff/' + key
}
```

So an import into `you/your-app` writes to `you/your-app/handoff/…` automatically — no per-project
edits needed.
