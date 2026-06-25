/**
 * Browser-side file ingestion utilities for Handoff.
 *
 * Two entry points:
 *   - `filesFromDirectoryInput` — for a folder-drop `<input webkitdirectory>`
 *   - `filesFromZip`            — for a .zip file picked via file input
 *
 * Both return `{ relPath, file }[]` ready for `planSiteUpload`.
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
