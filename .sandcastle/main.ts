import { run, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

// Single-shot loop: the agent picks one ready GitHub issue, implements it on its
// own branch, pushes, and opens a PR (it does NOT merge — see prompt.md). The PR
// triggers the existing preview-*.yml workflows, which deploy to the shared
// handoff-preview / studio-preview alias for a live preview URL.
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

  // One issue per run: single issue → single branch → single PR. Keeps the
  // PR-per-issue mapping clean. Raise once the flow is proven if you want the
  // agent to chew through several ready issues back-to-back.
  maxIterations: 1,

  // Branch strategy — "branch" lands the agent's commits on a named branch and
  // never merges to HEAD, so your local `main` is untouched (honours the
  // workspace CLAUDE.md "ask before committing / no merge to main" rule). The
  // agent itself creates a per-issue branch, pushes it, and opens the PR from
  // inside the sandbox (see prompt.md). "branch" is valid with copyToWorktree;
  // only "head" mode is incompatible.
  branchStrategy: { type: "branch", branch: "sandcastle/work" },

  // Copy node_modules from the host into the worktree before the sandbox starts,
  // so the pnpm install below is a fast reconcile rather than a cold install.
  copyToWorktree: ["node_modules"],

  // Lifecycle hooks — commands grouped by where they run (host or sandbox).
  hooks: {
    sandbox: {
      // onSandboxReady runs once after the sandbox is initialised and the repo is
      // synced in, before the agent starts. This is a pnpm workspace, so reconcile
      // deps with pnpm (the image has pnpm@10.33.0 via corepack). --frozen-lockfile
      // is fast when the copied node_modules already matches the lockfile.
      onSandboxReady: [{ command: "pnpm install --frozen-lockfile" }],
    },
  },
});
