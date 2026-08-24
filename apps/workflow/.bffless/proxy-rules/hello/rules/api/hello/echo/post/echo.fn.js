function handler({ request }) {
  const text = String(request.body.text ?? '')
  const upper = request.body.upper === true || request.body.upper === 'true'
  return { text: upper ? text.toUpperCase() : text }
}
