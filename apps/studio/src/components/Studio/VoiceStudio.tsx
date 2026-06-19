import { useState } from 'react'
import { formatTime } from '../../lib/edl'
import { VOICE_GROUPS } from '../../lib/voices'
import type { VoiceChoice, SavedVoice } from '../../store/studioSlice'
import { useRecorder } from './useRecorder'
import { MicMeter } from './MicMeter'

type Props = {
  voice: VoiceChoice | null
  savedVoices: SavedVoice[]
  cloning: boolean
  samplingVoice: boolean
  /** Clone from a recorded sample (uploads it, then mints a voice id). */
  onClone: (blob: Blob) => void
  /** Pick one of the MiniMax preset voices (no clone, no cost). */
  onPickPreset: (voiceId: string) => void
  /** Reuse a previously-cloned voice id (pasted or picked) — no clone, no cost. */
  onReuseVoiceId: (voiceId: string) => void
  /** Drop a saved id from the remembered list. */
  onForgetVoice: (voiceId: string) => void
  /** Discard the current voice and start the step over. */
  onClearVoice: () => void
  /** Speak a short canned line in the chosen voice; resolves to an audio URL. */
  onGenerateSample: () => Promise<string | null>
}

type Mode = 'clone' | 'saved' | 'preset'

/**
 * The voice step's resource — appears at the bottom of prep, under the scenes &
 * chapters. Two mutually exclusive paths: **clone your own** voice from a mic
 * recording, or **pick a preset** MiniMax voice. Once a voice is set, you can
 * generate a short sample to hear it. This produces the single durable voice the
 * Build step re-voices every scene with.
 */
export function VoiceStudio({
  voice,
  // Default guards a pre-existing persisted session whose state predates this
  // field (redux-persist rehydrate) — never let `.length` hit undefined.
  savedVoices = [],
  cloning,
  samplingVoice,
  onClone,
  onPickPreset,
  onReuseVoiceId,
  onForgetVoice,
  onClearVoice,
  onGenerateSample,
}: Props) {
  // Default to the "saved id" path when the user already has remembered voices —
  // reusing one is free, so it's the likely intent on a return visit.
  const [mode, setMode] = useState<Mode>(savedVoices.length > 0 ? 'saved' : 'clone')
  const [preset, setPreset] = useState(VOICE_GROUPS[0].voices[0].id)
  const [sampleUrl, setSampleUrl] = useState<string | null>(null)
  const recorder = useRecorder()

  async function playSample() {
    const url = await onGenerateSample()
    if (url) setSampleUrl(url)
  }

  function changeVoice() {
    setSampleUrl(null)
    recorder.reset()
    onClearVoice()
  }

  return (
    <div className="border rule bg-paper p-5">
      <div className="mb-3 flex items-baseline justify-between">
        <p className="meta-label">Your narration voice</p>
        <p className="font-mono text-[11px] text-ink-faint">
          {voice ? 'ready' : 'clone your own, or pick a preset'}
        </p>
      </div>

      {voice ? (
        <VoiceReady
          voice={voice}
          sampling={samplingVoice}
          sampleUrl={sampleUrl}
          onSample={playSample}
          onChange={changeVoice}
        />
      ) : (
        <>
          {/* Path toggle — same rounded pills as the rest of the page */}
          <div className="mb-4 flex flex-wrap gap-2">
            <button
              type="button"
              className={mode === 'clone' ? 'pill-cta' : 'pill-ghost'}
              onClick={() => setMode('clone')}
            >
              Clone my voice
            </button>
            <button
              type="button"
              className={mode === 'saved' ? 'pill-cta' : 'pill-ghost'}
              onClick={() => setMode('saved')}
            >
              Use a saved ID
            </button>
            <button
              type="button"
              className={mode === 'preset' ? 'pill-cta' : 'pill-ghost'}
              onClick={() => setMode('preset')}
            >
              Use a preset
            </button>
          </div>

          {mode === 'clone' ? (
            <ClonePanel recorder={recorder} cloning={cloning} onClone={onClone} />
          ) : mode === 'saved' ? (
            <SavedPanel
              savedVoices={savedVoices}
              onReuse={onReuseVoiceId}
              onForget={onForgetVoice}
            />
          ) : (
            <PresetPanel value={preset} onChange={setPreset} onUse={() => onPickPreset(preset)} />
          )}
        </>
      )}
    </div>
  )
}

function ClonePanel({
  recorder,
  cloning,
  onClone,
}: {
  recorder: ReturnType<typeof useRecorder>
  cloning: boolean
  onClone: (blob: Blob) => void
}) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13.5px] leading-relaxed text-ink-soft">
        Record ~20–30 seconds of clear speech — read anything naturally. We’ll send
        it to MiniMax voice-cloning to build a reusable voice.
      </p>

      {/* Recorder */}
      <div className="border rule bg-paper-deep/30 p-4">
        {recorder.status === 'recording' ? (
          <div className="flex flex-col gap-3">
            <MicMeter stream={recorder.stream} />
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 font-mono text-[12px] text-terracotta-ink">
                <span className="h-2 w-2 animate-pulse rounded-full bg-terracotta-ink" />
                recording · {formatTime(recorder.elapsed)}
              </span>
              <button type="button" className="pill-ghost" onClick={recorder.stop}>
                ■ Stop
              </button>
            </div>
          </div>
        ) : recorder.status === 'recorded' && recorder.url ? (
          <div className="flex flex-col gap-3">
            <audio src={recorder.url} controls className="h-9 w-full" />
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="pill-cta"
                disabled={cloning || !recorder.blob}
                onClick={() => recorder.blob && onClone(recorder.blob)}
              >
                {cloning ? 'Cloning…' : 'Clone my voice →'}
              </button>
              <button
                type="button"
                className="pill-ghost"
                disabled={cloning}
                onClick={recorder.reset}
              >
                Re-record
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <span className="text-[13px] text-ink-mute">No recording yet.</span>
            <button type="button" className="pill-cta" onClick={() => void recorder.start()}>
              ● Record
            </button>
          </div>
        )}
        {recorder.error && (
          <p className="mt-2 font-mono text-[12px] text-terracotta-ink">✕ {recorder.error}</p>
        )}
      </div>

      <p className="font-mono text-[11.5px] leading-relaxed text-ink-faint">
        ⚠ Cloning runs MiniMax and costs $3. We save the resulting id so you can
        reuse it for free next time — see “Use a saved ID”.
      </p>
    </div>
  )
}

