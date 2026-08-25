function handler({ request }) {
  // A bodyless POST has no `request.body`; the default code still applies.
  const body = request.body ?? {}
  return {
    code: String(body.code ?? 'FAIL'),
    error: 'fails on purpose',
  }
}
