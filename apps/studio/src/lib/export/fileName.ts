import { kebabSlug } from '../slug'

/**
 * The download filename of the stitched final cut, derived from the video's
 * title, e.g. "Overview of Onboarding Rules" → `overview-of-onboarding-rules.mp4`.
 * Shares the Blog bundle's kebab-case slug rule (`blogSlug`) so a video and its
 * post land as matching siblings on disk; falls back to `final-cut` when the
 * title is empty or punctuation-only.
 */
export function finalCutFileName(title: string): string {
  return `${kebabSlug(title) || 'final-cut'}.mp4`
}
