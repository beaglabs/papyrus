import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ScheduledView } from './Automation.js'
import type { AgentSession } from './api.js'

const session: AgentSession = {
  id: 'thread-1',
  title: 'Operations',
  createdAt: '2026-09-04T12:00:00.000Z',
  updatedAt: '2026-09-04T12:00:00.000Z',
  attention: false,
  kind: 'operator_session',
}

describe('schedule creation', () => {
  it('requires an existing session/thread', () => {
    const html = renderToStaticMarkup(<ScheduledView schedules={[]} sessions={[session]} onChanged={async () => undefined} />)
    expect(html).toMatch(/<select[^>]*name="threadId"[^>]*required/)
    expect(html).toContain('Choose a session')
    expect(html).not.toContain('Create an unbound run')
  })

  it('does not offer schedule creation until a session exists', () => {
    const html = renderToStaticMarkup(<ScheduledView schedules={[]} sessions={[]} onChanged={async () => undefined} />)
    expect(html).toContain('Create a session first')
    expect(html).toMatch(/<button[^>]*disabled/)
  })
})
