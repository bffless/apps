import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { SceneList } from './SceneList'
import type { Scene } from '../../lib/scenes'

function scene(over: Partial<Scene>): Scene {
  return {
    id: 's1',
    index: 0,
    sourceId: 'source-1',
    title: 'Intro',
    start: 0,
    end: 60,
    transcript: '',
    status: 'pending',
    narrationSeconds: null,
    ...over,
  }
}

describe('SceneList default-prompt peek', () => {
  it("reveals the scene's refinePrompt only once the disclosure is expanded", () => {
    render(
      <SceneList
        scenes={[scene({ refinePrompt: 'Keep it punchy; trim the dead air.' })]}
        selectedId={null}
        onSelect={() => {}}
      />,
    )
    expect(screen.queryByText('Keep it punchy; trim the dead air.')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /director's prompt/i }))
    expect(screen.getByText('Keep it punchy; trim the dead air.')).toBeInTheDocument()
  })

  it('renders no prompt toggle for a scene without a refinePrompt', () => {
    render(
      <SceneList scenes={[scene({ refinePrompt: undefined })]} selectedId={null} onSelect={() => {}} />,
    )
    expect(screen.queryByRole('button', { name: /director's prompt/i })).not.toBeInTheDocument()
  })

  it('expanding the prompt does not select the scene; the row still selects', () => {
    const onSelect = vi.fn()
    render(
      <SceneList scenes={[scene({ refinePrompt: 'P' })]} selectedId={null} onSelect={onSelect} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /director's prompt/i }))
    expect(onSelect).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Intro/i }))
    expect(onSelect).toHaveBeenCalledWith('s1')
  })
})
