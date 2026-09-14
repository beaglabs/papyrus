import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PrimaryNavigation, RuntimeStatusStrip, backgroundSummary, scheduleSummary } from './App.js'
import type { AgentStatus } from './api.js'

const status: AgentStatus = {
  ready: true, agentReady: true, durable: true, model: 'llama-3.3-70b', runtime: 'mastra',
  signalBacklog: { pending: 0, delivering: 0, delivered: 0, failed: 0 },
}

function jobs(overrides: Partial<NonNullable<AgentStatus['jobs']>> = {}): NonNullable<AgentStatus['jobs']> {
  return {
    sessionId: 'session-1',
    schedules: { active: 0, paused: 0, nextFireAt: null },
    background: { running: 0, queued: 0, failed: 0, observed: true },
    ...overrides,
  }
}

describe('primary navigation', () => {
  it('exposes the Mastra-native runtime surfaces', () => {
    const html = renderToStaticMarkup(<PrimaryNavigation view="agent" onNavigate={() => undefined} />)
    const buttons = [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((match) => match[1]!.replace(/<[^>]*>/g, '').trim())
    expect(buttons).toEqual(['✦Agent', '◎Models', '◎Links', '▤Library', '◇Governance'])
    expect(html).not.toMatch(/terrain|investigation|workflows|plugins|scheduled/i)
  })
})

describe('footer runtime status', () => {
  it('renders the runtime line and no jobs block until a session is scoped', () => {
    const html = renderToStaticMarkup(<RuntimeStatusStrip status={status} />)
    expect(html).toContain('RUNTIME')
    expect(html).toContain('Mastra online')
    expect(html).toContain('llama-3.3-70b')
    expect(html).not.toContain('runtime-jobs')
  })

  it('reports a session with no recurring work and no running jobs plainly', () => {
    expect(scheduleSummary(jobs())).toBe('0 active schedules')
    expect(backgroundSummary(jobs())).toBe('no jobs running')
  })

  it('counts active and paused schedules with the next fire time', () => {
    const summary = scheduleSummary(jobs({ schedules: { active: 1, paused: 2, nextFireAt: Date.UTC(2026, 8, 14, 14, 32) } }))
    expect(summary).toContain('1 active schedule')
    expect(summary).toContain('2 paused')
    expect(summary).toContain('next ')
    expect(summary).not.toContain('1 active schedules')
  })

  it('counts running and queued jobs', () => {
    expect(backgroundSummary(jobs({ background: { running: 2, queued: 1, failed: 0, observed: true } }))).toBe('2 running · 1 queued')
    expect(backgroundSummary(jobs({ background: { running: 0, queued: 3, failed: 0, observed: true } }))).toBe('3 queued')
  })

  it('says the queue is unobservable instead of reporting zero jobs', () => {
    expect(backgroundSummary(jobs({ background: { running: 0, queued: 0, failed: 0, observed: false } }))).toBe('job queue unavailable')
  })
})
