/**
 * Library barrel. `@bffless/workflow` is primarily consumed as the `workflow`
 * bin (`src/cli.ts`), but a caller embedding it programmatically gets the
 * same delegated entry points the CLI itself uses, plus the package's own
 * version.
 */
export { buildIndex, lintFile } from '@bffless/workflow-lint'
export { readVersion } from './version.js'
