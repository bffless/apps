/**
 * MiniMax preset voices — the built-in voices a producer can pick *instead of*
 * cloning their own. Choosing a preset is the cheap, instant path: no recording,
 * no upload, no $3 clone call — we just store the preset's `voice_id` and the
 * narration TTS (`minimax/speech-2.8-turbo`) uses it directly, the same way it
 * would use a cloned id.
 *
 * The ids here are the real MiniMax voice ids (case-sensitive — they're passed
 * verbatim as the model's `voice_id`). Pure data + lookups, no React, so it's
 * shared by the picker UI, the clone-disabled pipeline stub, and the tests.
 */

export type PresetVoice = { id: string; name: string }
export type VoiceGroup = { label: string; voices: PresetVoice[] }

/** Turn a raw id like `Deep_Voice_Man` into a readable label `Deep Voice Man`. */
function toName(id: string): string {
  return id.replace(/_/g, ' ')
}

const group = (label: string, ids: string[]): VoiceGroup => ({
  label,
  voices: ids.map((id) => ({ id, name: toName(id) })),
})

/** The preset catalog, grouped by character — what the dropdown renders. */
export const VOICE_GROUPS: VoiceGroup[] = [
  group('Authority figures', ['Deep_Voice_Man', 'Imposing_Manner', 'Elegant_Man']),
  group('Friendly voices', ['Casual_Guy', 'Friendly_Person', 'Decent_Boy', 'Lively_Girl']),
  group('Energetic options', ['Exuberant_Girl', 'Inspirational_girl']),
  group('Character voices', ['Young_Knight', 'Abbess', 'Wise_Woman']),
]

/** Flat list of every preset, in catalog order. */
export const PRESET_VOICES: PresetVoice[] = VOICE_GROUPS.flatMap((g) => g.voices)

/**
 * The neutral preset the disabled clone pipeline hands back as its stub
 * `voice_id` — so the post-clone preview synthesizes real audio without the $3
 * clone call. Switch the real clone step on and this stops being used.
 */
export const STUB_CLONE_VOICE_ID = 'Friendly_Person'

/** Find a preset by its exact id, or null if it isn't one of ours. */
export function findPresetVoice(id: string): PresetVoice | null {
  return PRESET_VOICES.find((v) => v.id === id) ?? null
}

/** Human label for a preset id; falls back to the id (e.g. a real cloned id). */
export function presetLabel(id: string): string {
  return findPresetVoice(id)?.name ?? id
}