function PresetPanel({
  value,
  onChange,
  onUse,
}: {
  value: string
  onChange: (id: string) => void
  onUse: () => void
}) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13.5px] leading-relaxed text-ink-soft">
        Skip cloning and narrate every scene with one of MiniMax’s built-in voices.
        Free and instant — no recording.
      </p>
      <label className="flex flex-col gap-1.5">
        <span className="meta-label">Preset voice</span>
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full max-w-sm rounded-md border border-paper-line bg-paper p-2.5 text-[14px] text-ink"
        >
          {VOICE_GROUPS.map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      <button type="button" className="pill-cta self-start" onClick={onUse}>
        Use this voice
      </button>
    </div>
  )
}

function SavedPanel({
  savedVoices,
  onReuse,
  onForget,
}: {
  savedVoices: SavedVoice[]
  onReuse: (voiceId: string) => void
  onForget: (voiceId: string) => void
}) {
  const [id, setId] = useState('')
  const trimmed = id.trim()
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13.5px] leading-relaxed text-ink-soft">
        Already cloned a voice before? MiniMax keeps it by id, so paste that id
        (e.g. <span className="font-mono text-ink">R8_FDU1SV5S</span>) to reuse it —
        no recording, no $3.
      </p>

      {/* `min-w-0` lets the input's flex slot shrink — without it the input's
          intrinsic (size-based) min width keeps the slot from yielding, so the
          full-width field overruns and the button lands on top of it. */}
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-0 flex-1 basis-56 flex-col gap-1.5">
          <span className="meta-label">Voice ID</span>
          <input
            type="text"
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="R8_…"
            className="w-full min-w-0 rounded-md border border-paper-line bg-paper p-2.5 font-mono text-[14px] text-ink"
          />
        </label>
        <button
          type="button"
          className="pill-cta shrink-0 whitespace-nowrap"
          disabled={!trimmed}
          onClick={() => onReuse(trimmed)}
        >
          Use this voice
        </button>
      </div>

      {savedVoices.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="meta-label">Saved voices</p>
          {/* Each row carries its own explicit "Use this voice" CTA: a saved id
              is the free path forward, so picking it to continue (→ play a
              sample) should be one obvious click, not a subtly-clickable row. */}
          <ul className="flex flex-col gap-1.5">
            {savedVoices.map((v) => (
              <li
                key={v.voiceId}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border rule bg-paper-deep/30 px-3 py-2"
              >
                <div className="min-w-0 flex-1 basis-40">
                  <span className="block truncate text-[13.5px] text-ink">{v.label}</span>
                  <span className="block truncate font-mono text-[11.5px] text-ink-mute">
                    {v.voiceId}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    className="pill-cta whitespace-nowrap"
                    onClick={() => onReuse(v.voiceId)}
                  >
                    Use this voice
                  </button>
                  <button
                    type="button"
                    className="shrink-0 font-mono text-[12px] text-ink-faint hover:text-terracotta-ink"
                    onClick={() => onForget(v.voiceId)}
                    title="Forget this id"
                  >
                    ✕
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

const SOURCE_LABEL: Record<VoiceChoice['source'], string> = {
  clone: 'cloned from your recording',
  saved: 'reused saved voice',
  preset: 'MiniMax preset',
}

function VoiceReady({
  voice,
  sampling,
  sampleUrl,
  onSample,
  onChange,
}: {
  voice: VoiceChoice
  sampling: boolean
  sampleUrl: string | null
  onSample: () => void
  onChange: () => void
}) {
  const [copied, setCopied] = useState(false)
  // Only your own voices have a reusable id worth copying; presets are public.
  const reusable = voice.source !== 'preset'

  function copyId() {
    void navigator.clipboard?.writeText(voice.voiceId)
    setCopied(true)
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 border-l-2 border-terracotta bg-terracotta/5 px-4 py-3">
        <div className="min-w-0">
          <p className="font-serif text-[18px] leading-tight text-ink">{voice.label}</p>
          <p className="mt-0.5 truncate font-mono text-[12px] text-ink-mute">
            {SOURCE_LABEL[voice.source]} · {voice.voiceId}
          </p>
        </div>
        <button type="button" className="pill-ghost" onClick={onChange}>
          Change voice
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="pill-cta" disabled={sampling} onClick={onSample}>
          {sampling ? 'Generating…' : '▶ Generate a sample'}
        </button>
        {reusable && (
          <button type="button" className="pill-ghost" onClick={copyId}>
            {copied ? 'Copied ✓' : 'Copy voice ID'}
          </button>
        )}
        {sampleUrl && <audio src={sampleUrl} controls autoPlay className="h-9 flex-1 min-w-[220px]" />}
      </div>

      {reusable && (
        <p className="font-mono text-[11.5px] leading-relaxed text-ink-faint">
          This id is saved for reuse — next time pick it under “Use a saved ID”
          instead of cloning again.
        </p>
      )}
    </div>
  )
}
