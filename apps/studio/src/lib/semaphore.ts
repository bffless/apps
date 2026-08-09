/**
 * A tiny counting semaphore. Auto Build uses it two ways: capacity 1 as the
 * upload slot (parallel uploads trip the dev proxy's keep-alive sockets — the
 * 502 lesson from `sliceScene`/`processAll`) and capacity 1 as the ffmpeg
 * mutex (one shared wasm instance; two concurrent `exec`s would interleave FS
 * staging). FIFO: waiters run in the order they asked.
 */
export type Semaphore = { run<T>(fn: () => Promise<T> | T): Promise<T> }

export function createSemaphore(capacity: number): Semaphore {
  let active = 0
  const waiters: (() => void)[] = []
  const acquire = (): Promise<void> =>
    new Promise((resolve) => {
      if (active < capacity) {
        active++
        resolve()
      } else {
        waiters.push(() => { active++; resolve() })
      }
    })
  const release = () => {
    active--
    waiters.shift()?.()
  }
  return {
    async run<T>(fn: () => Promise<T> | T): Promise<T> {
      await acquire()
      try {
        return await fn()
      } finally {
        release()
      }
    },
  }
}
