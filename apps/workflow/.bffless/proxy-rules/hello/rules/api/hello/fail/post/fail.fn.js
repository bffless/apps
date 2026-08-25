function handler({ request }) {
  return {
    code: String(request.body.code ?? 'FAIL'),
    error: 'fails on purpose',
  }
}
