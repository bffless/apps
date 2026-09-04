/**
 * `render: images` (02): a grid of File refs, each shown as its own `<img>`
 * plus a Download link when it actually is an image the renderer is willing
 * to point a `src` at — an `image/*` ref whose `url` is same-origin, or
 * presigned by this page (D6) (`isLoadableUrl`, Task 15's P1 ruling; the
 * stricter media-sink gate, not `FileCard`'s own `isSafeUrl`, because this
 * component builds the `src` itself rather than trusting a writer-supplied
 * player choice).
 *
 * A ref that fails either half of that (not an image, or an image on another
 * origin) falls back to the ordinary `FileCard` — still a legitimate way to
 * show a file, just not inline as a grid tile. A list item that is not a File
 * ref at all falls back to `JsonTree`, the same "still show something"
 * fallback every renderer in this directory shares.
 */
import { downloadHref, isLoadableUrl } from '../../../lib/url'
import type { FileRef } from '../../../lib/runner/types'
import { FileCard } from '../FileCard'
import { isFileRef } from '../fileRef'
import { JsonTree } from '../JsonTree'

function ImageItem({ fileRef }: { fileRef: FileRef }) {
  const isImage = fileRef.contentType?.startsWith('image/') && isLoadableUrl(fileRef.url)
  if (!isImage) return <FileCard refValue={fileRef} />

  return (
    <div className="images-grid-item">
      <img src={fileRef.url} alt={fileRef.name} />
      <a className="images-grid-download" href={downloadHref(fileRef.url)} download>
        Download
      </a>
    </div>
  )
}

export function ImagesView({ value }: { value: unknown }) {
  const items = Array.isArray(value) ? value : [value]

  return (
    <div className="images-grid" data-testid="renderer" data-render="images">
      {items.map((item, i) =>
        isFileRef(item) ? <ImageItem key={i} fileRef={item} /> : <JsonTree key={i} value={item} />,
      )}
    </div>
  )
}
