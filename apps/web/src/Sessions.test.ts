import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@papyrus/contracts'
import { hasAcceptedTurn, latestBrowserState } from './Sessions.js'

function event(sequence: number, data: Record<string, unknown>): SessionEvent {
  return { id: String(sequence), sessionId: 'session', runId: 'run', sequence, kind: 'update', occurredAt: new Date(0).toISOString(), data } as SessionEvent
}

describe('Mastra session projection', () => {
  it('recognizes an accepted durable turn from initial history', () => {
    expect(hasAcceptedTurn([event(1, { sessionUpdate: 'run_started' })])).toBe(true)
    expect(hasAcceptedTurn([event(1, { sessionUpdate: 'user_message_chunk' })])).toBe(true)
    expect(hasAcceptedTurn([])).toBe(false)
  })

  it('uses the latest durable browser state', () => {
    expect(latestBrowserState([
      event(1, { sessionUpdate: 'browser_state', status: 'active' }),
      event(2, { sessionUpdate: 'browser_state', status: 'completed' }),
    ])).toBe('completed')
  })
})
