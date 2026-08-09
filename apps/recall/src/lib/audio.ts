/**
 * Browser-side audio extraction. Decodes a video/audio file with WebAudio,
 * downmixes to mono, resamples to a speech-friendly rate, and encodes a WAV —
 * small enough to upload to a transcription pipeline, no dependencies.
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

/**
 * Decode `file`'s audio once and return the uploadable 16 kHz mono WAV plus
 * its duration in seconds.
 */
export async function extractAudio(
  file: File,
  targetRate = 16000,
): Promise<{ wav: Blob; durationSec: number }> {
  const samples = await decodeToMono(file, targetRate)
  return {
    wav: encodeWav(samples, targetRate),
    durationSec: samples.length / targetRate,
  }
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
