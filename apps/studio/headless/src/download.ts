import { createWriteStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const VIDEO_EXT = /\.(mp4|mov|webm|mkv|m4v)$/i

export function fileNameFor(url: string, index: number): string {
  const last = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')
  if (VIDEO_EXT.test(last)) return `${String(index).padStart(2, '0')}-${last}`
  return `source-${index}.mp4`
}

/** Fetch every URL to destDir (streaming — recordings can be GBs). */
export async function downloadAll(urls: string[], destDir: string): Promise<string[]> {
  const out: string[] = []
  for (const [i, url] of urls.entries()) {
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok || !res.body) throw new Error(`download failed (${res.status}) for ${url}`)
    const path = join(destDir, fileNameFor(url, i))
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(path))
    if ((await stat(path)).size === 0) throw new Error(`downloaded file is empty: ${url}`)
    out.push(path)
  }
  return out
}
