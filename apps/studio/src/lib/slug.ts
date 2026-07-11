/**
 * The one slug rule Studio names downloads with: lowercased, every run of
 * non-alphanumerics collapsed to a single hyphen, leading/trailing hyphens
 * trimmed. Returns `''` for an empty or punctuation-only input — callers pick
 * their own fallback (`post`, `final-cut`, …).
 */
export function kebabSlug(value: string): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
