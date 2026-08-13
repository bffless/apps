import { createWriteStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const VIDEO_EXT = /\.(mp4|mov|webm|mkv|m4v)$/i
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif)$/i

export function fileNameFor(url: string, index: number): string {
  const last = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')
  if (VIDEO_EXT.test(last)) return `${String(index).padStart(2, '0')}-${last}`
  return `source-${index}.mp4`
}

/** Name for a downloaded reference image: keep the URL's image filename, else
 *  derive the extension from the response content-type (default png). The name
 *  only has to make `setInputFiles` produce an `image/*` File — the app checks
 *  the type prefix, and the render pipeline reads the actual bytes. */
export function imageNameFor(url: string, contentType: string | null): string {
  const last = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')
  if (IMAGE_EXT.test(last)) return last
  const ext = /image\/(png|jpe?g|webp|gif|avif)/i.exec(contentType ?? '')?.[1]?.replace('jpeg', 'jpg')
  return `reference.${ext ?? 'png'}`
}

/** Fetch the thumbnail reference image to destDir. Returns its absolute path. */
export async function downloadImage(url: string, destDir: string): Promise<string> {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`reference image download failed (${res.status}) for ${url}`)
  const path = join(resolve(destDir), imageNameFor(url, res.headers.get('content-type')))
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(path))
  if ((await stat(path)).size === 0) throw new Error(`downloaded reference image is empty: ${url}`)
  return path
}

/** Fetch every URL to destDir (streaming — recordings can be GBs). Returns absolute paths. */
export async function downloadAll(urls: string[], destDir: string): Promise<string[]> {
  const absDest = resolve(destDir)
  const out: string[] = []
  for (const [i, url] of urls.entries()) {
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok || !res.body) throw new Error(`download failed (${res.status}) for ${url}`)
    const path = join(absDest, fileNameFor(url, i))
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(path))
    if ((await stat(path)).size === 0) throw new Error(`downloaded file is empty: ${url}`)
    out.push(path)
  }
  return out
}
