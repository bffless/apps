/**
 * `flowFor` on its own (apps#382). `GraphView.test.tsx` proves the chips carry
 * the `data-flow` attribute this produces; here the question is which chips it
 * names, which is easier to pin on a fixture built for it than on `hello`.
 *
 * The case that matters is a **job-level** hover: a job's `outputs` are aliases
 * evaluated at the job boundary, so nothing on the graph declares them
 * directly. The first cut lit every step of the job that declared any output,
 * which on a multi-step job highlighted steps that had nothing to do with the
 * value under the pointer.
 */
import { toDefinition } from '@bffless/workflow-lint/definition'
import { describe, expect, it } from 'vitest'
import helloYaml from '../../../docs/spec/examples/hello.workflow.yaml?raw'
import { loadWorkflow } from '../../lib/runner/definition'
import type { Definition } from '../../lib/runner/types'
import { flowFor } from './flow'

const hello = loadWorkflow(helloYaml, 'hello.workflow.yaml').def as Definition

/** Two steps in one job, both declaring outputs; the job aliases one of them. */
const build: Definition = toDefinition({
  name: 'Build',
  jobs: {
    build: {
      steps: [
        {
          id: 'compile',
          uses: 'pipeline',
          with: { path: 'echo' },
          outputs: { bundle: { type: 'string', value: '${{ response.text }}' } },
        },
        {
          id: 'sign',
          uses: 'pipeline',
          with: { path: 'echo' },
          outputs: { signature: { type: 'string', value: '${{ response.text }}' } },
        },
      ],
      outputs: {
        bundle: '${{ steps.compile.outputs.bundle }}',
        everything: '${{ steps.compile.outputs.bundle }}+${{ steps.sign.outputs.signature }}',
        stamped: 'v1',
      },
    },
    ship: {
      needs: 'build',
      steps: [
        {
          id: 'upload',
          uses: 'pipeline',
          with: { path: 'echo', body: { file: '${{ needs.build.outputs.bundle }}' } },
        },
      ],
    },
  },
})

const keys = (set: ReadonlySet<string>) => [...set].sort()

describe('flowFor — a job-level output', () => {
  it('lights only the step the alias reads, and the job card itself', () => {
    const flow = flowFor(build, { job: 'build', output: 'bundle' })

    expect(keys(flow.sourceSteps)).toEqual(['build::compile'])
    expect(keys(flow.sourceJobs)).toEqual(['build'])
  })

  it('lights every step an alias reads when it reads more than one', () => {
    const flow = flowFor(build, { job: 'build', output: 'everything' })

    expect(keys(flow.sourceSteps)).toEqual(['build::compile', 'build::sign'])
  })

  it('falls back to every output-declaring step when the alias names none', () => {
    const flow = flowFor(build, { job: 'build', output: 'stamped' })

    expect(keys(flow.sourceSteps)).toEqual(['build::compile', 'build::sign'])
  })

  it('marks the steps that read it downstream', () => {
    const flow = flowFor(build, { job: 'build', output: 'bundle' })

    expect(keys(flow.targetSteps)).toEqual(['ship::upload'])
  })
})

describe('flowFor — a step-level output', () => {
  it('is the one chip that declares it, plus the steps that read it', () => {
    const flow = flowFor(hello, { job: 'greet', step: 'say', output: 'line' })

    expect(keys(flow.sourceSteps)).toEqual(['greet::say'])
    expect(keys(flow.sourceJobs)).toEqual([])
    // `greet/say` reads its own output back in its `summary`.
    expect(keys(flow.targetSteps)).toEqual(['greet::say'])
  })
})

describe('flowFor — nothing hovered', () => {
  it('names nothing at all', () => {
    const flow = flowFor(hello, null)

    expect(keys(flow.sourceSteps)).toEqual([])
    expect(keys(flow.sourceJobs)).toEqual([])
    expect(keys(flow.targetSteps)).toEqual([])
  })
})
