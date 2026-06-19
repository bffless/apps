import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SceneRefinePanel } from './SceneRefinePanel'
import type { Scene } from '../../lib/scenes'

const noop = () => {}

function makeScene(overrides: Partial<Scene> = {}): Scene {
  return {
    id: 's1',
    index: 0,
    title: 'Opening',
    start: 0,
    end: 10,
    transcript: 'hello there',
    cuts: [],
    sheets: [{ index: 0, dataUrl: '', url: '/api/uploads/thumbnails/sheet-01.jpg', times: [0, 5] }],
    ...overrides,
  } as unknown as Scene
}

type PanelProps = Parameters<typeof SceneRefinePanel>[0]

function renderPanel(scene: Scene, extra: Partial<PanelProps> = {}) {
  return render(
    <SceneRefinePanel
      scene={scene}
      slicing={false}
      sheeting={false}
      refining={false}
      direction=""
      onSlice={noop}
      onGenerateSheets={noop}
      onRefine={noop}
      onClear={noop}
      onRefinePromptChange={noop}
      onIncludeDirectionChange={noop}
      {...extra}
    />,
  )
}

describe('SceneRefinePanel refine gate (story 03k)', () => {
  it('disables Refine until the scene is cut, with a hint', () => {
    renderPanel(makeScene({ clipUrl: '/api/uploads/scene-clip/scene-0.mp4' })) // no clipAudioUrl
    const refine = screen.getByRole('button', { name: /refine scene/i })
    expect(refine).toBeDisabled()
    expect(refine).toHaveAttribute('title', 'Cut this scene first')
  })

  it('enables Refine when the scene has audio and sheets', () => {
    renderPanel(
      makeScene({
        clipUrl: '/api/uploads/scene-clip/scene-0.mp4',
        clipAudioUrl: '/api/uploads/audio/scene-0-audio.wav',
      }),
    )
    expect(screen.getByRole('button', { name: /refine scene/i })).toBeEnabled()
  })

  it('still hints about sheets when audio is there but sheets are not', () => {
    renderPanel(
      makeScene({
        clipAudioUrl: '/api/uploads/audio/scene-0-audio.wav',
        sheets: [],
      }),
    )
    const refine = screen.getByRole('button', { name: /refine scene/i })
    expect(refine).toBeDisabled()
    expect(refine).toHaveAttribute('title', 'Generate scene contact sheets first')
  })
})

describe('SceneRefinePanel scene prompts (story 03l)', () => {
  it('edits the per-scene direction through onRefinePromptChange', () => {
    const onChange = vi.fn()
    renderPanel(makeScene({ refinePrompt: 'old' }), { onRefinePromptChange: onChange })
    const box = screen.getByLabelText(/direction for this scene/i)
    expect(box).toHaveValue('old')
    fireEvent.change(box, { target: { value: 'trim the pause' } })
    expect(onChange).toHaveBeenCalledWith('trim the pause')
  })

  it('prefills the direction textarea with the director\'s per-scene prompt (story 03q)', () => {
    renderPanel(makeScene({ refinePrompt: 'Tighten the intro to a 15s hook.' }))
    expect(screen.getByLabelText(/direction for this scene/i)).toHaveValue(
      'Tighten the intro to a 15s hook.',
    )
  })

  it('hides the director-prompt row when there is no director prompt', () => {
    renderPanel(makeScene(), { direction: '   ' })
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })

  it('shows the director prompt read-only with the checkbox checked by default', () => {
    renderPanel(makeScene(), { direction: 'punchy intro' })
    const box = screen.getByRole('checkbox', { name: /include your director prompt/i })
    expect(box).toBeChecked()
    expect(screen.getByText('punchy intro')).toBeInTheDocument()
  })

  it('reflects an unchecked scene and reports toggles through onIncludeDirectionChange', () => {
    const onToggle = vi.fn()
    renderPanel(makeScene({ includeDirection: false }), {
      direction: 'punchy intro',
      onIncludeDirectionChange: onToggle,
    })
    const box = screen.getByRole('checkbox', { name: /include your director prompt/i })
    expect(box).not.toBeChecked()
    fireEvent.click(box)
    expect(onToggle).toHaveBeenCalledWith(true)
  })
})
