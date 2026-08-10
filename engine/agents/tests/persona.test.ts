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
    expect(result.nodes[0]?.artifact).toMatchObject({
      schema: 'papyrus.artifact/v1',
      kind: 'ui-mockup',
      renderer: { type: 'uswds-wireframe' },
      payload: wireframe,
    })
  })

  it('keeps unlabeled fenced prose as the expected specification', () => {
    const result = extractArtifacts(
      '## Product requirements\n```\nThe service must support review and approval.\n```',
      'pm',
      'specification',
    )
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0]?.type).toBe('specification')
    expect(result.nodes[0]?.artifact).toMatchObject({
      kind: 'specification',
      renderer: { type: 'markdown' },
    })
    expect(result.nodes[0]?.artifact?.files).toBeUndefined()
  })

  it('corrects an incompatible application tag to the routed artifact type', () => {
    const result = extractArtifacts(
      '<artifact type="application" title="Metrics">Availability above 99.9%</artifact>',
      'pm',
      'success-metric',
    )
    expect(result.nodes[0]?.type).toBe('success-metric')
    expect(result.nodes[0]?.artifact).toMatchObject({
      kind: 'success-metric',
      renderer: { type: 'markdown' },
    })
  })

  it('extracts a design-system workspace into a runnable code artifact', () => {
    const result = extractArtifacts(
      '<artifact type="design-system" title="Portal DS">/package.json\n```json\n{"name":"portal-ds"}\n```\n\n/index.html\n```html\n<h1>Gallery</h1>\n```\n\n/src/tokens.css\n```css\n:root { --color-primary: #005ea2; }\n```</artifact>',
      'designer',
      'design-system',
    )
    expect(result.nodes[0]?.type).toBe('design-system')
    expect(result.nodes[0]?.artifact).toMatchObject({
      kind: 'design-system',
      renderer: { type: 'code' },
    })
    expect(result.nodes[0]?.artifact?.files?.some((file) => file.path === '/index.html')).toBe(true)
  })
})
