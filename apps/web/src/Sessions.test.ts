import { describe, expect, it } from 'vitest'
import type { Artifact, SessionEvent } from '@papyrus/contracts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ArtifactWorkspace, DurablePromptTurn, PromptTurnFlow, hasAcceptedTurn, isArtifactGenerationActive, latestBrowserState, latestRunRunning, projectActivity } from './Sessions.js'

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
    expect(latestBrowserState([
      event(1, { sessionUpdate: 'browser_state', status: 'completed' }),
      event(2, { sessionUpdate: 'browser_state', status: 'failed' }),
    ])).toBe('failed')
  })

  it('uses only the latest run when recovering active state from history', () => {
    const history = [
      event(1, { sessionUpdate: 'run_started' }),
      event(2, { sessionUpdate: 'run_completed', status: 'completed' }),
      { ...event(3, { sessionUpdate: 'run_started' }), runId: 'next-run' },
    ]
    expect(latestRunRunning(history)).toBe(true)
    expect(latestRunRunning([...history, { ...event(4, { sessionUpdate: 'run_completed', status: 'failed' }), runId: 'next-run' }])).toBe(false)
    expect(latestRunRunning([])).toBeUndefined()
  })

  it('keeps repeated stdout chunks and stderr while preserving exit status', () => {
    const events = [
      event(1, { sessionUpdate: 'tool_call', toolCallId: 'cmd', title: 'Execute command', status: 'in_progress' }),
      ...[2, 3].map((sequence) => event(sequence, { sessionUpdate: 'tool_call_update', toolCallId: 'cmd', _meta: { papyrus: { outputDelta: { stream: 'stdout', text: 'tick\n' } } } })),
      event(4, { sessionUpdate: 'tool_call_update', toolCallId: 'cmd', _meta: { papyrus: { outputDelta: { stream: 'stderr', text: 'error\n' }, exitCode: 1 } }, status: 'failed' }),
    ]
    expect(projectActivity(events).tools[0]).toMatchObject({ stdout: 'tick\ntick\n', stderr: 'error\n', status: 'failed', exitCode: 1 })
  })

  it('shows active tools even when other tool calls have completed', () => {
    const events = [
      event(1, { sessionUpdate: 'tool_call', toolCallId: 'read', title: 'Read file', status: 'completed' }),
      event(2, { sessionUpdate: 'tool_call', toolCallId: 'render', title: 'Render PDF', status: 'in_progress' }),
    ]
    const html = renderToStaticMarkup(createElement(PromptTurnFlow, { events, running: true, submitted: false }))
    expect(html).toContain('Running Render PDF')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('session-activity')
    expect(html).toContain('Render PDF')
    expect(html).not.toContain('Turn complete')
  })

  it('renders browser results as a page preview instead of leading with raw JSON', () => {
    const events = [
      event(1, { sessionUpdate: 'tool_call', toolCallId: 'browser', title: 'Browser navigate', kind: 'other', status: 'in_progress' }),
      event(2, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'browser',
        title: 'Browser navigate',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: JSON.stringify({
          url: 'https://example.com/dining',
          title: 'Dinner guide',
          text: 'A concise guide to neighborhood dinner options and reservations.',
        }) } }],
      }),
    ]
    const html = renderToStaticMarkup(createElement(PromptTurnFlow, { events, running: false, submitted: false }))
    expect(html).toContain('session-browser-preview')
    expect(html).toContain('Dinner guide')
    expect(html).toContain('example.com')
    expect(html).toContain('A concise guide to neighborhood dinner options')
    expect(html).toContain('Raw response')
  })

  it('renders request-input as a waiting state without duplicating it as tool chrome', () => {
    const html = renderToStaticMarkup(createElement(PromptTurnFlow, { events: [
      event(1, { sessionUpdate: 'tool_call', toolCallId: 'input', title: 'papyrus_request_input', status: 'in_progress' }),
    ], running: true, submitted: false }))
    expect(html).toContain('Waiting for input')
    expect(html).not.toContain('Request input')
    expect(html).not.toContain('session-activity')
  })

  it('distinguishes argument preparation from running and model continuation', () => {
    const preparing = renderToStaticMarkup(createElement(PromptTurnFlow, { events: [event(1, { sessionUpdate: 'tool_call', toolCallId: 't', title: 'Render PDF', status: 'pending' })], running: true, submitted: false }))
    expect(preparing).toContain('Preparing Render PDF')
    const continuing = renderToStaticMarkup(createElement(PromptTurnFlow, { events: [event(1, { sessionUpdate: 'tool_call', toolCallId: 't', status: 'completed' })], running: true, submitted: false }))
    expect(continuing).toContain('Working…')
    expect(continuing).not.toContain('Turn complete')
  })

  it('surfaces a failed tool while the model is recovering instead of a generic working status', () => {
    const html = renderToStaticMarkup(createElement(PromptTurnFlow, { events: [
      event(1, { sessionUpdate: 'agent_thought_chunk', messageId: 'thought', content: { type: 'text', text: 'Working…' } }),
      event(2, { sessionUpdate: 'tool_call', toolCallId: 'cmd', title: 'Execute command', status: 'in_progress' }),
      event(3, { sessionUpdate: 'tool_call_update', toolCallId: 'cmd', title: 'Execute command', status: 'failed', _meta: { papyrus: { exitCode: 128 } } }),
    ], running: true, submitted: false }))
    expect(html).toContain('Recovering after Execute command failed')
    expect(html).toContain('Exited with code 128 without diagnostic output.')
  })

  it('keeps artifact generation visible after Create PDF finishes while the turn finalizes', () => {
    const events = [
      event(1, { sessionUpdate: 'tool_call', toolCallId: 'pdf', title: 'Create PDF', kind: 'edit', status: 'in_progress' }),
      event(2, { sessionUpdate: 'tool_call_update', toolCallId: 'pdf', title: 'Create PDF', kind: 'edit', status: 'completed' }),
    ]
    expect(isArtifactGenerationActive(events)).toBe(true)
    const html = renderToStaticMarkup(createElement(PromptTurnFlow, { events, running: true, submitted: false }))
    expect(html).toContain('Create PDF complete · finalizing output')
  })

  it('does not label a failed run as complete', () => {
    const html = renderToStaticMarkup(createElement(PromptTurnFlow, { events: [
      event(1, { sessionUpdate: 'tool_call', toolCallId: 't', status: 'completed' }),
      event(2, { sessionUpdate: 'run_completed', status: 'failed' }),
    ], running: false, submitted: false }))
    expect(html).toContain('Turn failed')
    expect(html).not.toContain('Turn complete')
  })

  it('renders assistant text, tool activity, and final text in event order', () => {
    const turn = {
      runId: 'run',
      sequence: 1,
      events: [
        event(1, { sessionUpdate: 'user_message_chunk', messageId: 'user', content: { type: 'text', text: 'Generate a PDF' } }),
        event(2, { sessionUpdate: 'agent_message_chunk', messageId: 'agent-0', content: { type: 'text', text: 'I’ll generate it now.' } }),
        event(3, { sessionUpdate: 'tool_call', toolCallId: 'pdf', title: 'Create PDF', kind: 'edit', status: 'in_progress' }),
        event(4, { sessionUpdate: 'tool_call_update', toolCallId: 'pdf', title: 'Create PDF', kind: 'edit', status: 'completed' }),
        event(5, { sessionUpdate: 'agent_message_chunk', messageId: 'agent-1', content: { type: 'text', text: 'Your PDF is ready.' } }),
        event(6, { sessionUpdate: 'run_completed', status: 'completed' }),
      ],
    }
    const html = renderToStaticMarkup(createElement(DurablePromptTurn, { turn, running: false }))
    const preamble = html.indexOf('I’ll generate it now.')
    const tool = html.indexOf('Create PDF')
    const final = html.indexOf('Your PDF is ready.')
    expect(preamble).toBeGreaterThan(-1)
    expect(tool).toBeGreaterThan(preamble)
    expect(final).toBeGreaterThan(tool)
    expect(html).not.toContain('Turn complete')
  })

  it('shows only the selected artifact without a file browser', () => {
    const artifacts = [
      { id: 'pdf', name: 'sample.pdf', mediaType: 'application/pdf', downloadUrl: '/api/artifacts/pdf/content', version: 1 },
      { id: 'png', name: 'sample_preview.png', mediaType: 'image/png', downloadUrl: '/api/artifacts/png/content', version: 1 },
    ] as Artifact[]
    const html = renderToStaticMarkup(createElement(ArtifactWorkspace, { artifacts, generating: true, open: true, selectedId: 'pdf', onOpenChange: () => undefined }))
    expect(html).toContain('sample.pdf')
    expect(html).toContain('type="application/pdf"')
    expect(html).not.toContain('<nav')
    expect(html).not.toContain('sample_preview.png')
    expect(html).not.toContain('Building an artifact')
    expect(html).toContain('Download')
  })
})
