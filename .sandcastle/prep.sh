#!/usr/bin/env sh
# Keep the Sandcastle base branch current before each run.
#
# `sandcastle/work` (see branchStrategy in main.ts) is only the base the sandbox
# worktree is created from — the agent lands real work on per-issue branches +
# PRs, never on this branch, so resetting it loses nothing. Sandcastle never
# advances it from main on its own: on reuse it only fast-forwards from
# `origin/sandcastle/work` (which doesn't exist here), so without this reset the
# branch silently rots behind main (it was frozen 41 commits back at #49 until
# we added this). Base defaults to `main`; override with SANDCASTLE_BASE.
set -e

BASE="${SANDCASTLE_BASE:-main}"

# Prune bookkeeping for any worktree dir that was deleted out from under git,
# then force-remove a leftover worktree from a crashed run so the branch isn't
# still "checked out" (which would block the reset below). Both are best-effort.
git worktree prune || true
git worktree remove --force .sandcastle/worktrees/sandcastle-work 2>/dev/null || true

git branch -f sandcastle/work "$BASE"
echo "sandcastle/work reset to $BASE ($(git rev-parse --short "$BASE"))"
