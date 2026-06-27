import { describe, it, expect } from 'vitest'
import { entryRelPath, dataTransferHasDirectory, filesFromDataTransfer } from './ingest'

// --- Mocked FileSystem Entry helpers (jsdom has no webkitGetAsEntry / FileSystemEntry) ---

function fileEntry(fullPath: string, name: string, content = name) {
  return {
    isFile: true,
    isDirectory: false,
    name,
    fullPath,
    file: (cb: (f: File) => void) => cb(new File([content], name, { type: 'text/plain' })),
  }
}

// Pages one child per readEntries() call to exercise the batched-read loop,
// then returns [] to signal the end (mirrors the real DirectoryReader contract).
function dirEntry(
  fullPath: string,
  name: string,
  children: unknown[],
): { isFile: false; isDirectory: true; name: string; fullPath: string; createReader: () => unknown } {
  return {
    isFile: false,
    isDirectory: true,
    name,
    fullPath,
    createReader: () => {
      let i = 0
      return {
        readEntries: (cb: (batch: unknown[]) => void) => {
          if (i >= children.length) {
            cb([])
            return
          }
          cb(children.slice(i, i + 1))
          i += 1
        },
      }
    },
  }
}

function dtFromEntries(entries: unknown[], files: File[] = []): DataTransfer {
  return {
    items: entries.map((e) => ({ kind: 'file', webkitGetAsEntry: () => e })),
    files,
  } as unknown as DataTransfer
}

function dtFromFiles(files: File[]): DataTransfer {
  // No `items` with webkitGetAsEntry — forces the flat fallback.
  return { files } as unknown as DataTransfer
}

describe('entryRelPath', () => {
  it('strips the leading slash from a nested fullPath', () => {
    expect(entryRelPath('/a/b.txt', 'b.txt')).toBe('a/b.txt')
  })

  it('strips the leading slash from a root-level fullPath', () => {
    expect(entryRelPath('/x.txt', 'x.txt')).toBe('x.txt')
  })

  it('falls back to name when fullPath is empty', () => {
    expect(entryRelPath('', 'y.txt')).toBe('y.txt')
  })
})

describe('dataTransferHasDirectory', () => {
  it('is true when any dropped entry is a directory', () => {
    const dt = dtFromEntries([fileEntry('/a.txt', 'a.txt'), dirEntry('/d', 'd', [])])
    expect(dataTransferHasDirectory(dt)).toBe(true)
  })

  it('is false when all dropped entries are files', () => {
    const dt = dtFromEntries([fileEntry('/a.txt', 'a.txt'), fileEntry('/b.txt', 'b.txt')])
    expect(dataTransferHasDirectory(dt)).toBe(false)
  })

  it('is false when there are no FS entries (flat files only)', () => {
    const dt = dtFromFiles([new File(['x'], 'x.txt')])
    expect(dataTransferHasDirectory(dt)).toBe(false)
  })
})

describe('filesFromDataTransfer', () => {
  it('recurses a nested directory tree into the {relPath, file}[] shape', async () => {
    const tree = dirEntry('/site', 'site', [
      fileEntry('/site/index.html', 'index.html'),
      dirEntry('/site/assets', 'assets', [fileEntry('/site/assets/app.js', 'app.js')]),
    ])
    const dt = dtFromEntries([tree])

    const result = await filesFromDataTransfer(dt)
    const relPaths = result.map((r) => r.relPath).sort()

    expect(relPaths).toEqual(['site/assets/app.js', 'site/index.html'])
    // Real File objects are preserved
    expect(result.every((r) => r.file instanceof File)).toBe(true)
  })

  it('handles a mix of a loose file and a folder', async () => {
    const dt = dtFromEntries([
      fileEntry('/readme.txt', 'readme.txt'),
      dirEntry('/pics', 'pics', [fileEntry('/pics/cat.png', 'cat.png')]),
    ])

    const result = await filesFromDataTransfer(dt)
    expect(result.map((r) => r.relPath).sort()).toEqual(['pics/cat.png', 'readme.txt'])
  })

  it('falls back to flat dt.files when webkitGetAsEntry is unavailable', async () => {
    const dt = dtFromFiles([new File(['a'], 'a.txt'), new File(['b'], 'b.txt')])

    const result = await filesFromDataTransfer(dt)
    expect(result.map((r) => r.relPath).sort()).toEqual(['a.txt', 'b.txt'])
    expect(result.every((r) => r.file instanceof File)).toBe(true)
  })
})
