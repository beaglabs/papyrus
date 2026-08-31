import { describe, expect, it } from 'vitest'
import { requestedFieldSchema } from '../src/mastra/tools.js'
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

})
