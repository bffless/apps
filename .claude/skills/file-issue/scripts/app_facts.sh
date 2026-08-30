#!/usr/bin/env bash
# Derive, from origin/main, the facts an issue body needs for one app or package:
# verify scripts + CI order, which workflows deploy it and on which trigger, decision
# records, rule-set / schema directories, and whether its label exists.
# Usage: app_facts.sh <app-or-package>   (run anywhere inside the bffless/apps checkout)
set -uo pipefail
app="${1:?usage: app_facts.sh <app-or-package>}"
root=$(git rev-parse --show-toplevel) || exit 1
cd "$root"
ref=origin/main
git fetch origin --prune -q 2>/dev/null || true
sha=$(git rev-parse --short "$ref")
echo "origin/main: $sha"

if git cat-file -e "$ref:apps/$app" 2>/dev/null; then scope="apps/$app"
elif git cat-file -e "$ref:packages/$app" 2>/dev/null; then scope="packages/$app"
else echo "no apps/$app or packages/$app on $ref — apps: $(git ls-tree --name-only "$ref" apps/ | sed 's#apps/##' | tr '\n' ' ') packages: $(git ls-tree --name-only "$ref" packages/ | sed 's#packages/##' | tr '\n' ' ')"; exit 1; fi
echo "scope: $scope"

echo
echo "## root scripts for $app (package.json on $ref)"
git show "$ref:package.json" | node -e '
const s = JSON.parse(require("fs").readFileSync(0, "utf8")).scripts || {};
const app = process.argv[1];
const mine = Object.keys(s).filter(k => k.startsWith(app + ":"));
if (!mine.length) console.log("  (none — a package may only have its own package.json scripts)");
for (const k of mine) console.log("  pnpm " + k);
const order = ["lint", "stage", "build", "typecheck", "test"].map(x => app + ":" + x).filter(x => s[x]);
if (order.length) console.log("\n  suggested chain (verify ends with build; stage before test):\n  " + order.map(x => "pnpm " + x).join(" && "));
const extra = [];
if (s["apps:check"]) extra.push("pnpm apps:check   # anything under apps/** or .bffless/**");
if (s["workflow-lint:build"] && /^workflow/.test(app)) extra.push("pnpm workflow-lint:build && pnpm workflow-lint:test   # workflow spec / schema edits");
if (s["skills:check"]) extra.push("pnpm skills:check   # only if .claude/skills/** changes");
if (extra.length) console.log("\n  extra gates when relevant:\n  " + extra.join("\n  "));
' "$app"

echo
echo "## workflows that name this scope, with their pnpm steps in CI order"
for wf in $(git ls-tree --name-only "$ref" .github/workflows/); do
  body=$(git show "$ref:$wf")
  echo "$body" | grep -q "$scope" || continue
  trig=$(echo "$body" | awk '/^on:/{p=1;next} p&&/^[^ ]/{p=0} p' | grep -oE '^  (pull_request|push|workflow_dispatch|schedule)' | tr -d ' ' | sort -u | tr '\n' ',' | sed 's/,$//')
  echo "- $wf  [triggers: ${trig:-?}]"
  echo "$body" | grep -E '^\s*(- )?(run: )?pnpm ' | sed -E 's/^\s*(- )?(run: )?/    /' | head -14
done

echo
echo "## live surfaces (checklist §1) — who deploys $scope, and when"
for wf in $(git ls-tree --name-only "$ref" .github/workflows/ | grep -E 'deploy-|preview-|publish-'); do
  body=$(git show "$ref:$wf")
  echo "$body" | grep -qE "$scope|$app" || continue
  trig=$(echo "$body" | awk '/^on:/{p=1;next} p&&/^[^ ]/{p=0} p' | grep -oE '^  (pull_request|push|workflow_dispatch)' | tr -d ' ' | sort -u | tr '\n' ',' | sed 's/,$//')
  case "$trig" in
    *pull_request*) when="ON PR OPEN (a real write — say so in the body)";;
    *push*) when="on merge to main only";;
    *) when="manual (workflow_dispatch) only";;
  esac
  echo "- $wf → $when  [triggers: $trig]"
done
[ -n "$(git ls-tree --name-only "$ref" .github/workflows/ | grep -E 'deploy-|preview-' | xargs -I{} sh -c "git show $ref:{} | grep -lE '$scope|$app' >/dev/null && echo x")" ] || echo "- no deploy/preview workflow names this scope (handoff ships via catalog install; packages publish separately)"

echo
echo "## rule sets and schemas (authored layout; pruned on deploy — add, don't rename)"
git ls-tree -d --name-only "$ref" "$scope/.bffless/proxy-rules/" 2>/dev/null | sed 's/^/  /' || true
git ls-tree -r --name-only "$ref" "$scope/.bffless/" 2>/dev/null | grep -E 'schemas?/.*\.(ya?ml|json)$' | sed 's/^/  schema: /' || true
[ -z "$(git ls-tree --name-only "$ref" "$scope/.bffless/" 2>/dev/null)" ] && echo "  (no .bffless/ layout — no live rule surface)"

echo
echo "## decision records to read before deciding anything"
for p in "$scope/CLAUDE.md" "$scope/README.md" "$scope/bffless/README.md" "$scope/docs/adr" "$scope/docs/spec" CONTEXT.md docs/adr; do
  git cat-file -e "$ref:$p" 2>/dev/null && echo "  $p"
done

echo
echo "## labels (gh label list)"
if labels=$(gh label list --repo bffless/apps --limit 100 --json name --jq '.[].name' 2>/dev/null); then
  echo "$labels" | grep -qx "$app" && echo "  app label '$app' exists" || echo "  no '$app' label — file with the category label only; report the gap, never create a label"
  echo "  categories: $(echo "$labels" | grep -xE 'bug|enhancement|documentation|question' | tr '\n' ' ')"
else
  echo "  gh unavailable — check labels by hand"
fi
