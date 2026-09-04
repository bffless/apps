import type { WalkArgs } from '../args.js'
import type { Report } from '../report.js'
import { m1 } from './m1.js'
import { interactive } from './interactive.js'
import { hello } from './hello.js'
import { headless } from './headless.js'
import { studioAudit } from './studio-audit.js'
import { studioHeadless } from './studio-headless.js'
import { pageTools } from './page-tools.js'
import { mcp } from './mcp.js'
import { mcpApp } from './mcp-app.js'
import { oauth } from './oauth.js'

export interface WalkContext { args: WalkArgs; env: NodeJS.ProcessEnv; report: Report }
export type Walk = (ctx: WalkContext) => Promise<void>

export const ALL_ORDER = ['hello', 'headless', 'studio-audit', 'studio-headless'] as const

export const WALKS: Record<string, Walk> = { m1, interactive, hello, headless, 'studio-audit': studioAudit, 'studio-headless': studioHeadless, 'page-tools': pageTools, mcp, 'mcp-app': mcpApp, oauth }
