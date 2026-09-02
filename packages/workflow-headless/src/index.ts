/**
 * The driver as a library — what a wrapper (the `bffless/run-workflow` Action,
 * a test harness) needs without going through argv. `cli.ts` is deliberately
 * not re-exported: importing it would run its main-module guard's side effects.
 */
export { pageApi, type ApiLike, type ApiOptions, type JsonResponse } from './api.js'
export {
  downloadOutputs,
  extensionFor,
  fileOutputs,
  writeConsoleLog,
  writeRunRecord,
  writeStepsLog,
  type DownloadResult,
  type OutputFile,
} from './artifacts.js'
export { launchBrowser, type LaunchOptions } from './browser.js'
export {
  fetchDefinition,
  publishedPath,
  workflowId,
  type Definition,
  type WorkflowListing,
} from './discover.js'
export { DriverError, EXIT, type ExitCode } from './errors.js'
export { loginViaRelay, type Credentials } from './login.js'
export {
  formatTransition,
  readGlobal,
  TERMINAL,
  waitForStart,
  waitForTerminal,
  type Snapshot,
  type Transition,
  type WatchOptions,
} from './observe.js'
export type { BrowserLike, ConsoleMessageLike, PageLike } from './page.js'
export {
  PageToolError,
  WORKFLOW_PAGE_TOOLS,
  callPageTool,
  canonicalPageToolName,
  listPageTools,
  resultText,
  waitForPageTools,
  type PageToolInfo,
  type PageToolResult,
} from './pageTools.js'
export {
  encodeInputs,
  runWorkflow,
  startUrl,
  waitForSealedRecord,
  type RunDeps,
  type RunOptions,
  type RunReport,
} from './run.js'
export { formatRunsTable, listRuns, toRunRows, type RunRow } from './runs.js'
export {
  contentTypeFor,
  nodeUploadDeps,
  toFileRef,
  uploadFileInputs,
  uploadOne,
  type FileRef,
  type InputDecl,
  type UploadContext,
  type UploadDeps,
} from './upload.js'
export {
  credentialsFromEnv,
  loadInputs,
  parseArgs,
  parseDuration,
  UsageError,
  USAGE,
  type Command,
  type RunCommand,
  type RunsCommand,
} from './args.js'
