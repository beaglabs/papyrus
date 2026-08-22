import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@papyrus/contracts'
import { projectResearchSources } from '../src/sources.js'

describe('browser research source projection', () => {
  it('captures sanitized HTTP evidence with immutable event provenance', () => {
    const events: SessionEvent[] = [{
      sequence: 12, sessionId: 'session-1', runId: 'run-1', kind: 'update', occurredAt: '2026-08-20T12:00:00.000Z',
      data: {
        sessionUpdate: 'tool_call_update', title: 'Read acquisition guidance',
        content: [{ type: 'content', content: { type: 'text', text: 'Official guidance from https://user:secret@example.mil/policy?q=sensitive#section' } }],
        locations: [{ path: 'https://example.mil/policy?q=other' }, { path: 'file:///tmp/not-a-source' }],
      },
    }]
    expect(projectResearchSources('session-1', events)).toEqual([{
      id: '12-0', sessionId: 'session-1', runId: 'run-1', title: 'Read acquisition guidance',
      url: 'https://example.mil/policy', host: 'example.mil',
      excerpt: 'Official guidance from https://example.mil/policy',
      sequence: 12, capturedAt: '2026-08-20T12:00:00.000Z',
    }])
  })

  it('unwraps serialized ACP text resources for typed previews', () => {
    const resource = {
      type: 'resource',
      resource: {
        uri: 'file:///workspace/README.md',
        mimeType: 'text/markdown',
        text: '# Papyrus\n\nGoverned source from https://example.mil/guidance',
      },
    }
    const events: SessionEvent[] = [{
      sequence: 67, sessionId: 'session-1', runId: 'run-1', kind: 'update', occurredAt: '2026-08-21T19:30:32.000Z',
      data: {
        sessionUpdate: 'tool_call_update', title: 'papyrus_read_file',
        content: [{ type: 'content', content: { type: 'text', text: JSON.stringify(resource) } }],
      },
    }]

    expect(projectResearchSources('session-1', events)).toEqual([expect.objectContaining({
      url: 'https://example.mil/guidance',
      excerpt: '# Papyrus Governed source from https://example.mil/guidance',
      preview: '# Papyrus\n\nGoverned source from https://example.mil/guidance',
      previewMediaType: 'text/markdown',
    })])
  })

})
