/** Studio's `?videoBackend=` override values (`apps/studio/src/lib/videoBackend.ts`). */
export type VideoBackend = 'wasm' | 'server' | 'local' | 'remote'
const VIDEO_BACKENDS: readonly VideoBackend[] = ['wasm', 'server', 'local', 'remote']

export type RunnerConfig = {
  baseUrl: string
  videoUrls: string[]
  fixturePaths: string[]
  directorPrompt: string
  projectTitle: string | null
  mockMode: boolean
  smokeStopAfterStart: boolean
  ffmpegMt: boolean
  /** Force Studio's video backend via `?videoBackend=`; null leaves the app's own choice. */
  videoBackend: VideoBackend | null
  credentials: { email: string; password: string } | null
  buildTimeoutMs: number
  buildStallTimeoutMs: number
  prepTimeoutMs: number
  directorTimeoutMs: number
  /** Free-text notes typed into the thumbnail card before drafting the prompt. */
  thumbnailPrompt: string
  /** Optional image URL downloaded and attached as the thumbnail reference. */
  thumbnailReferenceUrl: string | null
  /** Generate the blog post (and capture its bundle) after the thumbnail. */
  generateBlog: boolean
  /** Optional direction typed into the blog card before generating. */
  blogDirection: string
  describeTimeoutMs: number
  thumbnailTimeoutMs: number
  blogTimeoutMs: number
}

/** Validate an optional single http(s) URL input (e.g. the thumbnail reference). */
export function parseOptionalUrl(raw: string | undefined, name: string): string | null {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return null
  let parsed: URL
  try { parsed = new URL(trimmed) } catch { throw new Error(`${name} is not a valid URL: ${trimmed}`) }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`${name} has an unsupported protocol (need http/https): ${trimmed}`)
  }
  return trimmed
}

/** Validate an optional video-backend override (`VIDEO_BACKEND`); empty → null, unknown → throws. */
export function parseVideoBackend(raw: string | undefined, name: string): VideoBackend | null {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return null
  if (!(VIDEO_BACKENDS as readonly string[]).includes(trimmed)) {
    throw new Error(`${name} must be one of ${VIDEO_BACKENDS.join(' | ')}, got: ${trimmed}`)
  }
  return trimmed as VideoBackend
}

export function parseVideoUrls(raw: string): string[] {
  const urls = raw.split(/[\r\n,]+/).map((s) => s.trim()).filter(Boolean)
  if (urls.length === 0) throw new Error('video_urls is empty — pass at least one source video URL')
  for (const u of urls) {
    let parsed: URL
    try { parsed = new URL(u) } catch { throw new Error(`video_urls entry is not a valid URL: ${u}`) }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error(`video_urls entry has an unsupported protocol (need http/https): ${u}`)
    }
  }
  return urls
}

const minutes = (env: NodeJS.ProcessEnv, key: string, fallback: number): number => {
  const raw = env[key]
  if (!raw) return fallback * 60_000
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${key} must be a positive number of minutes, got: ${raw}`)
  return n * 60_000
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const baseUrl = (env.STUDIO_BASE_URL ?? '').replace(/\/$/, '')
  if (!baseUrl) throw new Error('STUDIO_BASE_URL is required')
  const mockMode = env.MOCK_MODE === 'true'
  const fixturePaths = mockMode
    ? (env.FIXTURE_PATHS ?? '').split(/[\r\n,]+/).map((s) => s.trim()).filter(Boolean)
    : []
  if (mockMode && fixturePaths.length === 0) throw new Error('FIXTURE_PATHS is required in mock mode')
  const videoUrls = mockMode ? [] : parseVideoUrls(env.VIDEO_URLS ?? '')
  let credentials: RunnerConfig['credentials'] = null
  if (!mockMode) {
    if (!env.STUDIO_USER_EMAIL) throw new Error('STUDIO_USER_EMAIL is required')
    if (!env.STUDIO_USER_PASSWORD) throw new Error('STUDIO_USER_PASSWORD is required')
    credentials = { email: env.STUDIO_USER_EMAIL, password: env.STUDIO_USER_PASSWORD }
  }
  return {
    baseUrl,
    videoUrls,
    fixturePaths,
    directorPrompt: env.DIRECTOR_PROMPT ?? '',
    projectTitle: env.PROJECT_TITLE || null,
    mockMode,
    smokeStopAfterStart: env.SMOKE_STOP_AFTER_START === 'true',
    ffmpegMt: env.FFMPEG_MT === 'true',
    videoBackend: parseVideoBackend(env.VIDEO_BACKEND, 'video_backend'),
    credentials,
    prepTimeoutMs: minutes(env, 'PREP_TIMEOUT_MINUTES', 30),
    directorTimeoutMs: minutes(env, 'DIRECTOR_TIMEOUT_MINUTES', 10),
    buildTimeoutMs: minutes(env, 'BUILD_TIMEOUT_MINUTES', 90),
    // A frozen progress line for this long is a wedge, not slow progress:
    // fail with the frozen state instead of burning the whole build budget.
    buildStallTimeoutMs: minutes(env, 'BUILD_STALL_MINUTES', 20),
    thumbnailPrompt: env.THUMBNAIL_PROMPT ?? '',
    thumbnailReferenceUrl: parseOptionalUrl(env.THUMBNAIL_REFERENCE_URL, 'thumbnail_reference_url'),
    generateBlog: env.GENERATE_BLOG === 'true',
    blogDirection: env.BLOG_DIRECTION ?? '',
    describeTimeoutMs: minutes(env, 'DESCRIBE_TIMEOUT_MINUTES', 5),
    thumbnailTimeoutMs: minutes(env, 'THUMBNAIL_TIMEOUT_MINUTES', 10),
    blogTimeoutMs: minutes(env, 'BLOG_TIMEOUT_MINUTES', 15),
  }
}
