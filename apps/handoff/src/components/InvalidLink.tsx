/**
 * InvalidLink — shared "this share link is no longer valid" page.
 * Used by ShareLinkEntry (/s/:token) and HandoffViewer (/view/:id?token=).
 */
export function InvalidLink() {
  return (
    <div className="flex min-h-svh items-center justify-center px-4">
      <div className="max-w-sm text-center">
        <div className="mb-4 flex justify-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-gray-100">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-7 w-7 text-gray-400">
              <path fillRule="evenodd" d="M10 1a4.5 4.5 0 0 0-4.5 4.5V9H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-.5V5.5A4.5 4.5 0 0 0 10 1Zm3 8V5.5a3 3 0 1 0-6 0V9h6Z" clipRule="evenodd" />
            </svg>
          </div>
        </div>
        <h1 className="mb-2 text-lg font-semibold text-gray-900">This link is no longer valid</h1>
        <p className="text-sm text-gray-500">
          The share link may have expired or been revoked by the owner.
        </p>
      </div>
    </div>
  )
}
