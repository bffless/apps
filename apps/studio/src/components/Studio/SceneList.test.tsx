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
    ...over,
  }
}

describe('SceneList cutting-brief peek', () => {
  it("reveals the scene's brief only once the disclosure is expanded", () => {
    render(
      <SceneList
        scenes={[scene({ brief: 'Keep it punchy; trim the dead air.' })]}
        selectedId={null}
        onSelect={() => {}}
      />,
    )
    expect(screen.queryByText('Keep it punchy; trim the dead air.')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /cutting brief/i }))
    expect(screen.getByText('Keep it punchy; trim the dead air.')).toBeInTheDocument()
  })

  it('falls back to the legacy seeded refinePrompt on pre-13f scenes', () => {
    render(
      <SceneList scenes={[scene({ refinePrompt: 'Old seeded prompt.' })]} selectedId={null} onSelect={() => {}} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /cutting brief/i }))
    expect(screen.getByText('Old seeded prompt.')).toBeInTheDocument()
  })

  it('renders no brief toggle for a scene without one', () => {
    render(
      <SceneList scenes={[scene({ brief: undefined, refinePrompt: undefined })]} selectedId={null} onSelect={() => {}} />,
    )
    expect(screen.queryByRole('button', { name: /cutting brief/i })).not.toBeInTheDocument()
  })

  it('expanding the brief does not select the scene; the row still selects', () => {
    const onSelect = vi.fn()
    render(
      <SceneList scenes={[scene({ brief: 'P' })]} selectedId={null} onSelect={onSelect} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /cutting brief/i }))
    expect(onSelect).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Intro/i }))
    expect(onSelect).toHaveBeenCalledWith('s1')
  })
})
