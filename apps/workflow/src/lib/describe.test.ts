import { describe, expect, it } from 'vitest'
import { loadWorkflow } from './runner/definition'
import type { Definition } from './runner/types'
import { describeWorkflow } from './describe'
import interactiveYaml from '../../docs/spec/examples/interactive.workflow.yaml?raw'

const loaded = loadWorkflow(interactiveYaml, 'interactive.workflow.yaml')
const def = loaded.def as Definition
const listing = { file: 'interactive.workflow.yaml', name: def.name, inputs: 2, jobs: 5, headlessSafe: true }

describe('describeWorkflow', () => {
  const described = describeWorkflow({ impl: 'hello', workflow: 'interactive', listing, def })

  it('names the workflow and carries the listing mark', () => {
    expect(described.impl).toBe('hello')
    expect(described.workflow).toBe('interactive')
    expect(described.name).toBe('Interactive hello')
    expect(described.headlessSafe).toBe(true)
    expect(typeof described.description).toBe('string')
  })

  it('describes inputs as declared: type, list, required, default, options', () => {
    expect(described.inputs.greeting).toEqual({ type: 'string', required: true, default: 'Hello' })
    expect(described.inputs.names).toMatchObject({ type: 'choice', list: true, options: ['world', 'studio', 'reader'] })
  })

  it('lists jobs in scheduling order with their needs', () => {
    const ids = described.jobs.map((job) => job.id)
    expect(ids.slice(0, 2)).toEqual(['greet', 'analyze'])
    expect(ids.indexOf('pick')).toBeGreaterThan(ids.indexOf('analyze'))
    expect(ids.indexOf('review')).toBeGreaterThan(ids.indexOf('card'))
    expect(described.jobs.find((job) => job.id === 'pick')?.needs).toEqual(['greet', 'analyze'])
    expect(described.jobs.find((job) => job.id === 'greet')?.matrix).toEqual({ who: '${{ inputs.names }}' })
  })

  it('tells an agent what each interactive step does without a person', () => {
    const choose = described.jobs.find((job) => job.id === 'pick')?.steps[0]
    expect(choose).toMatchObject({ id: 'choose', kind: 'island', headless: 'auto', title: 'Pick the best line' })
    expect(choose?.outputs).toMatchObject({ line: { type: 'string', required: true } })
    expect(choose?.fields).toBeUndefined()

    const confirm = described.jobs.find((job) => job.id === 'review')?.steps[0]
    expect(confirm).toMatchObject({ id: 'confirm', kind: 'form', headless: 'skip', title: 'Review the card' })
    expect(Object.keys(confirm?.fields ?? {})).toEqual(['cover', 'notes', 'extra'])
    expect(confirm?.outputs).toBeUndefined()

    const say = described.jobs.find((job) => job.id === 'greet')?.steps[0]
    expect(say).toEqual({ id: 'say', kind: 'pipeline' })
  })

  it('describes run outputs by type, list and render', () => {
    expect(described.outputs.poster).toEqual({})
    expect(Object.keys(described.outputs)).toContain('cover')
  })
})
