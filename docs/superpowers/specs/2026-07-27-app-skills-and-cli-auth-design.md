# App Skills Collection + BFFless CLI Auth — Design

**Date:** 2026-07-27
**Status:** Approved (design), pending implementation
**Repos touched:** `bffless/ce` (CLI), `bffless/apps` (this repo)

## Problem

Two coupled problems:

1. The `handoff-api` skill is useful beyond this monorepo — the apps are give-away
   apps deployed on other people's BFFless projects — but today it is a private
   authored skill (`.claude/skills/handoff-api/`) hardcoded to `handoff.j5s.dev`.
   It also does not belong in `bffless/skills`, which documents the platform, not
   apps built on it.
2. The skill's auth story is a hack: it scrapes a BFFless API key out of the
   agent runtime's MCP configuration (`~/.claude.json`). That is fragile,
   runtime-specific, and useless to a third party on a fresh machine. The
   objection is the **grant path**, not key privilege (over-privilege is
   explicitly out of scope).

## Decisions (from brainstorming)

- The public skill targets **anyone's Handoff deployment** — parameterized, not
  pinned to j5s.dev.
- The collection lives **inside `repos/apps`** (this monorepo), packaged like
  `bffless/skills` (Claude plugin marketplace + `skills`-CLI compatible).
- Auth fix: **`bffless login` paste-a-key flow + credential store** in the CE
  CLI. No CE server changes. A browser/device-code flow is a designed-for
  follow-up that would write into the same store; it is not part of this work.
- One-time interactive setup per machine is acceptable; `BFFLESS_API_KEY` env
  remains the non-interactive/CI path and keeps precedence over the store.

## Part 1: CLI auth (`repos/ce/packages/cli`)

### New commands

| Command | Behavior |
| --- | --- |
| `bffless login [--api-url <url>]` | Resolve `apiUrl` (flag > `.bffless/config.json` walk-up; error if neither). Print instructions to create an API key in the admin UI (`<apiUrl>` → Settings → API Keys). Read the key from stdin with hidden input. **Validate it** with a real authenticated API call before saving (a cheap read endpoint the CLI already calls, e.g. the rule-set list used by `pull` — final choice at implementation). Store on success; re-login overwrites the entry. |
| `bffless logout [--api-url <url>]` | Remove the resolved instance's entry from the store. |
| `bffless auth status` | List stored instances: URL, key prefix (e.g. `bfl_ab12…`, never the full key), and whether each key still validates against its instance. |
| `bffless auth token [--api-url <url>]` | Print the stored key for the resolved instance to stdout (nothing else — pipe-safe). Exit 1 with remediation if absent. |

### Credential store

- Path: `$XDG_CONFIG_HOME/bffless/credentials.json`, defaulting to
  `~/.config/bffless/credentials.json`.
- Written atomically (temp file + rename), file mode `0600`.
- Format:

```json
{
  "version": 1,
  "credentials": {
    "https://admin.j5s.dev": { "apiKey": "…", "createdAt": "2026-07-27T00:00:00Z" }
  }
}
```

- Keyed by **normalized apiUrl** (trailing slash stripped, lowercased host).

### Resolution chain change (`src/api/client.ts`)

Current: `--api-key` flag > `BFFLESS_API_KEY` env — and nothing else.

New: `--api-key` flag > `BFFLESS_API_KEY` env > **credential store lookup by the
resolved apiUrl**. Env keeps precedence over the store so CI behavior is
unchanged. The existing invariant is preserved in spirit and letter: API keys
are still **never** read from `.bffless/config.json` or any repo-committed file.
All existing commands (`push`, `pull`, `sync`, `revisions`, `rollback`, …) pick
up the store automatically through `client.ts`; remediation text
(`src/api/remediation.ts`) is updated to mention `bffless login`.

### Error handling

- `login` with an invalid or unreachable key/instance: validation fails →
  clear error, **nothing stored**.
- Corrupt `credentials.json`: hard error naming the path (matching
  `config.ts`'s stance — an existing-but-broken file is never silently treated
  as absent).
- `auth token` with no entry: exit 1, remediation text: run `bffless login`,
  or set `BFFLESS_API_KEY`.

### Out of scope (deliberate)

