// Shapes the admin GET /api/messages?conversationId=<id> thread (Task 11):
// the right-panel message list for the Conversations viewer, oldest-first
// (a chat transcript reads top-to-bottom) -- the opposite sort direction
// from the conversation list, which is newest-first.
function handler({ steps }) {
  var rows = (steps && steps.query) || []
  if (!Array.isArray(rows)) rows = []

  var messages = []
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i] || {}
    messages.push({
      id: typeof r.id === 'string' ? r.id : null,
      role: typeof r.role === 'string' ? r.role : '',
      content: typeof r.content === 'string' ? r.content : '',
      createdAt: r.createdAt || null,
    })
  }

  messages.sort(function (a, b) {
    var at = a.createdAt ? new Date(a.createdAt).getTime() : 0
    var bt = b.createdAt ? new Date(b.createdAt).getTime() : 0
    return at - bt
  })

  return { messages: messages }
}
