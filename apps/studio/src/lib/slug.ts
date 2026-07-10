/**
 * Download filenames derived from the video's title.
 *
 * These names reach the browser two different ways and must agree: the
 * freshly-stitched blob uses the `<a download>` attribute, while the saved cut
 * relies on `Content-Disposition` signed into the bucket URL (`<a download>` is
 * ignored cross-origin). One slug rule, so both produce the same file.
 */

/**
 * "Overview of Onboarding Rules" → "overview-of-onboarding-rules".
 * Collapses any run of non-alphanumerics to a single hyphen and trims the ends.
 * Returns "" when the title is empty or punctuation-only — callers supply the
 * fallback, because it differs per file type.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** e.g. "overview-of-onboarding-rules.jpg"; "thumbnail.jpg" when untitled. */
export function thumbnailFileName(title: string): string {
  return `${slugify(title) || 'thumbnail'}.jpg`
}

/** e.g. "custom-ai-content-pipeline.mp4"; "studio-final-cut.mp4" when untitled. */
export function finalCutFileName(title: string): string {
  return `${slugify(title) || 'studio-final-cut'}.mp4`
}