Browser/device-code flow, key scoping, OS keychain integration, multiple keys
per instance.

## Part 2: Public collection in `repos/apps`

### Layout (new)

```
repos/apps/
  .claude-plugin/marketplace.json      # marketplace "bffless-apps-plugins"
  plugins/bffless-apps/
    .claude-plugin/plugin.json         # plugin "bffless-apps", version
    skills/
      handoff-api/SKILL.md             # canonical home (moves from .claude/skills/)
```

### Install paths (third parties)

- `npx skills add bffless/apps` — the `skills` CLI discovers
  `plugins/bffless-apps/skills/*/SKILL.md`.
- Claude Code plugin marketplace — add the repo, install plugin `bffless-apps`.

Identical consumption pattern to `bffless/skills`.

### Local dual-homing

`scripts/sync-skills.mjs` gains a second category, **published** skills:
canonical under `plugins/bffless-apps/skills/`, fanned out as byte-identical
real-file copies into both `.claude/skills/<name>/` and `.agents/skills/<name>/`
(same mechanism as today's authored skills, one more source root). The derived
set logic stays: vendored = in `skills-lock.json`; published = under the plugin
dir; authored = real dirs in `.claude/skills/` in neither set.
`skills-parity.yml` CI continues to enforce drift-free copies via `--check`.

### Scope & versioning

- Only `handoff-api` graduates now. `install-app` and other authored skills stay
  private; reader/studio skills can graduate later by moving their canonical
  copy into the plugin dir.
- `plugin.json` version is bumped manually when a published skill changes. No
  release-please for the plugin (the monorepo has its own release story;
  `skills`-CLI installs pin by content hash).

## Part 3: `handoff-api` skill rewrite

Endpoint documentation (prepare → PUT → register, folders, sign, share-links,
delete, gotchas) is already deployment-agnostic and stays as-is. Changes:

- **Base URL** — de-hardcode `handoff.j5s.dev`. Resolution order the skill
  instructs: (1) `HANDOFF_BASE_URL` env var; (2) ask the user / take from
  context. All examples use `$HANDOFF_BASE_URL/api/…`.
- **Auth** — the MCP-config scrape is deleted entirely. Two documented paths:
  1. `BFFLESS_API_KEY` env (CI/sandbox path, unchanged);
  2. CLI credential store: `curl -H "X-API-Key: $(npx bffless auth token)" …`
     after a one-time `npx bffless login`. Inside a cloned app repo,
     `auth token` resolves the instance from `.bffless/config.json`
     automatically; elsewhere pass `--api-url`.
  If neither path yields a key, the skill directs the agent to tell the user to
  run `bffless login` — never to hunt through runtime config files.
- **Discovery** — reworded clone-relative: "if you're in a Handoff repo clone,
  the authored rules under `.bffless/proxy-rules/handoff*/` are the endpoint
  source of truth"; MCP `get_proxy_rule_set` stays as an optional extra.
- **Frontmatter** — description says "a Handoff deployment", not "this
  project's Handoff app".
- **Min CLI version** — the skill states the minimum `bffless` npm version that
  includes `auth token` (filled in at release time).

## Testing

- **CLI (Vitest, existing `packages/cli` patterns):** store round-trip +
  `0600` perms; resolution precedence (flag > env > store); login validation
  happy/reject paths (reject → nothing stored); corrupt-store hard error;
  `auth token` output purity and missing-entry remediation. Client tests assert
  the store is consulted only when flag and env are both absent.
- **Apps:** `sync-skills.mjs --check` covers the plugin source root; enforced
  by `skills-parity.yml`.
- **End-to-end (manual):** against `handoff.j5s.dev` — `bffless login` →
  `auth token` → list nodes → one upload round-trip (prepare → PUT →
  register), following the rewritten skill's instructions verbatim.

## Rollout order

Hard dependency: the skill references CLI features that must be released first.

1. CE PR: auth commands + store + `client.ts` resolution + remediation text +
   tests + CLI README.
2. CE release → `bffless` npm publish via CI. Record the released version as
   the skill's min CLI version.
3. Apps PR: plugin/marketplace structure, skill move + rewrite, sync-script
   extension, README note on installing the collection.
4. Live smoke test (above). Collection is then announceable.
