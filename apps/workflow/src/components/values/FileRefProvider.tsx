/** The run page's half of `fileRefIndex`: every File ref the run holds, by path, for `ValueView`. */
import { useMemo } from 'react'
import type { ReactNode } from 'react'
import type { RunState } from '../../lib/runner/types'
import { FileRefIndex, indexFileRefs } from './fileRefIndex'

export function FileRefProvider({ state, children }: { state: RunState; children: ReactNode }) {
  const index = useMemo(() => indexFileRefs(state), [state])
  return <FileRefIndex.Provider value={index}>{children}</FileRefIndex.Provider>
}

