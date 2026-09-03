export function credentials(env: NodeJS.ProcessEnv): { email: string; password: string } | undefined {
  const email = env.WORKFLOW_EMAIL || env.WORKFLOW_CI_EMAIL
  const password = env.WORKFLOW_PASSWORD || env.WORKFLOW_CI_PASSWORD
  return email && password ? { email, password } : undefined
}

export function adminKey(env: NodeJS.ProcessEnv): string | undefined {
  return env.ADMIN_API_KEY || undefined
}

/** A person's app token for the MCP walks (`bfat_…`); absent, the walk mints its own through the signed-in browser. */
export function appToken(env: NodeJS.ProcessEnv): string | undefined {
  return env.WORKFLOW_APP_TOKEN || undefined
}
