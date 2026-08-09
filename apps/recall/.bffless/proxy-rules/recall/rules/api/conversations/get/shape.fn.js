// Shapes the admin GET /api/conversations list (Task 11): a lightweight
// summary per recall_conversations row for the Conversations viewer's left
// list -- title, model, and the running message_count/total_tokens counters
// the chat rule maintains, plus createdAt for sorting/display. Message
// bodies live in recall_messages and are fetched separately (per-conversation)
// by GET /api/messages once an admin picks one, same split as Studio's
// project list vs. project detail.
function num(v) {
  var n = Number(v)
  return typeof v !== 'undefined' && v !== null && !isNaN(n) ? n : 0
}

function str(v) {
  return typeof v === 'string' ? v : null
}

function handler({ steps }) {
  var rows = (steps && steps.query) || []
  if (!Array.isArray(rows)) rows = []

  var conversations = []
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i] || {}
    conversations.push({
      id: typeof r.id === 'string' ? r.id : null,
      title: str(r.title),
      model: typeof r.model === 'string' ? r.model : '',
      message_count: num(r.message_count),
      total_tokens: num(r.total_tokens),
      createdAt: r.createdAt || null,
    })
  }

  conversations.sort(function (a, b) {
    var at = a.createdAt ? new Date(a.createdAt).getTime() : 0
    var bt = b.createdAt ? new Date(b.createdAt).getTime() : 0
    return bt - at
  })

  return { conversations: conversations }
}
