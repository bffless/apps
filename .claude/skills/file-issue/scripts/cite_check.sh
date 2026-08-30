#!/usr/bin/env bash
# Verify every `path:line` citation in an issue draft against origin/main and print
# the cited line so you can eyeball it. A bare `:N` / `:N-M` after a cited path refers
# to that path (house shorthand: "`stage.mjs:223`, throw at `:224`").
# Draft format: line 1 `# <app>: title`, then body.
# Usage: cite_check.sh <draft.md>      exit 1 if any citation fails to resolve
set -uo pipefail
draft="${1:?usage: cite_check.sh <draft.md>}"
root=$(git rev-parse --show-toplevel) || exit 1
ref=origin/main
app=$(head -1 "$draft" | sed -nE 's/^# *([a-z0-9-]+):.*/\1/p')
scope=""
if [ -n "$app" ]; then
  git -C "$root" cat-file -e "$ref:apps/$app" 2>/dev/null && scope="apps/$app"
  git -C "$root" cat-file -e "$ref:packages/$app" 2>/dev/null && scope="packages/$app"
fi
# a "paths under apps/x/" declaration in the body wins over the title
decl=$(grep -oE 'paths under `?(apps|packages)/[a-z0-9-]+/?`?' "$draft" | head -1 | grep -oE '(apps|packages)/[a-z0-9-]+' || true)
[ -n "$decl" ] && scope="$decl"

fail=0; n=0; last=""
declare -A seen
# full citations `path:12`, `path:12-20`, `path:12,40`; bare shorthand `:12` in backticks
cites=$(grep -oE '[A-Za-z0-9_./-]+\.[A-Za-z0-9]+:[0-9]+([-,][0-9]+)*|`:[0-9]+([-,][0-9]+)*`' "$draft")
[ -z "$cites" ] && { echo "no path:line citations found — triage answers uncited claims itself"; exit 1; }
for c in $cites; do
  c="${c//\`/}"
  if [ "${c#:}" != "$c" ]; then
    [ -z "$last" ] && { echo "ORPHAN   $c   (bare :line with no preceding path)"; fail=1; continue; }
    path="$last"; lines="${c#:}"
  else
    path="${c%%:*}"; lines="${c#*:}"
  fi
  first="${lines%%[-,]*}"
  resolved=""
  for cand in "$path" "$scope/$path"; do
    [ -n "$cand" ] && git -C "$root" cat-file -e "$ref:$cand" 2>/dev/null && { resolved="$cand"; break; }
  done
  if [ -z "$resolved" ]; then echo "MISSING  $path:$lines   (not on $ref as '$path' or '$scope/$path')"; fail=1; continue; fi
  last="$path"
  key="$resolved:$lines"; [ -n "${seen[$key]:-}" ] && continue; seen[$key]=1
  n=$((n+1))
  total=$(git -C "$root" show "$ref:$resolved" | wc -l)
  if [ "$first" -gt "$total" ]; then echo "SHORT    $key   ($resolved has $total lines)"; fail=1; continue; fi
  text=$(git -C "$root" show "$ref:$resolved" | sed -n "${first}p" | sed 's/^[[:space:]]*//' | cut -c1-90)
  echo "OK       $key   | $text"
done
echo; echo "$n citation(s) checked against $ref $(git -C "$root" rev-parse --short $ref)"
exit $fail
