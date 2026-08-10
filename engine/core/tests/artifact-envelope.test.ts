import { describe, expect, it } from 'vitest'
import { coerceArtifactEnvelope, unwrapUswdsArtifact } from '../src/artifacts/envelope.js'

describe('artifact envelope', () => {
  it('adapts a legacy USWDS wireframe', () => {
    const artifact = coerceArtifactEnvelope(
      'ui-mockup',
      'Test',
      JSON.stringify({
        schema: 'papyrus.uswds-wireframe/v1',
        title: 'Workflow',
        viewport: 'desktop',
        description: 'Test workflow',
        sections: [{ kind: 'banner', text: 'Official site' }],
      }),
      'designer',
    )
    expect(artifact.renderer.type).toBe('uswds-wireframe')
    expect(artifact.producer?.persona).toBe('designer')
    expect(unwrapUswdsArtifact(artifact)?.title).toBe('Workflow')
  })

  it('turns fenced source into a code workspace', () => {
    const artifact = coerceArtifactEnvelope(
      'application',
      'App',
      '```tsx file=/App.tsx\nexport default () => <h1>Hello</h1>\n```',
      'engineer',
    )
    expect(artifact.renderer.type).toBe('code')
    expect(artifact.files?.[0]?.path).toBe('/App.tsx')
  })

  it('preserves unknown output as markdown instead of dropping it', () => {
    const artifact = coerceArtifactEnvelope('specification', 'Plan', 'A useful plan')
    expect(artifact.renderer.type).toBe('markdown')
    expect(artifact.payload).toBe('A useful plan')
  })
})
