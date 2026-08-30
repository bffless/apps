/**
 * The driver as a library — `cli.ts` is deliberately not re-exported: importing
 * it would run its main-module guard's side effects.
 */
export { Report, exitCodeOf, toMarkdown, writeReport, type WalkReport, type Check } from './report.js'
export { parseWalkArgs, UsageError, USAGE, type WalkArgs } from './args.js'
export { credentials, adminKey } from './env.js'
export { openSession, classify, type Session } from './session.js'
export { WALKS, ALL_ORDER, type Walk, type WalkContext } from './walks/index.js'
