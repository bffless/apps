/**
 * The auto-start half of the page contract (07/D12): how `?inputs=` is read,
 * and the one validation loop the form and the driver share.
 */
import { describe, expect, it } from 'vitest'
import type { InputDef } from '@bffless/workflow-lint/definition'
import { decodeInputs, initialValues, validateInputs } from './autoStart'

/** What a driver writes into the URL: base64url of the JSON, unpadded. */
function encode(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const HELLO_INPUTS: Record<string, InputDef> = {
  greeting: { type: 'string', default: 'Hello', required: true } as InputDef,
  names: { type: 'choice', options: ['world', 'studio'], list: true, default: ['world'] } as InputDef,
  photo: { type: 'file' } as InputDef,
  shout: { type: 'boolean', default: false } as InputDef,
}

describe('decodeInputs', () => {
  it('decodes base64url JSON into the values object', () => {
    const decoded = decodeInputs(encode({ greeting: 'Hi', shout: true }))
    expect(decoded).toEqual({ ok: true, values: { greeting: 'Hi', shout: true } })
  })

  it('decodes the empty object (`e30`), the no-inputs case', () => {
    expect(decodeInputs('e30')).toEqual({ ok: true, values: {} })
  })

  it('accepts the url-safe alphabet, padded or not', () => {
    // The payload whose standard base64 (`eyJhIjoiPz4/PiIsImIiOiJ+fn5+In0=`)
    // carries a `+`, a `/` *and* padding — all three things base64url renames.
    const values = { a: '?>?>', b: '~~~~' }
    const urlSafe = 'eyJhIjoiPz4_PiIsImIiOiJ-fn5-In0'
    expect(decodeInputs(urlSafe)).toEqual({ ok: true, values })
    expect(decodeInputs(`${urlSafe}=`)).toEqual({ ok: true, values })
  })

  it('decodes non-ASCII values as UTF-8, not Latin-1', () => {
    // `{"greeting":"Olá ☕"}` encoded as UTF-8 bytes.
    expect(decodeInputs('eyJncmVldGluZyI6Ik9sw6Eg4piVIn0=')).toEqual({
      ok: true,
      values: { greeting: 'Olá ☕' },
    })
  })

  it('reports bad base64url as an error rather than throwing', () => {
    const decoded = decodeInputs('not base64!!')
    expect(decoded.ok).toBe(false)
    if (!decoded.ok) expect(decoded.error).toMatch(/base64url/)
  })

  it('reports JSON that does not parse', () => {
    const decoded = decodeInputs(btoa('{nope'))
    expect(decoded.ok).toBe(false)
    if (!decoded.ok) expect(decoded.error).toMatch(/JSON/)
  })

  it.each([
    ['an array', '[1,2]'],
    ['null', 'null'],
    ['a number', '42'],
    ['a string', '"hello"'],
  ])('reports %s as an error — the payload must be an object', (_label, json) => {
    const decoded = decodeInputs(btoa(json))
    expect(decoded.ok).toBe(false)
    if (!decoded.ok) expect(decoded.error).toMatch(/object/)
  })

  it('reports a missing parameter rather than assuming no inputs', () => {
    for (const param of [null, undefined, '']) {
      const decoded = decodeInputs(param)
      expect(decoded.ok).toBe(false)
      if (!decoded.ok) expect(decoded.error).toMatch(/inputs/)
    }
  })
})

describe('initialValues', () => {
  it('fills every declared input from the definition defaults', () => {
    expect(initialValues(HELLO_INPUTS, {})).toEqual({
      greeting: 'Hello',
      names: ['world'],
      photo: null,
      shout: false,
    })
  })

  it('lets a supplied value win over the default, and drops undeclared keys', () => {
    expect(initialValues(HELLO_INPUTS, { greeting: 'Hi', sneaky: 1 })).toEqual({
      greeting: 'Hi',
      names: ['world'],
      photo: null,
      shout: false,
    })
  })
})

describe('validateInputs', () => {
  it('accepts values that satisfy every declaration', () => {
    expect(validateInputs(HELLO_INPUTS, initialValues(HELLO_INPUTS, {}))).toEqual({})
  })

  it('reports an unanswered required input', () => {
    const values = { ...initialValues(HELLO_INPUTS, {}), greeting: null }
    expect(validateInputs(HELLO_INPUTS, values)).toEqual({ greeting: 'This field is required' })
  })

  it('reports a value of the wrong type', () => {
    const values = { ...initialValues(HELLO_INPUTS, {}), shout: 'yes' }
    expect(validateInputs(HELLO_INPUTS, values)).toEqual({ shout: 'Expected a valid boolean value' })
  })

  it('reports a constraint the value breaks', () => {
    const values = { ...initialValues(HELLO_INPUTS, {}), names: ['nope'] }
    expect(Object.keys(validateInputs(HELLO_INPUTS, values))).toEqual(['names'])
  })

  it('reports every bad field at once, not just the first', () => {
    const values = { greeting: null, names: ['nope'], photo: null, shout: 'yes' }
    expect(Object.keys(validateInputs(HELLO_INPUTS, values)).sort()).toEqual([
      'greeting',
      'names',
      'shout',
    ])
  })

  it('treats `false` and `0` as answers, not blanks', () => {
    const inputs: Record<string, InputDef> = {
      flag: { type: 'boolean', required: true } as InputDef,
      count: { type: 'number', required: true } as InputDef,
    }
    expect(validateInputs(inputs, { flag: false, count: 0 })).toEqual({})
  })
})
