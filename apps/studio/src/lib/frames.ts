/**
 * The contact-sheet shape shared by the director, refiner and cut-editor
 * filmstrip. Sheets are built on the server (CE ffmpeg `frames` via
 * /api/video/contact-sheet) and mapped onto this type by `serverFrames.ts`.
 */

/** A composed contact sheet plus the metadata the director call needs. */
export type ContactSheet = {
  /** Always '' for server sheets (the JPEG lives in the bucket at `url`); kept
   *  so sheets persisted before the server move still load. Never base64 in the store. */
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
  /** The server JPEG sheet's size in bytes, as CE reports it. */
  bytes: number
  /** Position in the set, for "Sheet 2 of 7". */
  index: number
  total: number
  /** The server JPEG sheet's bucket serve URL (story 03 feeds these to the
   *  director) — the persisted object. */
  url?: string
}
