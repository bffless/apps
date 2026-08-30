import type { WalkArgs } from '../args.js'
import type { Report } from '../report.js'
import { m1 } from './m1.js'
import { interactive } from './interactive.js'

export interface WalkContext { args: WalkArgs; env: NodeJS.ProcessEnv; report: Report }
export type Walk = (ctx: WalkContext) => Promise<void>

export const ALL_ORDER = ['hello', 'headless', 'studio-audit', 'studio-headless'] as const

export const WALKS: Record<string, Walk> = { m1, interactive }
