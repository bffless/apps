/**
 * Browser-side audio extraction. Decodes a video/audio file with WebAudio,
 * downmixes to mono, resamples to a speech-friendly rate, and encodes a WAV —
 * small enough to upload to a transcription pipeline, no dependencies. This is
 * the same decoded PCM the waveform is drawn from.
 */

/** Decode `file`'s audio, downmix to mono, and resample to `targetRate`. */
async function decodeToMono(file: File, targetRate: number): Promise<Float32Array> {
  const arrayBuf = await file.arrayBuffer()
  const Ctx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  const ctx = new Ctx()
  const decoded = await ctx.decodeAudioData(arrayBuf).finally(() => void ctx.close())

  // Resample + downmix to mono by rendering through an OfflineAudioContext at
  // the target rate with a single output channel.
  const frames = Math.max(1, Math.ceil(decoded.duration * targetRate))
  const offline = new OfflineAudioContext(1, frames, targetRate)
  const source = offline.createBufferSource()
  source.buffer = decoded
  source.connect(offline.destination)
  source.start()
  const rendered = await offline.startRendering()
  return rendered.getChannelData(0)
}

/** Decode `file`'s audio → 16 kHz mono WAV Blob (PCM16). */
export async function extractAudioWav(file: File, targetRate = 16000): Promise<Blob> {
  return encodeWav(await decodeToMono(file, targetRate), targetRate)
}

/**
 * Decode once, return both the uploadable WAV **and** a tiny waveform summary —
 * so the extract step can show a "we got the audio" stenograph without the
 * cost of decoding the whole clip a second time just to draw it. The peaks are
 * a few hundred small numbers (cheap to persist), unlike the raw PCM.
 */
export async function extractAudio(
  file: File,
  targetRate = 16000,
): Promise<{ wav: Blob; peaks: number[] }> {
  const samples = await decodeToMono(file, targetRate)
  return { wav: encodeWav(samples, targetRate), peaks: computePeaks(samples) }
}

/**
 * Slice `[start, end]` (seconds) out of an already-uploaded audio clip and
 * re-encode it as a standalone WAV — used to "use the original audio here"
 * (story 03d): the source clip's own audio for a span becomes a real narration
 * clip we upload to the bucket, played like any other run. The whole-clip audio
 * was extracted 1:1 with the video timeline, so original-video seconds index
 * straight into it. Clamps the range to the decoded audio.
 */
export async function sliceAudioWav(
  url: string,
  start: number,
  end: number,
  targetRate = 16000,
): Promise<Blob> {
  const [blob] = await sliceManyAudioWav(url, [{ start, end }], targetRate)
  return blob
}

/**
 * The batch form (story 03j auto-adopt): fetch + decode the whole-clip audio
 * ONCE and slice every span from the same PCM — N segments cost one decode, not
 * N. Returns the WAVs in span order.
 */
export async function sliceManyAudioWav(
  url: string,
  spans: { start: number; end: number }[],
  targetRate = 16000,
): Promise<Blob[]> {
  if (!spans.length) return []
  const res = await fetch(url, { credentials: 'include' })
  if (!res.ok) throw new Error(`Couldn't load audio (${res.status})`)
  const blob = await res.blob()
  const file = new File([blob], 'audio.wav', { type: blob.type || 'audio/wav' })
  const samples = await decodeToMono(file, targetRate)
  return spans.map(({ start, end }) => {
    const lo = Math.max(0, Math.floor(Math.min(start, end) * targetRate))
    const hi = Math.min(samples.length, Math.ceil(Math.max(start, end) * targetRate))
    return encodeWav(samples.subarray(lo, Math.max(lo, hi)), targetRate)
  })
}

/**
 * Compute the waveform peaks from an already-uploaded audio URL — the fallback
 * for sessions whose audio was extracted before peaks were persisted (or any
 * time the summary is missing). Fetches the small WAV and decodes it once; the
 * raw PCM is dropped immediately, only the tiny peak array is kept.
 */
export async function peaksFromUrl(url: string): Promise<number[]> {
  const res = await fetch(url, { credentials: 'include' })
  if (!res.ok) throw new Error(`Couldn't load audio (${res.status})`)
  const blob = await res.blob()
  const file = new File([blob], 'audio.wav', { type: blob.type || 'audio/wav' })
  return computePeaks(await decodeToMono(file, 16000))
}

/**
 * Downsample mono PCM to `buckets` normalized peak amplitudes (0–1) for a
 * waveform bar chart. Each bucket keeps the loudest |sample| it covers; the
 * whole set is scaled so the loudest bucket hits 1, keeping quiet speech
 * visible. Rounded to two decimals so the persisted array stays ~1–2 KB.
 */
export function computePeaks(samples: Float32Array, buckets = 400): number[] {
  const size = Math.floor(samples.length / buckets) || 1
  const peaks: number[] = []
  let loudest = 1e-4
  for (let i = 0; i < buckets; i++) {
    let peak = 0
    for (let j = 0; j < size; j++) {
      const v = Math.abs(samples[i * size + j] ?? 0)
      if (v > peak) peak = v
    }
    peaks.push(peak)
    if (peak > loudest) loudest = peak
  }
  return peaks.map((p) => Math.round((p / loudest) * 100) / 100)
}

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeStr(36, 'data')
  view.setUint32(40, samples.length * 2, true)

  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    offset += 2
  }
  return new Blob([view], { type: 'audio/wav' })
}
