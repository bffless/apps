function handler({ request }) {
  // A bodyless POST has no `request.body`; echo the empty string back.
  const body = request.body ?? {}
  const text = String(body.text ?? '')
  const upper = body.upper === true || body.upper === 'true'
  return { text: upper ? text.toUpperCase() : text }
}
