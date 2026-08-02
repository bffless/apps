/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const setRoot = resolve(process.cwd(), '.bffless/proxy-rules/reader')

type Schema = { name: string; fields: Array<{ name: string; type: string; required?: boolean }> }

function schema(file: string): Schema {
  return parse(readFileSync(resolve(setRoot, 'schemas/' + file), 'utf8')) as Schema
}

function field(s: Schema, name: string) {
  const f = s.fields.find((x) => x.name === name)
  if (!f) throw new Error('missing field ' + name + ' on ' + s.name)
  return f
}

describe('per-user schema columns', () => {
  it('reader_feeds carries an owner and a per-user dedup column', () => {
    const s = schema('reader_feeds.schema.yaml')
    expect(field(s, 'userId').type).toBe('string')
    expect(field(s, 'scopedUrl').type).toBe('string')
  })

  it('reader_items carries an owner and a per-user dedup column', () => {
    const s = schema('reader_items.schema.yaml')
    expect(field(s, 'userId').type).toBe('string')
    expect(field(s, 'scopedGuid').type).toBe('string')
  })

  it('the new columns are optional so live rows stay writable pre-backfill', () => {
    const feeds = schema('reader_feeds.schema.yaml')
    const items = schema('reader_items.schema.yaml')
    expect(field(feeds, 'userId').required).toBeFalsy()
    expect(field(feeds, 'scopedUrl').required).toBeFalsy()
    expect(field(items, 'userId').required).toBeFalsy()
    expect(field(items, 'scopedGuid').required).toBeFalsy()
  })
})

import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const rulesRoot = resolve(setRoot, 'rules')

// Handlers that read or write reader data, and therefore must be scoped to the caller.
const DATA_HANDLERS = new Set([
  'data_query',
  'db_aggregate',
  'data_update',
  'data_delete',
  'data_upsert_many',
])

// Steps that legitimately run with no userId filter. Both are fired by a
// pipeline_schedule as a USERLESS system run, where `user.id` resolves to null:
//   api/refresh/post:feeds — the cron must read EVERY user's feeds to ingest for them
//   api/prune/post:del     — retention filters each row's own read/starred/archived/
//                            fetchedAt, which is already correct per-user
// Everything else in this list is debt this change removes, one task at a time.
// When only the two entries above remain, per-user scoping is complete.
const EXPECTED_UNSCOPED = new Set<string>([
  'api/refresh/post:feeds',
  'api/prune/post:del',

  // Task 6
  'api/items/delete/post:del',
  'api/items/read-all/post:folderFeeds',
  'api/items/read-all/post:updAll',
  'api/items/read-all/post:updStarred',
  'api/items/read-all/post:updFeed',
  'api/items/read-all/post:updFolder',

  // Task 7
  'api/feeds/post:upsert',
  'api/feeds/remove/post:query',
  'api/feeds/remove/post:delItems',
  'api/feeds/folder/post:query',

  // Task 8
  'api/refresh/post:upsert',
])

type Step = { id: string; handler?: string; code?: string; config?: Record<string, unknown> }
type Rule = { pipeline?: { steps?: Step[] } }
type FoundStep = { key: string; handler: string; config: Record<string, unknown> }

function ruleFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) ruleFiles(full, out)
    else if (entry.endsWith('.rule.yaml') || entry === 'rule.yaml') out.push(full)
  }
  return out
}

// "rules/api/items/get/rule.yaml" -> "api/items/get"
// "rules/api/feeds/get.rule.yaml" -> "api/feeds"
function ruleKey(file: string): string {
  const rel = relative(rulesRoot, file).split('\\').join('/')
  const base = rel.substring(0, rel.lastIndexOf('/'))
  return base === '' ? rel.replace(/\.rule\.yaml$/, '') : base
}

function dataSteps(): FoundStep[] {
  const found: FoundStep[] = []
  for (const file of ruleFiles(rulesRoot)) {
    const rule = parse(readFileSync(file, 'utf8')) as Rule
    for (const step of rule.pipeline?.steps ?? []) {
      if (!step.handler || !DATA_HANDLERS.has(step.handler)) continue
      found.push({
        key: ruleKey(file) + ':' + step.id,
        handler: step.handler,
        config: step.config ?? {},
      })
    }
  }
  return found
}

function isScoped(step: FoundStep): boolean {
  if (step.handler === 'data_upsert_many') {
    const map = step.config.map as Record<string, unknown> | undefined
    return typeof map?.userId === 'string' && map.userId.length > 0
  }
  // A step acting on a single recordId inherits its scoping from the query that
  // produced that id — data_update/data_delete ignore `filters` entirely when
  // `recordId` is set (ce: data-update.handler.ts:91), so a userId filter here
  // would be dead code. The paired `query` step is what must carry the filter,
  // and it is listed separately below.
  if (typeof step.config.recordId === 'string' && step.config.recordId.length > 0) return true
  const filters = step.config.filters as
    | Record<string, { op?: string; value?: unknown }>
    | undefined
  const f = filters?.userId
  return f?.op === 'eq' && f?.value === 'user.id'
}

describe('rule set scoping ratchet', () => {
  it('finds every data-access step in the set', () => {
    // Guards the walker itself: if a rule file stops being discovered, the
    // scoping assertions below would pass vacuously. 37 = 32 filter/aggregate/
    // upsert steps + 5 recordId steps.
    expect(dataSteps().length).toBe(37)
  })

  it('only the expected steps are unscoped', () => {
    const unscoped = dataSteps()
      .filter((s) => !isScoped(s))
      .map((s) => s.key)
      .sort()
    expect(unscoped).toEqual([...EXPECTED_UNSCOPED].sort())
  })

  it('every multi-filter step declares filterLogic: and', () => {
    const bad = dataSteps()
      .filter((s) => {
        const filters = (s.config.filters ?? {}) as Record<string, unknown>
        return Object.keys(filters).length > 1 && s.config.filterLogic !== 'and'
      })
      .map((s) => s.key)
      .sort()
    expect(bad).toEqual([])
  })
})
