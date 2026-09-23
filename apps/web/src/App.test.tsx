import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgencyAuthStrip, PrimaryNavigation, backgroundSummary, scheduleSummary } from './App.js'
import type { AgentStatus, PortalData } from './api.js'

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
    expect(buttons).toEqual(['✦Agent', '◎Models', '◎Links', '▤Library', '◇Governance', '◈Access'])
    expect(html).not.toMatch(/terrain|investigation|workflows|plugins|scheduled/i)
  })
})

describe('footer identity state', () => {
  it('renders the agency and Entra authentication boundary instead of runtime plumbing', () => {
    const data = {
      config: {
        bootstrap: false,
        organizationName: 'Example Agency',
        profile: 'government',
        cloud: 'USGov',
        entraConfigured: true,
      },
      me: {
        oid: '11111111-1111-1111-1111-111111111111',
        tenantId: '22222222-2222-2222-2222-222222222222',
        displayName: 'Agent Analyst',
        preferredUsername: 'analyst@example.mil',
        roles: ['Papyrus.Integration.View'],
        groups: [],
        source: 'entra',
      },
    } as unknown as PortalData

    const html = renderToStaticMarkup(<AgencyAuthStrip data={data} />)
    expect(html).toContain('AGENCY / ENTRA ORG')
    expect(html).toContain('Example Agency')
    expect(html).toContain('Entra authenticated')
    expect(html).toContain('PAPYRUS APP · USGOV')
    expect(html).toContain('agency-auth-logo')
    expect(html).not.toContain('Mastra storage online')
    expect(html).not.toContain('Model configuration required')
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
