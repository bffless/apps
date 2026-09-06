export function credentials(env: NodeJS.ProcessEnv): { email: string; password: string } | undefined {
  const email = env.WORKFLOW_EMAIL || env.WORKFLOW_CI_EMAIL
  const password = env.WORKFLOW_PASSWORD || env.WORKFLOW_CI_PASSWORD
  return email && password ? { email, password } : undefined
}

export function adminKey(env: NodeJS.ProcessEnv): string | undefined {
  return env.ADMIN_API_KEY || undefined
}

/**
 * A person's app token (`bfat_…`) for the MCP and driven walks; absent, the
 * walk mints its own through the signed-in browser. Minted with
 * `auth:session` (apps#588) it is also the walk's login — `driven` and `mcp`
 * run from it alone, with no `credentials`.
 */
export function appToken(env: NodeJS.ProcessEnv): string | undefined {
  return env.WORKFLOW_APP_TOKEN || undefined
}
