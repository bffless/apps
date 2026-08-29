/**
 * The refusal wording (apps#382). `RunPage.test.tsx` drives the hook end to
 * end — offered, refused with a 403, refused with a 409 — through the page it
 * belongs to; what it never reaches is the 404 branch, because a run that is
 * already gone is not one the page can still be showing a Delete button for.
 * The three statuses mean three different things and only one of them is "try
 * again", so each is pinned here.
 */
import { describe, expect, it } from 'vitest'
import { RunStoreError } from '../lib/runStore'
import { deleteMessage } from './useRunDelete'

describe('deleteMessage', () => {
  it('names the gate for a 403', () => {
    expect(deleteMessage(new RunStoreError('nope', 403))).toMatch(/owner or an admin/)
  })

  it('says what to do first for a 409', () => {
    expect(deleteMessage(new RunStoreError('still running', 409))).toMatch(/cancel the run first/i)
  })

  it('says the run is already gone for a 404', () => {
    expect(deleteMessage(new RunStoreError('gone', 404))).toBe('This run is already gone.')
  })

  it('passes an ordinary failure through in its own words', () => {
    expect(deleteMessage(new Error('the network went away'))).toBe('the network went away')
    expect(deleteMessage(new RunStoreError('teapot', 418))).toBe('teapot')
  })

  it('has something to say about a thrown non-error', () => {
    expect(deleteMessage('nope')).toBe('The run could not be deleted.')
  })
})
