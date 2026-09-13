/**
 * The contact-sheet shape shared by the director, refiner and cut-editor
 * filmstrip. Sheets are built on the server (CE ffmpeg `frames` via
 * /api/video/contact-sheet) and mapped onto this type by `serverFrames.ts`.
 */

/** A composed contact sheet plus the metadata the director call needs. */
export type ContactSheet = {
  /** The composed grid as a data URL — PNG (lossless) unless size forced JPEG. */
  dataUrl: string
  width: number
  height: number
  cols: number
  rows: number
  /** One cell's drawn pixel size and the gap between cells — the geometry a CSS
   *  sprite needs to crop a single frame out of the sheet (the 03e build-step
   *  filmstrip). Derivable from `width/height/cols/rows`, but persisted so the
   *  sprite math is self-contained and survives any change to the gap/layout. */
  cellWidth: number
  cellHeight: number
  gap: number
  /** Frames actually drawn (≤ `times.length` if some captures failed). */
  count: number
  /** The original-video timestamps of this sheet's frames. */
  times: number[]
  /** Clip-wide sampling spacing (seconds) — same on every sheet. */
  interval: number
  /** Encoded byte size of `dataUrl` — kept ≤ `MAX_SHEET_BYTES`. */
  bytes: number
  /** Position in the set, for "Sheet 2 of 7". */
  index: number
  total: number
  /** Bucket URL once uploaded (story 03 feeds these to the director); the
   * `dataUrl` is the local preview, this is the persisted object. */
  url?: string
}
