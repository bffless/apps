import { describe, it, expect } from 'vitest'
import { createSemaphore } from './semaphore'

/** A promise you resolve from the outside, to control interleaving. */
function deferred<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('createSemaphore', () => {
  it('capacity 1 serializes: the second task waits for the first', async () => {
    const sem = createSemaphore(1)
    const gate = deferred()
    const order: string[] = []
    const a = sem.run(async () => { order.push('a:start'); await gate.promise; order.push('a:end') })
    const b = sem.run(async () => { order.push('b:start') })
    await Promise.resolve() // let the queue settle
    expect(order).toEqual(['a:start']) // b has NOT started
    gate.resolve()
    await Promise.all([a, b])
    expect(order).toEqual(['a:start', 'a:end', 'b:start'])
  })

  it('capacity 2 admits two at once but not three', async () => {
    const sem = createSemaphore(2)
    const gate = deferred()
    const started: string[] = []
    const tasks = ['a', 'b', 'c'].map((id) =>
      sem.run(async () => { started.push(id); await gate.promise }),
    )
    await Promise.resolve()
    expect(started).toEqual(['a', 'b'])
    gate.resolve()
    await Promise.all(tasks)
    expect(started).toEqual(['a', 'b', 'c'])
  })

  it('releases the slot when the task rejects', async () => {
    const sem = createSemaphore(1)
    await expect(sem.run(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    await expect(sem.run(async () => 'ok')).resolves.toBe('ok')
  })

  it('returns the task result', async () => {
    const sem = createSemaphore(1)
    await expect(sem.run(() => 42)).resolves.toBe(42)
  })
})
