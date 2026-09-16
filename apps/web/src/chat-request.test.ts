import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import { chatRequestBody } from './chat-request.js'

/**
 * The chat body must not grow with the conversation.
 *
 * The daemon reads only the newest user message and takes history from the durable
 * thread, so anything else in the body is uploaded, ignored, and then counted
 * against the request cap on every following turn.
 */

/** The cap is measured in bytes, and the web package has no Node typings. */
function byteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

function userMessage(id: string, text: string): UIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] }
}

function assistantMessage(id: string, text: string): UIMessage {
  return { id, role: 'assistant', parts: [{ type: 'text', text }] }
}

describe('chat request body', () => {
  it('sends only the newest user message, however long the transcript is', () => {
    const messages: UIMessage[] = []
    // A document session: hundreds of turns, each with tool results in between.
    for (let index = 0; index < 200; index += 1) {
      messages.push(userMessage(`u${index}`, `request ${index}`))
      messages.push(assistantMessage(`a${index}`, 'x'.repeat(2_000)))
    }

    const body = chatRequestBody({ threadId: 'thread-1', messages, attachments: [] })
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0]?.id).toBe('u199')
    expect(body.threadId).toBe('thread-1')
  })

  it('stays under the request cap where the full transcript did not', () => {
    const messages: UIMessage[] = []
    for (let index = 0; index < 400; index += 1) {
      messages.push(assistantMessage(`a${index}`, 'y'.repeat(20_000)))
      messages.push(userMessage(`u${index}`, 'summarise the document'))
    }

    // What the transport used to send, and the size that produced BODY_TOO_LARGE
    // on every turn after a long document session.
    const untrimmed = byteLength(JSON.stringify({ threadId: 'thread-1', messages, attachments: [] }))
    expect(untrimmed).toBeGreaterThan(1_048_576)

    const trimmed = byteLength(JSON.stringify(chatRequestBody({ threadId: 'thread-1', messages, attachments: [] })))
    expect(trimmed).toBeLessThan(1_048_576)
    // Not a marginal improvement: the body is now the size of one message.
    expect(trimmed).toBeLessThan(untrimmed / 1000)
  })

  it('sends attachment paths and never attachment content', () => {
    const body = chatRequestBody({
      threadId: 'thread-1',
      messages: [userMessage('u1', 'review the attachment')],
      attachments: [{ path: '/Library/Attachments/report.pdf' }],
    })
    expect(body.attachments).toEqual([{ path: '/Library/Attachments/report.pdf' }])
    expect(JSON.stringify(body)).not.toMatch(/base64|data:/)
  })

  it('preserves the trigger so a scheduled or background turn stays identifiable', () => {
    const body = chatRequestBody({ threadId: 'thread-1', messages: [userMessage('u1', 'go')], trigger: 'schedule', attachments: [] })
    expect(body.trigger).toBe('schedule')
  })

  it('sends no message rather than inventing one when there is no user turn', () => {
    const body = chatRequestBody({ threadId: 'thread-1', messages: [assistantMessage('a1', 'hello')], attachments: [] })
    // The daemon answers 400 INVALID_CHAT_MESSAGE; a fabricated turn would be worse.
    expect(body.messages).toEqual([])
  })
})
