import { describe, expect, it } from 'vitest'
import { extractArtifacts } from '../src/persona.js'

describe('designer artifact extraction', () => {
  it('accepts a standalone versioned wireframe without an artifact tag', () => {
    const wireframe = {
      schema: 'papyrus.uswds-wireframe/v1',
      title: 'Revised workflow',
      viewport: 'desktop',
      theme: { primaryColor: '#b50909' },
      sections: [{ kind: 'banner', text: 'Official government website' }],
    }
    const result = extractArtifacts(`Here is the revision:\n${JSON.stringify(wireframe)}`)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0]?.type).toBe('ui-mockup')
    expect(result.nodes[0]?.artifact).toEqual(wireframe)
  })
})
