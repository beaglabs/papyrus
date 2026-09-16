import type { UIMessage } from 'ai'

/**
 * The body for one chat turn.
 *
 * The daemon reads only the newest user message. `MastraRuntime.chat` selects it
 * and hands Mastra `messages: [thatMessage]` alongside
 * `memory: { thread, resource }`, so conversation history comes from the durable
 * thread rather than from the browser.
 *
 * Sending the whole transcript therefore transports data the server throws away —
 * and because the transport re-sends it on every turn, it grows monotonically. A
 * document session (a generated PDF, its artifacts, the tool results around them)
 * reaches the 1 MiB request cap and every later turn fails with `BODY_TOO_LARGE`,
 * with nothing in the UI explaining that the conversation is the thing that got
 * too big.
 *
 * `useChat` still keeps the full message list for rendering. Only what goes on the
 * wire is trimmed, which also makes every turn cheaper to send.
 */
export interface ChatRequestBody {
  threadId: string
  messages: UIMessage[]
  trigger: unknown
  attachments: Array<{ path: string }>
}

export function chatRequestBody(input: {
  threadId: string
  messages: UIMessage[]
  trigger?: unknown
  attachments: Array<{ path: string }>
}): ChatRequestBody {
  const lastUserMessage = [...input.messages].reverse().find((message) => message.role === 'user')
  return {
    threadId: input.threadId,
    // Empty when there is no user message; the daemon answers 400
    // INVALID_CHAT_MESSAGE rather than inventing a turn.
    messages: lastUserMessage ? [lastUserMessage] : [],
    trigger: input.trigger,
    // Paths, never bytes: attachment content was already written to the workspace
    // by the upload, and re-sending it here is how a PDF would blow the cap.
    attachments: input.attachments,
  }
}
