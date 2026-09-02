/**
 * The read-only executors against the MSW mock backend and the real store:
 * the discovery cache, the run slice and the run record are the three sources
 * a page tool answers from, and each is exercised here.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TOOL_NAMES } from '@bffless/workflow-agent-tools'
import { START_REFUSALS } from '../lib/autoStart'
import { db, seedFinishedRun, seedWaitingRun } from '../mocks/db'
import { FIXTURE_RUN_ID } from '../mocks/fixtures/finishedRun'
import { WAITING_RUN_ID, WAITING_STEP_KEY } from '../mocks/fixtures/waitingRun'
import { makeStore } from '../store'
import type { AppStore } from '../store'
import { REVIEW_KEY, resetHelloHarness, startHelloAtConfirmWaiting } from '../test/helloHarness'
import { createExecutors } from './executors'

function executorsFor(store: AppStore, pathname = '/') {
  const navigated: string[] = []
  const exec = createExecutors({ store, navigate: (to) => navigated.push(to), location: () => ({ pathname }) })
  return { exec, navigated }
}

beforeEach(() => {
  seedFinishedRun()
  seedWaitingRun()
})

afterEach(() => {
  resetHelloHarness()
})

describe('createExecutors', () => {
  it('has one executor per catalog name', () => {
    const { exec } = executorsFor(makeStore())
    expect(Object.keys(exec).sort()).toEqual([...TOOL_NAMES].sort())
  })
})

describe('workflow.list', () => {
  it('lists the implementations and their workflows with the headlessSafe mark', async () => {
    const { exec } = executorsFor(makeStore())
    const result = await exec['workflow.list']({})
    expect(result.isError).toBeUndefined()
    const implementations = result.structuredContent!.implementations as Array<{ alias: string; workflows: Array<{ id: string; headlessSafe: boolean }> }>
    expect(implementations.map((impl) => impl.alias)).toEqual(['hello'])
    expect(implementations[0]!.workflows.map((w) => w.id)).toEqual(['hello', 'interactive'])
    expect(implementations[0]!.workflows.every((w) => typeof w.headlessSafe === 'boolean')).toBe(true)
    expect(result.content[0]!.text).toMatch(/^hello — Hello/)
  })

  it('refuses an alias nobody publishes', async () => {
    const { exec } = executorsFor(makeStore())
    const result = await exec['workflow.list']({ impl: 'nope' })
    expect(result.isError).toBe(true)
    expect(result.structuredContent!.errors).toEqual({ impl: 'No implementation "nope" is published here' })
  })
})

describe('workflow.describe', () => {
  it("answers hello/interactive's inputs, jobs and interactive steps", async () => {
    const { exec } = executorsFor(makeStore())
    const result = await exec['workflow.describe']({ impl: 'hello', workflow: 'interactive' })
    expect(result.isError).toBeUndefined()
    const described = result.structuredContent as { name: string; inputs: Record<string, { type: string }>; jobs: Array<{ id: string; steps: Array<{ id: string; kind: string; headless?: string }> }> }
    expect(described.name).toBe('Interactive hello')
    expect(described.inputs.greeting?.type).toBe('string')
    const choose = described.jobs.find((job) => job.id === 'pick')?.steps[0]
    expect(choose).toMatchObject({ id: 'choose', kind: 'island', headless: 'auto' })
    expect(result.content[0]!.text).toContain('pick/choose (island, headless: auto)')
  })

  it('refuses with spec 07 vocabulary, verbatim', async () => {
    const { exec } = executorsFor(makeStore())
    const result = await exec['workflow.describe']({ impl: 'nope', workflow: 'interactive' })
    expect(result.isError).toBe(true)
    expect(result.structuredContent!.errors).toEqual({ workflow: START_REFUSALS.noWorkflow })
    expect(result.content[0]!.text).toBe(START_REFUSALS.noWorkflow)
  })

  it('refuses a missing argument by name', async () => {
    const { exec } = executorsFor(makeStore())
    const result = await exec['workflow.describe']({ impl: 'hello' })
    expect(result.isError).toBe(true)
    expect(Object.keys(result.structuredContent!.errors as object)).toEqual(['workflow'])
  })
})

describe('workflow.status / workflow.outputs', () => {
  it('with no run on the page and no runId, refuses under `runId`', async () => {
    const { exec } = executorsFor(makeStore())
    const result = await exec['workflow.status']({})
    expect(result.isError).toBe(true)
    expect(result.structuredContent!.errors).toEqual({ runId: 'No run is on this page — pass runId' })
  })

  it('reads the run this tab drives off the slice, with waitingOn', async () => {
    const { store } = await startHelloAtConfirmWaiting()
    const { exec } = executorsFor(store)
    const result = await exec['workflow.status']({})
    expect(result.isError).toBeUndefined()
    const snapshot = result.structuredContent as { runId: string; status: string; currentSteps: string[]; waitingOn: Array<{ key: string; kind: string }> }
    expect(snapshot.runId).toBe(store.getState().run.state!.runId)
    expect(snapshot.status).toBe('running')
    expect(snapshot.currentSteps).toEqual([REVIEW_KEY])
    expect(snapshot.waitingOn).toMatchObject([{ key: REVIEW_KEY, kind: 'form' }])
    expect(result.content[0]!.text).toBe(`Run ${snapshot.runId} is running, waiting on ${REVIEW_KEY} (form)`)

    const outputs = await exec['workflow.outputs']({ runId: snapshot.runId })
    expect(outputs.structuredContent).toEqual({ runId: snapshot.runId, status: 'running', outputs: {} })
  })

  it('reads any other run off its record, through snapshotFromRows', async () => {
    const { exec } = executorsFor(makeStore())
    const waiting = await exec['workflow.status']({ runId: WAITING_RUN_ID })
    expect(waiting.isError).toBeUndefined()
    expect(waiting.structuredContent).toMatchObject({
      runId: WAITING_RUN_ID,
      status: 'running',
      currentSteps: [WAITING_STEP_KEY],
      waitingOn: [{ key: WAITING_STEP_KEY, kind: 'form' }],
    })

    const finished = await exec['workflow.outputs']({ runId: FIXTURE_RUN_ID })
    expect(finished.isError).toBeUndefined()
    const structured = finished.structuredContent as { status: string; outputs: Record<string, unknown> }
    expect(structured.status).toBe('succeeded')
    expect(Object.keys(structured.outputs).length).toBeGreaterThan(0)
    expect(finished.content[0]!.text).toContain(`Run ${FIXTURE_RUN_ID} (succeeded) outputs:`)
  })

  it('refuses a run that does not exist', async () => {
    const { exec } = executorsFor(makeStore())
    const result = await exec['workflow.status']({ runId: 'run_nope' })
    expect(result.isError).toBe(true)
    expect(result.structuredContent!.errors).toEqual({ runId: 'No such run' })
  })
})

describe('workflow.runs', () => {
  it('lists a workflow’s runs newest first, each with waitingOn', async () => {
    const { exec } = executorsFor(makeStore())
    const result = await exec['workflow.runs']({ impl: 'hello', workflow: 'hello' })
    expect(result.isError).toBeUndefined()
    const runs = result.structuredContent!.runs as Array<{ runId: string; status: string; waitingOn: string[] }>
    expect(runs.map((run) => run.runId)).toEqual(expect.arrayContaining([FIXTURE_RUN_ID, WAITING_RUN_ID]))
    expect(runs.find((run) => run.runId === WAITING_RUN_ID)).toMatchObject({ status: 'running', waitingOn: [WAITING_STEP_KEY] })
    expect(result.content[0]!.text).toContain(`${WAITING_RUN_ID} running`)
  })

  it('defaults impl/workflow from the route, filters by status and caps by limit', async () => {
    const { exec } = executorsFor(makeStore(), '/hello/hello/runs')
    const result = await exec['workflow.runs']({ status: 'succeeded', limit: 1 })
    expect(result.isError).toBeUndefined()
    const runs = result.structuredContent!.runs as Array<{ runId: string; status: string }>
    expect(runs).toHaveLength(1)
    expect(runs[0]!.status).toBe('succeeded')
    expect(result.structuredContent).toMatchObject({ impl: 'hello', workflow: 'hello' })
  })

  it('defaults impl/workflow from the run this tab drives', async () => {
    const { store } = await startHelloAtConfirmWaiting()
    const { exec } = executorsFor(store)
    const result = await exec['workflow.runs']({})
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toMatchObject({ impl: 'hello', workflow: 'hello' })
    expect(db.runs.has(store.getState().run.state!.runId)).toBe(true)
  })

  it('refuses when nothing supplies the pair', async () => {
    const { exec } = executorsFor(makeStore())
    const result = await exec['workflow.runs']({})
    expect(result.isError).toBe(true)
    expect(result.structuredContent!.errors).toEqual({ workflow: 'Pass impl and workflow — this page has no current workflow' })
  })
})

describe('the mutation tools', () => {
  it('are registered but honest about not being here yet', async () => {
    const { exec } = executorsFor(makeStore())
    for (const name of ['workflow.start', 'workflow.await', 'workflow.submitStep', 'workflow.sign', 'workflow.cancel', 'workflow.resume'] as const) {
      const result = await exec[name]({})
      expect(result.isError, name).toBe(true)
    }
  })
})
