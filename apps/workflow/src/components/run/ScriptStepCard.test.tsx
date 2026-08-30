/**
 * The script step's log card (Task 11; recorded tail apps#527).
 *
 * While the tab drives the run, the lines live in a module-level store keyed
 * by run + step and reach the card through `useSyncExternalStore` rather than
 * Redux. When the step ends, the capped tail is persisted on the row and
 * comes back through step state as `recorded` — the card's fallback whenever
 * the live store holds nothing. What matters here is that the card renders
 * the right source, and that `StepPane` puts it on a script step's Output tab
 * live *and* on a read-back run.
 */
import { render, screen, act } from '@testing-library/react'
import { Provider } from 'react-redux'
import { toDefinition } from '@bffless/workflow-lint/definition'
import { afterEach, describe, expect, it } from 'vitest'
import { ScriptStepCard } from './ScriptStepCard'
import { StepPane } from './StepPane'
import { makeStore } from '../../store'
import { appendScriptLog, clearAllScriptLogs } from '../../scripts/logStore'
import type { Definition, RunState, StepKey, StepState } from '../../lib/runner/types'
import { stepKey } from '../../lib/runner/types'

const KEY: StepKey = stepKey('make', 0, 'poster')
const RUN = 'run_card'

afterEach(() => {
  clearAllScriptLogs()
})

const def = toDefinition({
  name: 'Scripted',
  jobs: {
    make: {
      steps: [
        {
          id: 'poster',
          uses: 'script',
          with: { src: 'scripts/poster.js' },
          outputs: { count: { type: 'number' } },
        },
      ],
    },
  },
}) as Definition

function stepState(over: Partial<StepState> = {}): StepState {
  return {
    key: KEY,
    job: 'make',
    index: 0,
    stepId: 'poster',
    kind: 'script',
    status: 'running',
    attempt: 1,
    annotations: [],
    ...over,
  }
}

function runState(over: Partial<StepState> = {}): RunState {
  return {
    runId: RUN,
    impl: 'hello',
    workflow: 'interactive',
    status: 'running',
    headless: false,
    unattended: false,
    inputs: {},
    steps: { [KEY]: stepState(over) },
    expansions: {},
    annotations: [],
    startedAt: 1_000,
  }
}

describe('ScriptStepCard', () => {
  it('says so when the script has logged nothing yet', () => {
    render(<ScriptStepCard runId={RUN} stepKey={KEY} />)

    expect(screen.getByTestId('script-log')).toBeInTheDocument()
    expect(screen.getByText('No log lines yet')).toBeInTheDocument()
  })

  it('renders the lines the store holds, newest last', () => {
    appendScriptLog(RUN, KEY, 'frame 1')
    appendScriptLog(RUN, KEY, 'frame 2')

    render(<ScriptStepCard runId={RUN} stepKey={KEY} />)

    const lines = screen.getByTestId('script-log').querySelectorAll('li')
    expect([...lines].map((li) => li.textContent)).toEqual(['frame 1', 'frame 2'])
  })

  it('re-renders as lines arrive', () => {
    render(<ScriptStepCard runId={RUN} stepKey={KEY} />)

    act(() => {
      appendScriptLog(RUN, KEY, 'frame 1')
    })

    expect(screen.getByText('frame 1')).toBeInTheDocument()
    expect(screen.queryByText('No log lines yet')).not.toBeInTheDocument()
  })

  it('keeps only the last 50 lines', () => {
    for (let i = 0; i < 60; i++) appendScriptLog(RUN, KEY, `line ${i}`)

    render(<ScriptStepCard runId={RUN} stepKey={KEY} />)

    const lines = [...screen.getByTestId('script-log').querySelectorAll('li')]
    expect(lines).toHaveLength(50)
    expect(lines[0].textContent).toBe('line 10')
    expect(lines[49].textContent).toBe('line 59')
  })

  it('shows one step\'s lines, not another run\'s', () => {
    appendScriptLog('run_other', KEY, 'not mine')
    appendScriptLog(RUN, KEY, 'mine')

    render(<ScriptStepCard runId={RUN} stepKey={KEY} />)

    expect(screen.getByText('mine')).toBeInTheDocument()
    expect(screen.queryByText('not mine')).not.toBeInTheDocument()
  })

  it('falls back to the recorded tail when the tab holds no live lines (apps#527)', () => {
    render(<ScriptStepCard runId={RUN} stepKey={KEY} recorded={['recorded 1', 'recorded 2']} />)

    const lines = screen.getByTestId('script-log').querySelectorAll('li')
    expect([...lines].map((li) => li.textContent)).toEqual(['recorded 1', 'recorded 2'])
  })

  it('prefers the live stream over the recorded tail', () => {
    appendScriptLog(RUN, KEY, 'live line')

    render(<ScriptStepCard runId={RUN} stepKey={KEY} recorded={['recorded 1']} />)

    expect(screen.getByText('live line')).toBeInTheDocument()
    expect(screen.queryByText('recorded 1')).not.toBeInTheDocument()
  })
})

describe('StepPane — the Output tab carries the log for a script step', () => {
  it('shows the card while the script runs and after it finished', async () => {
    appendScriptLog(RUN, KEY, 'frame 1')
    const store = makeStore()
    const { rerender } = render(
      <Provider store={store}>
        <StepPane def={def} state={runState()} stepKey={KEY} live={true} />
      </Provider>,
    )

    // The Input | Output toggle is unchanged — the card lives on Output, which
    // (unlike the old Details tab) dispatches the hover highlight, hence the store.
    expect(screen.getByTestId('step-pane')).toBeInTheDocument()
    expect(screen.queryByTestId('script-log')).not.toBeInTheDocument()
    await act(async () => {
      screen.getByRole('tab', { name: 'Output' }).click()
    })
    expect(screen.getByTestId('script-log')).toBeInTheDocument()
    expect(screen.getByText('frame 1')).toBeInTheDocument()

    // A finished script keeps its lines until the runner resets.
    rerender(
      <Provider store={store}>
        <StepPane
          def={def}
          state={runState({ status: 'succeeded', outputs: { count: 2 } })}
          stepKey={KEY}
          live={true}
        />
      </Provider>,
    )
    expect(screen.getByTestId('script-log')).toBeInTheDocument()
  })

  it('renders the recorded tail on a read-only replay (apps#527)', async () => {
    // Another run's replay: this tab's store holds nothing under its runId,
    // so the card falls back to the `log` the row carried into step state.
    render(
      <Provider store={makeStore()}>
        <StepPane
          def={def}
          state={runState({ status: 'succeeded', outputs: { count: 2 }, log: ['recorded frame'] })}
          stepKey={KEY}
          live={false}
        />
      </Provider>,
    )

    await act(async () => {
      screen.getByRole('tab', { name: 'Output' }).click()
    })
    expect(screen.getByTestId('script-log')).toBeInTheDocument()
    expect(screen.getByText('recorded frame')).toBeInTheDocument()
  })

  it('says so on a replayed step from before the column existed', async () => {
    render(
      <Provider store={makeStore()}>
        <StepPane
          def={def}
          state={runState({ status: 'succeeded', outputs: { count: 2 } })}
          stepKey={KEY}
          live={false}
        />
      </Provider>,
    )

    await act(async () => {
      screen.getByRole('tab', { name: 'Output' }).click()
    })
    expect(screen.getByTestId('script-log')).toBeInTheDocument()
    expect(screen.getByText('No log lines yet')).toBeInTheDocument()
  })
})
