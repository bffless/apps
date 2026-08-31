import { readFileSync } from 'node:fs'

/**
 * This package's own version, read from its `package.json` rather than
 * hand-duplicated — `--version` and the npm number can never drift. Resolved
 * relative to this module (not `process.cwd()`), so it is unaffected by where
 * the CLI is invoked from: at `dist/version.js`, `../package.json` is the
 * package root's manifest whether run via the `workflow` bin or `node
 * dist/cli.js` directly.
 */
export function readVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
  return pkg.version
}
