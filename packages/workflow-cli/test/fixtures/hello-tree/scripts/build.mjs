#!/usr/bin/env node
// Excerpt of workflow-hello's scripts/build.mjs, trimmed for the workflow-cli
// rename-engine fixture (test/rewrite.test.ts) — just enough of the real
// build.mjs (workflow-implementations workflows/hello/scripts/build.mjs) to
// exercise the `--impl` default and the rule-set path/prefix strings the
// rename engine's Decision-6 inventory calls out.
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)

function flagValue(name, fallback) {
  const idx = args.indexOf(name)
  if (idx === -1) return fallback
  return args[idx + 1] ?? fallback
}

const impl = flagValue('--impl', 'hello')
const name = flagValue('--name', 'Hello')

execFileSync(
  'workflow',
  [
    'index',
    '.bffless/workflows',
    '--out',
    'dist',
    '--impl',
    impl,
    '--name',
    name,
    '--rules',
    '.bffless/proxy-rules/hello',
    '--path-prefix',
    '/api/hello',
  ],
  { stdio: 'inherit' },
)
