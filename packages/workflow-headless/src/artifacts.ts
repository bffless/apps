/**
 * What a CI run keeps: the record, the file outputs, the transition log, the
 * page console and the milestone screenshots.
 *
 * File outputs are fetched through the page's own session (`ApiLike`), from
 * the ref's `url` with **no** `?download=1` — the harness serves the bytes
 * either way and the flag is not something the driver relies on (apps#362).
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ApiLike } from './api.js'
import type { Transition } from './observe.js'
import { formatTransition } from './observe.js'
import type { FileRef } from './upload.js'

const EXTENSIONS: Record<string, string> = {
  'application/json': 'json',
  'application/pdf': 'pdf',
  'application/yaml': 'yaml',
  'application/zip': 'zip',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'text/csv': 'csv',
  'text/html': 'html',
  'text/markdown': 'md',
  'text/plain': 'txt',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
}

/** Content type first (it is what the harness stored), then the ref's own name. */
export function extensionFor(contentType: string | undefined, name: string | undefined): string {
  const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase()
  const known = EXTENSIONS[type]
  if (known) return known
  const dot = (name ?? '').lastIndexOf('.')
  if (dot > 0 && dot < (name ?? '').length - 1) return (name ?? '').slice(dot + 1)
  return 'bin'
}

function asRef(value: unknown): FileRef | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const r = value as Record<string, unknown>
  if (typeof r.path !== 'string' || typeof r.url !== 'string') return undefined
  return {
    path: r.path,
    name: typeof r.name === 'string' ? r.name : r.path.split('/').pop() ?? 'file',
    contentType: typeof r.contentType === 'string' ? r.contentType : 'application/octet-stream',
    size: typeof r.size === 'number' ? r.size : 0,
    url: r.url,
  }
}

export interface OutputFile {
  /** The name the bytes are saved under, inside `outputs/`. */
  file: string
  ref: FileRef
  /** The run output this came from — what a failure is reported against. */
  output?: string
}

/**
 * The run's `file` outputs, named after the output rather than after the
 * stored file: `poster` → `poster.svg`, a `list` → `posters-1.png`,
 * `posters-2.png`. Everything that is not a File ref is skipped.
 */
export function fileOutputs(outputs: Record<string, unknown>): OutputFile[] {
  const found: OutputFile[] = []
  for (const [name, value] of Object.entries(outputs)) {
    if (Array.isArray(value)) {
      value.forEach((entry, i) => {
        const ref = asRef(entry)
        if (ref) {
          found.push({
            file: `${name}-${i + 1}.${extensionFor(ref.contentType, ref.name)}`,
            ref,
            output: name,
          })
        }
      })
      continue
    }
    const ref = asRef(value)
    if (ref) {
      found.push({ file: `${name}.${extensionFor(ref.contentType, ref.name)}`, ref, output: name })
    }
  }
  return found
}

export async function writeRunRecord(out: string, record: unknown): Promise<string> {
  await mkdir(out, { recursive: true })
  const path = join(out, 'run.json')
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  return path
}

export async function writeStepsLog(out: string, transitions: Transition[]): Promise<string> {
  await mkdir(out, { recursive: true })
  const path = join(out, 'steps.log')
  await writeFile(path, transitions.map((t) => `${formatTransition(t)}\n`).join(''), 'utf8')
  return path
}

export async function writeConsoleLog(out: string, lines: string[]): Promise<string> {
  await mkdir(out, { recursive: true })
  const path = join(out, 'console.log')
  await writeFile(path, lines.map((line) => `${line}\n`).join(''), 'utf8')
  return path
}

export interface DownloadResult {
  written: string[]
  /** `<output> (<status>)` for each output whose bytes could not be fetched. */
  failed: string[]
}

/**
 * Every file output, saved under `<out>/outputs/`. One that will not download
 * is *reported*, never thrown: the run itself succeeded, and losing the whole
 * artifact set over one unreadable ref helps nobody.
 */
export async function downloadOutputs(
  api: ApiLike,
  out: string,
  outputs: Record<string, unknown>,
): Promise<DownloadResult> {
  const files = fileOutputs(outputs)
  const result: DownloadResult = { written: [], failed: [] }
  if (files.length === 0) return result

  const dir = join(out, 'outputs')
  await mkdir(dir, { recursive: true })

  for (const { file, ref, output } of files) {
    const res = await api.bytes(ref.url)
    if (res.status < 200 || res.status >= 300) {
      result.failed.push(`${output ?? file} (${res.status})`)
      continue
    }
    const path = join(dir, file)
    await writeFile(path, res.bytes)
    result.written.push(path)
  }
  return result
}
