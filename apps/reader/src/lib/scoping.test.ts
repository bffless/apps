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
