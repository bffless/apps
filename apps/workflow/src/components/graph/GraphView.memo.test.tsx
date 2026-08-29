/**
 * apps#380: the data-flow edge list depends on the definition and nothing
 * else, but `GraphView` used to fold it into a memo keyed on the hovered value
 * too — so every pointer move over a value chip re-walked the whole workflow
 * to answer it. This suite is the regression guard: hovering, moving and
 * clearing must not add a single `dataFlowEdges` call after the first render.
 *
 * Its own file rather than a case inside `GraphView.test.tsx`, because it has
 * to spy on `lib/runner/graph` at module level and that mock would then apply
 * to every other test in that file.
 */
import { act, render } from '@testing-library/react'
import { Provider } from 'react-redux'
import { describe, expect, it, vi } from 'vitest'
import helloYaml from '../../../docs/spec/examples/hello.workflow.yaml?raw'
import { loadWorkflow } from '../../lib/runner/definition'
import type { Definition } from '../../lib/runner/types'
import { makeStore } from '../../store'
import { valueHovered } from '../../store/uiSlice'
import { GraphView } from './GraphView'
import { dataFlowEdges } from '../../lib/runner/graph'

vi.mock('../../lib/runner/graph', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/runner/graph')>()
  return { ...actual, dataFlowEdges: vi.fn(actual.dataFlowEdges) }
})

const hello = loadWorkflow(helloYaml, 'hello.workflow.yaml').def as Definition
const edgesSpy = vi.mocked(dataFlowEdges)

describe('GraphView — the edge list is memoized on the definition alone', () => {
  it('never re-walks the workflow while the hovered value changes', () => {
    edgesSpy.mockClear()
    const store = makeStore()
    render(
      <Provider store={store}>
        <GraphView def={hello} mode="definition" />
      </Provider>,
    )

    const afterMount = edgesSpy.mock.calls.length
    expect(afterMount).toBeGreaterThan(0)

    act(() => void store.dispatch(valueHovered({ job: 'greet', output: 'lines' })))
    act(() => void store.dispatch(valueHovered({ job: 'greet', step: 'say', output: 'line' })))
    act(() => void store.dispatch(valueHovered(null)))

    expect(edgesSpy.mock.calls.length).toBe(afterMount)
  })
})
