/**
 * Every File ref a run holds, by path — so a `type: file` value that arrived
 * as a bare path string (a job- or run-level output evaluated from one; a
 * row written before the form adapter recorded refs) still renders as the
 * file it names, with its real name, size and content type. A path the run
 * never registered resolves to a ref built from the path alone: the file-serve
 * url, the last segment as the name, the content type guessed from the
 * extension — enough for a Download, and a preview when the type is known.
 *
 * The provider is the run page (it has the state); with no provider, only the
 * synthesized ref is available.
 */
import { createContext, useContext } from 'react'
import { fileUrl } from '../../lib/coerce'
import type { FileRef, RunState } from '../../lib/runner/types'
import { isFileRef } from './fileRef'

export const FileRefIndex = createContext<ReadonlyMap<string, FileRef> | null>(null)

const TYPES: Record<string, string> = {
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  pdf: 'application/pdf',
  json: 'application/json',
  md: 'text/markdown',
  txt: 'text/plain',
}

/** A ref from nothing but a storage path. */
export function refFromPath(path: string): FileRef {
  const name = path.split('/').pop() || path
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  // Unknown size and, for an unknown extension, unknown type: the file row
  // shows neither rather than inventing them.
  return { path, name, url: fileUrl(path), contentType: TYPES[ext] ?? '', size: 0 }
}

/** Walk a value for File refs — outputs, inputs, lists, nested objects (bounded). */
function collect(value: unknown, into: Map<string, FileRef>, depth = 0): void {
  if (depth > 6 || value === null || typeof value !== 'object') return
  if (isFileRef(value)) {
    if (!into.has(value.path)) into.set(value.path, value)
    return
  }
  const entries = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)
  for (const entry of entries) collect(entry, into, depth + 1)
}

/** Every ref a run's rows hold, by path. */
export function indexFileRefs(state: RunState): Map<string, FileRef> {
  const refs = new Map<string, FileRef>()
  collect(state.inputs, refs)
  for (const step of Object.values(state.steps)) {
    collect(step.inputs, refs)
    collect(step.outputs, refs)
  }
  collect(state.outputs, refs)
  return refs
}

/** `path → ref`: the run's own ref for that path when it has one, else one built from the path. */
export function useFileRefs(): (path: string) => FileRef | undefined {
  const index = useContext(FileRefIndex)
  return (path) => (path === '' ? undefined : (index?.get(path) ?? refFromPath(path)))
}
