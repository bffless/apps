// Sync-side validation for GET /api/messages?conversationId=<id> (Task 11).
// Mirrors the ok/notOk sentinel convention used throughout this app
// (gate.fn.js, api/search/post/prep.fn.js, _custom/video-get's prep.fn.js).
function handler({ request }) {
  var q = (request && request.query) || {}
  var conversationId = typeof q.conversationId === 'string' ? q.conversationId.trim() : ''
  if (!conversationId) {
    return { ok: false, notOk: true, reason: 'CONVERSATION_ID_REQUIRED', conversationId: '' }
  }
  return { ok: true, notOk: false, reason: '', conversationId: conversationId }
}
