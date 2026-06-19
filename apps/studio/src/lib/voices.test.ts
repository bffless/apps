import { describe, it, expect } from 'vitest'
import {
  VOICE_GROUPS,
  PRESET_VOICES,
  STUB_CLONE_VOICE_ID,
  findPresetVoice,
  presetLabel,
} from './voices'

describe('voice catalog', () => {
  it('has the 12 expected preset ids, grouped', () => {
    expect(VOICE_GROUPS.map((g) => g.label)).toEqual([
      'Authority figures',
      'Friendly voices',
      'Energetic options',
      'Character voices',
    ])
    expect(PRESET_VOICES.map((v) => v.id)).toEqual([
      'Deep_Voice_Man',
      'Imposing_Manner',
      'Elegant_Man',
      'Casual_Guy',
      'Friendly_Person',
      'Decent_Boy',
      'Lively_Girl',
      'Exuberant_Girl',
      'Inspirational_girl',
      'Young_Knight',
      'Abbess',
      'Wise_Woman',
    ])
  })

  it('has unique ids', () => {
    const ids = PRESET_VOICES.map((v) => v.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('humanizes ids into names', () => {
    expect(findPresetVoice('Deep_Voice_Man')?.name).toBe('Deep Voice Man')
    expect(presetLabel('Wise_Woman')).toBe('Wise Woman')
  })

  it('falls back to the raw id for non-presets (e.g. a real cloned id)', () => {
    expect(findPresetVoice('clone-abc123')).toBeNull()
    expect(presetLabel('clone-abc123')).toBe('clone-abc123')
  })

  it('uses a real preset as the clone stub', () => {
    expect(findPresetVoice(STUB_CLONE_VOICE_ID)).not.toBeNull()
  })
})
