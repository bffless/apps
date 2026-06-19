export const MOCK_ROLES = ['admin', 'user', 'member'] as const
export type MockRole = (typeof MOCK_ROLES)[number]

export type MockUser = {
  id: string
  email?: string
  role: MockRole
}

export type MockAuthState = {
  enabled: boolean
  authenticated: boolean
  user: MockUser
}

export const STORAGE_KEY = 'bffless:mockAuth'
export const CHANGE_EVENT = 'bffless:mockAuth:change'

const DEFAULT_STATE: MockAuthState = {
  enabled: true,
  authenticated: false,
  user: { id: 'dev-user-1', email: 'dev@example.com', role: 'user' },
}

export function readMockAuth(): MockAuthState {
  if (typeof localStorage === 'undefined') return DEFAULT_STATE
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_STATE
    const parsed = JSON.parse(raw) as Partial<MockAuthState>
    const parsedUser: Partial<MockUser> = parsed.user ?? {}
    const role: MockRole = MOCK_ROLES.includes(parsedUser.role as MockRole)
      ? (parsedUser.role as MockRole)
      : DEFAULT_STATE.user.role
    return {
      enabled: parsed.enabled ?? DEFAULT_STATE.enabled,
      authenticated: parsed.authenticated ?? DEFAULT_STATE.authenticated,
      user: { ...DEFAULT_STATE.user, ...parsedUser, role },
    }
  } catch {
    return DEFAULT_STATE
  }
}

export function writeMockAuth(next: MockAuthState): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: next }))
}
