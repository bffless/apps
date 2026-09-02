// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { ERR, LATEST_PROTOCOL_VERSION, errorResponse, negotiateVersion, okResponse, parseMessage } from './jsonrpc'

describe('parseMessage', () => {
  it('reads a request', () => {
    expect(parseMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).toEqual({ kind: 'request', id: 1, method: 'tools/list', params: {} })
    expect(parseMessage({ jsonrpc: '2.0', id: 'a', method: 'tools/call', params: { name: 'x' } })).toEqual({
      kind: 'request', id: 'a', method: 'tools/call', params: { name: 'x' },
    })
  })

  it('reads a notification (no id)', () => {
    expect(parseMessage({ jsonrpc: '2.0', method: 'notifications/initialized' })).toEqual({
      kind: 'notification', method: 'notifications/initialized', params: {},
    })
  })

  it('refuses batches, non-objects, the wrong version and a missing method, keeping the id when there is one', () => {
    expect(parseMessage([]).kind).toBe('invalid')
    expect(parseMessage('x').kind).toBe('invalid')
    expect(parseMessage(null).kind).toBe('invalid')
    expect(parseMessage({ jsonrpc: '1.0', id: 3, method: 'x' })).toMatchObject({ kind: 'invalid', id: 3 })
    expect(parseMessage({ jsonrpc: '2.0', id: 4 })).toMatchObject({ kind: 'invalid', id: 4 })
    expect(parseMessage({ jsonrpc: '2.0', id: {}, method: 'x' })).toMatchObject({ kind: 'request', id: null })
  })
})

describe('envelopes', () => {
  it('build result and error responses', () => {
    expect(okResponse(1, { a: 1 })).toEqual({ jsonrpc: '2.0', id: 1, result: { a: 1 } })
    expect(errorResponse(null, ERR.METHOD_NOT_FOUND, 'no')).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32601, message: 'no' } })
    expect(errorResponse(2, ERR.INVALID_PARAMS, 'bad', { x: 1 }).error.data).toEqual({ x: 1 })
  })
})

describe('negotiateVersion', () => {
  it("answers the client's version when spoken, else ours", () => {
    expect(negotiateVersion('2025-03-26')).toBe('2025-03-26')
    expect(negotiateVersion('2024-11-05')).toBe('2024-11-05')
    expect(negotiateVersion('1999-01-01')).toBe(LATEST_PROTOCOL_VERSION)
    expect(negotiateVersion(undefined)).toBe('2025-06-18')
  })
})
