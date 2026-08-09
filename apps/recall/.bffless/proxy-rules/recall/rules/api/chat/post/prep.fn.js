// Derives a conversation title from the first user message, for the
// ai step's `extraConversationFields: { title: "steps.prep.title" }`
// (Task: title conversations from first user message). Runs BEFORE the ai
// step so its output is available to that expression -- extraConversationFields
// is only evaluated on conversation CREATION (CE's ai.handler.ts,
// ensureConversationExists), so this derivation only ever runs once per
// conversation; later messages never rewrite the title.
//
// request.body.messages is the AI SDK's UIMessage array as sent by useChat's
// DefaultChatTransport. A message's text can show up in three shapes:
//   - { role, content: "text" }                         (legacy string form)
//   - { role, content: [{ type: 'text', text: '...' }] } (content-as-parts)
//   - { role, parts: [{ type: 'text', text: '...' }] }   (useChat v5 -- the
//     shape ChatTab.tsx actually sends; see its history-load code building
//     `parts: [{ type: 'text', text: msg.content }]` for the same convention)
// Same precedence CE's own ai.handler.ts uses when building model messages
// (string content, then parts), plus tolerating content-as-parts too.

var MAX_LEN = 60

function collapseWhitespace(s) {
  return String(s).replace(/\s+/g, ' ').trim()
}

function firstTextPart(parts) {
  if (!Array.isArray(parts)) return ''
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i]
    if (part && part.type === 'text' && typeof part.text === 'string') {
      return part.text
    }
  }
  return ''
}

function extractText(msg) {
  if (!msg) return ''
  if (typeof msg.content === 'string') return msg.content
  if (Array.isArray(msg.content)) return firstTextPart(msg.content)
  if (Array.isArray(msg.parts)) return firstTextPart(msg.parts)
  return ''
}

function truncate(text, maxLen) {
  if (text.length <= maxLen) return text
  var slice = text.slice(0, maxLen)
  var lastSpace = slice.lastIndexOf(' ')
  if (lastSpace > 0) slice = slice.slice(0, lastSpace)
  slice = slice.replace(/[\s.,;:!?-]+$/, '')
  return slice + '…'
}

function handler({ request }) {
  var body = (request && request.body) || {}
  var messages = Array.isArray(body.messages) ? body.messages : []

  var firstUser = null
  for (var i = 0; i < messages.length; i++) {
    if (messages[i] && messages[i].role === 'user') {
      firstUser = messages[i]
      break
    }
  }

  var collapsed = collapseWhitespace(extractText(firstUser))
  var title = collapsed ? truncate(collapsed, MAX_LEN) : ''

  return { title: title }
}
