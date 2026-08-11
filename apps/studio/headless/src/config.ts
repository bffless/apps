export type RunnerConfig = {
  baseUrl: string
  videoUrls: string[]
  fixturePaths: string[]
  directorPrompt: string
  projectTitle: string | null
  mockMode: boolean
  smokeStopAfterStart: boolean
  credentials: { email: string; password: string } | null
  buildTimeoutMs: number
  prepTimeoutMs: number
  directorTimeoutMs: number
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
    credentials,
    prepTimeoutMs: minutes(env, 'PREP_TIMEOUT_MINUTES', 30),
    directorTimeoutMs: minutes(env, 'DIRECTOR_TIMEOUT_MINUTES', 10),
    buildTimeoutMs: minutes(env, 'BUILD_TIMEOUT_MINUTES', 90),
  }
}
