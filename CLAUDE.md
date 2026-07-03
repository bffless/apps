# CLAUDE.md

Guidance for Claude Code when working in the `bffless-apps` monorepo.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues (`bffless/apps`) via the `gh` CLI. External PRs are not a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary — `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Downloading admin.j5s.dev proxy-rules links

When the user passes a link of the form
`https://admin.j5s.dev/repo/bffless/apps/proxy-rules/<set-id>/<rule-id>`
(or any `admin.j5s.dev/...` download link), fetch it with **`curl` using the follow-redirect flag** (`curl -L`), not the WebFetch/fetch tool — the endpoint responds with a redirect that WebFetch does not follow, so fetch returns the wrong content.

```bash
curl -L "https://admin.j5s.dev/repo/bffless/apps/proxy-rules/<set-id>/<rule-id>" -o <file>.json
```
