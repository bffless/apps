/**
 * 02 `images` (apps#446): the declared map is evaluated in the right contexts
 * and reduced to the src → serve-url entries the markdown viewer may draw.
 */
import { describe, expect, it } from 'vitest'
import { outputImageMap, resolveImageMap, stepImageMap } from './imageMap'
import { RUN_SCOPE, resolveOutput } from './outputDecls'
import {
  BUNDLE_KEY,
  FRAME_PATH,
  FRAME_URL,
  FRAMES_DEF,
  REVIEW_KEY,
  framesRun,
} from '../test/framesRun'

const contexts = {
  steps: {
    frames: {
      outputs: {
        srcs: { 'frame:78': FRAME_PATH },
        refs: {
          'frame:1': { path: 'workflows/r/a.jpg', name: 'a.jpg', contentType: 'image/jpeg', size: 1, url: '/api/uploads/workflows/r/a.jpg' },
        },
        bad: { blank: '   ', num: 7, list: ['x'], climb: '../runs/other', nested: { path: 3 } },
      },
    },
  },
}

describe('resolveImageMap', () => {
  it('evaluates one expression to a src → serve-url map', () => {
    expect(resolveImageMap('${{ steps.frames.outputs.srcs }}', contexts)).toEqual({ 'frame:78': FRAME_URL })
  })

  it('takes a File ref value by its path, and a literal map as written', () => {
    expect(resolveImageMap('${{ steps.frames.outputs.refs }}', contexts)).toEqual({
      'frame:1': '/api/uploads/workflows/r/a.jpg',
    })
    expect(resolveImageMap({ 'images/x.jpg': 'workflows/r/x.jpg' }, contexts)).toEqual({
      'images/x.jpg': '/api/uploads/workflows/r/x.jpg',
    })
  })

  it('drops entries that do not name a file under the serve route', () => {
    expect(resolveImageMap('${{ steps.frames.outputs.bad }}', contexts)).toEqual({})
  })

  it('is empty when the expression fails, or evaluates to something that is not a map', () => {
    expect(resolveImageMap('${{ nope(1) }}', contexts)).toEqual({})
    expect(resolveImageMap('${{ steps.frames.outputs.missing }}', contexts)).toEqual({})
    expect(resolveImageMap('${{ steps.frames.outputs.srcs.frame }}', contexts)).toEqual({})
    expect(resolveImageMap(['a'], contexts)).toEqual({})
  })
})

describe('stepImageMap / outputImageMap', () => {
  const state = framesRun()

  it("reads an earlier step's outputs off the persisted rows", () => {
    const review = state.steps[REVIEW_KEY]!
    const decl = { type: 'markdown', images: '${{ steps.frames.outputs.srcs }}' }
    expect(stepImageMap(FRAMES_DEF, state, review, decl)).toEqual({ 'frame:78': FRAME_URL })
  })

  it("reads the step's own outputs, as its summary would", () => {
    const bundle = state.steps[BUNDLE_KEY]!
    const decl = { type: 'markdown', images: '${{ steps.bundle.outputs.srcs }}' }
    expect(stepImageMap(FRAMES_DEF, state, bundle, decl)).toEqual({ 'images/frame-01.jpg': FRAME_URL })
  })

  it('is undefined for a declaration without images', () => {
    expect(stepImageMap(FRAMES_DEF, state, state.steps[REVIEW_KEY]!, { type: 'markdown' })).toBeUndefined()
  })

  it('follows a run-level output to the step that typed it and evaluates there', () => {
    const { decl, site } = resolveOutput(FRAMES_DEF, RUN_SCOPE, 'post')
    expect(site).toEqual({ kind: 'step', job: 'blog', step: 'bundle', matrix: false })
    expect(outputImageMap(FRAMES_DEF, state, decl, site)).toEqual({ 'images/frame-01.jpg': FRAME_URL })
    const draft = resolveOutput(FRAMES_DEF, { kind: 'job', job: 'blog' }, 'draft')
    expect(outputImageMap(FRAMES_DEF, state, draft.decl, draft.site)).toEqual({ 'frame:78': FRAME_URL })
  })

  it("leaves a matrix job's collected list unmapped", () => {
    const decl = { type: 'markdown', list: true, images: '${{ steps.x.outputs.srcs }}' }
    expect(outputImageMap(FRAMES_DEF, state, decl, { kind: 'step', job: 'blog', step: 'bundle', matrix: true })).toBeUndefined()
    expect(outputImageMap(FRAMES_DEF, state, decl, null)).toBeUndefined()
  })
})
