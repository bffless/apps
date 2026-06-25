/**
 * Root listing page for Handoff.
 *
 * Shows the files at parentId='root', with loading / empty / error states.
 * An Upload button triggers the presigned flow (prepare → PUT → register);
 * tag invalidation causes the listing to refetch automatically on success.
 */

import { useRef, useState } from 'react'
import { useListNodesQuery, useUploadFileMutation } from '../store/handoffApi'
import { formatBytes } from '../lib/format'
import type { HandoffNode } from '../lib/nodes'

// ---------------------------------------------------------------------------
// NodeList — renders the file grid
// ---------------------------------------------------------------------------

function NodeRow({ node }: { node: HandoffNode }) {
  const hint = node.mime ?? node.type
  return (
    <div className="flex items-center gap-3 rounded-lg border border-gray-100 bg-white px-4 py-3 shadow-sm">
      {/* Icon / type indicator */}
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-gray-50 text-gray-400">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
          <path d="M3 3.5A1.5 1.5 0 0 1 4.5 2h6.879a1.5 1.5 0 0 1 1.06.44l4.122 4.12A1.5 1.5 0 0 1 17 7.622V16.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 16.5v-13Z" />
        </svg>
      </div>
      {/* Name + hint */}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-gray-900">{node.name}</p>
        <p className="truncate text-xs text-gray-400">{hint}</p>
      </div>
      {/* Size */}
      {node.size !== null && (
        <span className="shrink-0 text-xs text-gray-400">{formatBytes(node.size)}</span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// UploadButton
// ---------------------------------------------------------------------------

interface UploadButtonProps {
  onFile: (file: File) => void
  uploading: boolean
}

function UploadButton({ onFile, uploading }: UploadButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        aria-label="File input"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) onFile(file)
          // Reset so picking the same file again triggers onChange
          e.target.value = ''
        }}
      />
      <button
        type="button"
        disabled={uploading}
        onClick={() => inputRef.current?.click()}
        className="inline-flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {uploading ? (
          <>
            <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
            </svg>
            Uploading…
          </>
        ) : (
          <>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
              <path d="M10.75 2.75a.75.75 0 0 0-1.5 0v8.614L6.295 8.235a.75.75 0 1 0-1.09 1.03l4.25 4.5a.75.75 0 0 0 1.09 0l4.25-4.5a.75.75 0 0 0-1.09-1.03l-2.955 3.129V2.75Z" />
              <path d="M3.5 12.75a.75.75 0 0 0-1.5 0v2.5A2.75 2.75 0 0 0 4.75 18h10.5A2.75 2.75 0 0 0 18 15.25v-2.5a.75.75 0 0 0-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5Z" />
            </svg>
            Upload
          </>
        )}
      </button>
    </>
  )
}

// ---------------------------------------------------------------------------
// HandoffHome
// ---------------------------------------------------------------------------

export function HandoffHome() {
  const { data: nodes, isLoading, isError, error } = useListNodesQuery({ parentId: 'root' })
  const [uploadFile, { isLoading: uploading, error: uploadError }] = useUploadFileMutation()
  const [uploadDone, setUploadDone] = useState(false)

  async function handleFile(file: File) {
    setUploadDone(false)
    const result = await uploadFile({ file, parentId: 'root' })
    if (!('error' in result)) {
      setUploadDone(true)
      setTimeout(() => setUploadDone(false), 3000)
    }
  }

  // Coerce RTK error to a display string
  const uploadErrorMsg = uploadError
    ? 'error' in uploadError
      ? (uploadError as { error: string }).error
      : `Upload failed (${(uploadError as { status: string | number }).status})`
    : null

  return (
    <div className="container-page py-10">
      {/* Toolbar */}
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-900">My Files</h1>
        <UploadButton onFile={handleFile} uploading={uploading} />
      </div>

      {/* Upload feedback */}
      {uploadErrorMsg && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {uploadErrorMsg}
        </div>
      )}
      {uploadDone && (
        <div className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          File uploaded successfully.
        </div>
      )}

      {/* Loading state */}
      {isLoading && (
        <div className="py-16 text-center text-sm text-gray-400">Loading…</div>
      )}

      {/* Error state */}
      {isError && !isLoading && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-8 text-center text-sm text-red-600">
          {error && 'error' in (error as object)
            ? (error as { error: string }).error
            : 'Failed to load files. Please refresh.'}
        </div>
      )}

      {/* Empty state */}
      {!isLoading && !isError && nodes?.length === 0 && (
        <div className="py-16 text-center text-sm text-gray-400">
          No content yet — upload a file to get started
        </div>
      )}

      {/* File list */}
      {!isLoading && !isError && nodes && nodes.length > 0 && (
        <div className="flex flex-col gap-2">
          {nodes.map((node) => (
            <NodeRow key={node.id} node={node} />
          ))}
        </div>
      )}
    </div>
  )
}
