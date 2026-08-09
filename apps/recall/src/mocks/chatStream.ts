/**
 * A static "SSE-ish" reply for the mock `POST /api/chat` handler, framed as the
 * AI SDK's UI Message Stream protocol — the wire format `@ai-sdk/react`'s
 * `useChat` + `DefaultChatTransport` expect (confirmed against
 * `node_modules/ai/dist/index.mjs`'s `JsonToSseTransformStream` +
 * `uiMessageChunkSchema`): each frame is `data: <json>\n\n`, the stream ends
 * with a literal `data: [DONE]\n\n`, and the response carries
 * `content-type: text/event-stream` + `x-vercel-ai-ui-message-stream: v1`.
 *
 * The reply text always cites `mock-1` in the exact
 * `[<title> @ mm:ss](https://www.youtube.com/watch?v=<id>&t=<sec>s)` format the
 * real chat rule's system prompt requires, so `CitationChip` has something
 * real to render offline — see `ChatMessages.tsx`.
 */

import { MOCK_PUBLIC_VIDEO } from './videoFixtures'

function sseFrame(chunk: Record<string, unknown>): string {
  return `data: ${JSON.stringify(chunk)}\n\n`
}

/** Splits a reply into a few word-ish deltas so the UI's streaming state is exercised. */
function toDeltas(text: string, chunkSize = 12): string[] {
  const deltas: string[] = []
  for (let i = 0; i < text.length; i += chunkSize) {
    deltas.push(text.slice(i, i + chunkSize))
  }
  return deltas
}

export function buildMockChatStream(): ReadableStream<Uint8Array> {
  const citation = `[${MOCK_PUBLIC_VIDEO.title} @ 00:04](https://www.youtube.com/watch?v=${MOCK_PUBLIC_VIDEO.youtubeId}&t=4s)`
  const replyText =
    `Publishing a video is the same action as indexing it — there's no separate ` +
    `visibility flag, so a draft simply has zero embeddings and can never surface ` +
    `here. See ${citation} for the moment this is covered.`

  const messageId = `mock-msg-${Date.now()}`
  const textId = 'mock-text-1'
  const deltas = toDeltas(replyText)

  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(sseFrame({ type: 'start', messageId })))
      controller.enqueue(encoder.encode(sseFrame({ type: 'text-start', id: textId })))
      for (const delta of deltas) {
        controller.enqueue(
          encoder.encode(sseFrame({ type: 'text-delta', id: textId, delta })),
        )
      }
      controller.enqueue(encoder.encode(sseFrame({ type: 'text-end', id: textId })))
      controller.enqueue(encoder.encode(sseFrame({ type: 'finish', finishReason: 'stop' })))
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
}
