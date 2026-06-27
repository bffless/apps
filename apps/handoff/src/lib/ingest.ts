/**
 * Browser-side file ingestion utilities for Handoff.
 *
 * Three entry points:
 *   - `filesFromDirectoryInput` — for a folder-drop `<input webkitdirectory>`
 *   - `filesFromZip`            — for a .zip file picked via file input
 *   - `filesFromDataTransfer`   — for an OS drag-and-drop (files and/or folders)
 *
 * All return `{ relPath, file }[]` ready for `planSiteUpload` / `planFolderImport`.
 */

import JSZip from 'jszip'

/**
 * Extract `{ relPath, file }` entries from a `<input type="file" webkitdirectory>`.
 * Uses `file.webkitRelativePath` when available; falls back to `file.name`.
 */
export function filesFromDirectoryInput(fileList: FileList): { relPath: string; file: File }[] {
  const result: { relPath: string; file: File }[] = []
  for (let i = 0; i < fileList.length; i++) {
    const file = fileList[i]
    if (!file) continue
    const relPath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
    result.push({ relPath, file })
  }
  return result
}

/**
 * Extract `{ relPath, file }` entries from a .zip File.
 * Directory entries (no data, name ending with '/') are skipped.
 */
export async function filesFromZip(zip: File): Promise<{ relPath: string; file: File }[]> {
  const loaded = await JSZip.loadAsync(zip)
  const result: { relPath: string; file: File }[] = []

  for (const [relPath, entry] of Object.entries(loaded.files)) {
    // Skip directory entries
    if (entry.dir) continue

    const blob = await entry.async('blob')
    const file = new File([blob], relPath.split('/').pop() ?? relPath, {
      type: blob.type || 'application/octet-stream',
    })
    result.push({ relPath, file })
  }

  return result
}

/**
 * Normalize a `FileSystemEntry.fullPath` (always leading-slash prefixed, e.g.
 * `/folder/sub/file.txt`) to the relPath shape the pickers produce — forward
 * slashes, no leading slash — so downstream `planSiteUpload` / `planFolderImport`
 * handle the rest. Falls back to `name` when `fullPath` is empty.
 */
export function entryRelPath(fullPath: string, name: string): string {
  return (fullPath || name).replace(/^\/+/, '')
}

/**
 * Synchronously inspect a drop's items and report whether any is a directory.
 *
 * MUST be called inside the drop handler before any `await` — `DataTransfer.items`
 * is invalidated once the event tick completes.
 */
export function dataTransferHasDirectory(dt: DataTransfer): boolean {
  const items = dt.items
  if (!items) return false
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (!item || (item.kind && item.kind !== 'file')) continue
    const entry = item.webkitGetAsEntry?.()
    if (entry?.isDirectory) return true
  }
  return false
}

function fileFromEntry(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject))
}

/**
 * `DirectoryReader.readEntries()` returns its children in batches — keep calling
 * until it yields an empty batch.
 */
async function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  const all: FileSystemEntry[] = []
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    )
    if (batch.length === 0) break
    all.push(...batch)
  }
  return all
}

async function collectEntry(
  entry: FileSystemEntry,
  out: { relPath: string; file: File }[],
): Promise<void> {
  if (entry.isFile) {
    const file = await fileFromEntry(entry as FileSystemFileEntry)
    out.push({ relPath: entryRelPath(entry.fullPath, entry.name), file })
    return
  }
  if (entry.isDirectory) {
    const children = await readAllEntries((entry as FileSystemDirectoryEntry).createReader())
    for (const child of children) {
      await collectEntry(child, out)
    }
  }
}

/**
 * Extract `{ relPath, file }` entries from an OS drag-and-drop `DataTransfer`,
 * recursing into any dropped directories. Produces the same shape as the pickers.
 *
 * Entries are captured synchronously up-front (the `items` list is invalidated
 * after the event tick); file/directory contents are then resolved async.
 * Falls back to the flat `dt.files` list when the FileSystem entry API is absent.
 */
export async function filesFromDataTransfer(
  dt: DataTransfer,
): Promise<{ relPath: string; file: File }[]> {
  // Capture entries synchronously — dt.items is invalidated after the event tick.
  const entries: FileSystemEntry[] = []
  const items = dt.items
  if (items) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (!item || (item.kind && item.kind !== 'file')) continue
      const entry = item.webkitGetAsEntry?.()
      if (entry) entries.push(entry)
    }
  }

  // Fallback: no FileSystem entry API available → flat file list.
  if (entries.length === 0) {
    return Array.from(dt.files ?? [], (file) => ({ relPath: file.name, file }))
  }

  const result: { relPath: string; file: File }[] = []
  for (const entry of entries) {
    await collectEntry(entry, result)
  }
  return result
}
