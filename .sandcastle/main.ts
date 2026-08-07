import { run, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

// Single-shot loop: the agent picks one ready GitHub issue, implements it on its
// own branch, pushes, and opens a PR (it does NOT merge — see prompt.md). For Studio
// the PR triggers preview-studio.yml, which deploys to the shared studio-preview alias
// for a live preview URL; Handoff has no preview workflow (it ships via the app
// catalog, not from this repo), so Handoff PRs are verified locally only.
// Run this with: npm run sandcastle  (alias for: npx tsx .sandcastle/main.ts)

await run({
  // A name for this run, shown as a prefix in log output.
  name: "worker",

  // Sandbox provider — runs the agent inside an isolated container.
  sandbox: docker(),

  // The agent provider. Pass a model string to claudeCode(). Opus 4.8 is the
  // current top model; drop to claude-sonnet-4-6 for cheaper/faster runs.
  // Usage bills against CLAUDE_CODE_OAUTH_TOKEN (your Claude subscription).
  agent: claudeCode("claude-opus-4-8"),

  // Path to the prompt file. Shell expressions inside are evaluated inside the
  // sandbox at the start of each iteration, so the agent always sees fresh data.
  promptFile: "./.sandcastle/prompt.md",

  // Issues per run. Each iteration = one issue → one branch → one PR. Set >1 to
  // chew through several ready issues back-to-back UNATTENDED — but this only
  // makes sense in EPIC MODE (an open PR labelled `epic` exists), because epic
  // mode closes each issue on land, which unblocks the next story in the chain.
  // In legacy mode (no epic) issues are never closed, so a value >1 would just
  // re-pick the same top issue every iteration. See prompt.md "Starting an epic".
  maxIterations: 10,

  // Branch strategy — "branch" lands the agent's commits on a named branch and
  // never merges to HEAD, so your local `main` is untouched (honours the
  // workspace CLAUDE.md "ask before committing / no merge to main" rule). The
  // agent itself creates a per-issue branch, pushes it, and opens the PR from
  // inside the sandbox (see prompt.md).
  branchStrategy: { type: "branch", branch: "sandcastle/work" },

  // NOTE: we deliberately do NOT copyToWorktree node_modules. The host's
  // node_modules is created with the host pnpm store path (/home/rico/...), which
  // doesn't exist in the container — so pnpm treats it as incompatible and tries
  // to purge+reinstall, which aborts non-interactively
  // (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY). A clean install in the container
  // is correct; the cold-install cost can be optimised later (e.g. a warm pnpm
  // store baked into the image or a persistent store volume).

  // Lifecycle hooks — commands grouped by where they run (host or sandbox).
  hooks: {
    sandbox: {
      // onSandboxReady runs once after the sandbox is initialised and the repo is
      // synced in, before the agent starts.
      onSandboxReady: [
        // Wire the j5s-dev (BFFless) MCP into the sandbox agent by writing a
        // repo-root .mcp.json that Claude Code auto-loads on startup.
        //
        // SECURITY: write the LITERAL placeholder ${BFFLESS_API_KEY}, never the
        // resolved key. Claude Code expands ${BFFLESS_API_KEY} from the sandbox
        // env (.sandcastle/.env) at load time — so the file on disk only ever
        // holds the placeholder string. A previous version baked the real key in
        // with printf %s; because .mcp.json was a *tracked* file on the epic branch
        // (whose .gitignore lacked an entry), `git add -A` swept the live key into
        // PR #134 (key since revoked). With the placeholder, an accidental commit
        // exposes nothing. The guard still fails the run loudly if the env var is
        // missing (Claude Code would otherwise have nothing to expand).
        //
        // Inline (not a checked-in template) on purpose: a checked-in ROOT
        // .mcp.json is auto-loaded by a cloner's Claude Code and would import into
        // the maintainers' admin.j5s.dev (#96); and the synced base branch may lag
        // main, so a `cp` from a committed file isn't reliably present.
        {
          command:
            "[ -n \"$BFFLESS_API_KEY\" ] || { echo \"BFFLESS_API_KEY not set in sandbox env\" >&2; exit 1; }; printf '%s' '{\"mcpServers\":{\"j5s-dev\":{\"type\":\"http\",\"url\":\"https://admin.j5s.dev/mcp\",\"headers\":{\"X-API-Key\":\"${BFFLESS_API_KEY}\"}}}}' > .mcp.json",
        },
        // Belt-and-suspenders: ignore .mcp.json via the sandbox's LOCAL git exclude,
        // which applies no matter what the (possibly stale) base branch's committed
        // .gitignore contains — so it can never be staged by `git add -A`, even on a
        // branch that forgot the .gitignore entry (which is how #134 slipped through).
        {
          command:
            "GITX=$(git rev-parse --git-path info/exclude 2>/dev/null); if [ -n \"$GITX\" ] && ! grep -qxF .mcp.json \"$GITX\" 2>/dev/null; then echo .mcp.json >> \"$GITX\"; fi",
        },
        // Clean pnpm install from the lockfile (image has pnpm@10.33.0 via
        // corepack). CI=true keeps pnpm fully non-interactive (no purge/confirm
        // prompts, which abort without a TTY).
        { command: "CI=true pnpm install --frozen-lockfile" },
      ],
    },
  },
});
