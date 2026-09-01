import { describe, expect, it } from 'vitest'
import { buildStaticAgentTools, requestedFieldSchema } from '../src/mastra/tools.js'
import { runtimeToolAction } from '../src/mastra/authorization.js'

describe('Mastra elicitation fields', () => {
  it('builds a required schema from concrete field-level gaps', () => {
    expect(requestedFieldSchema([
      { name: 'recipientEmail', label: 'Recipient email', description: 'Required to deliver the finished PDF', type: 'string' },
      { name: 'copyCount', label: 'Copy count', description: 'Required by the print service', type: 'integer' },
    ])).toEqual({
      type: 'object',
      properties: {
        recipientEmail: { type: 'string', title: 'Recipient email', description: 'Required to deliver the finished PDF' },
        copyCount: { type: 'integer', title: 'Copy count', description: 'Required by the print service' },
      },
      required: ['recipientEmail', 'copyCount'],
      additionalProperties: false,
    })
  })

  it('maps the PDF tool through the normal governed workspace-write policy', () => {
    expect(runtimeToolAction('papyrus_create_pdf')).toBe('WorkspaceWrite')
  })

  it('does not expose native browser tools when the deployment disables them', () => {
    const disabled = Object.keys(buildStaticAgentTools({ nativeBrowserEnabled: false }))
    expect(disabled).not.toContain('papyrus_browser_navigate')
    expect(disabled).not.toContain('papyrus_browser_read')

    const enabled = Object.keys(buildStaticAgentTools({ nativeBrowserEnabled: true }))
    expect(enabled).toEqual(expect.arrayContaining(['papyrus_browser_navigate', 'papyrus_browser_read']))
  })

})
