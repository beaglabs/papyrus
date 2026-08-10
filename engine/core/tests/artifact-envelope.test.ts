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

  it('uses the path preceding a fenced source file', () => {
    const artifact = coerceArtifactEnvelope(
      'application',
      'App',
      '/package.json\n```json\n{"scripts":{"start":"vite"}}\n```\n\n/src/App.tsx\n```tsx\nexport default () => <h1>Hello</h1>\n```',
      'engineer',
    )
    expect(artifact.renderer.type).toBe('code')
    expect(artifact.files?.map((file) => file.path)).toEqual(['/package.json', '/src/App.tsx'])
  })

  it('turns a design-system workspace into a code renderer', () => {
    const artifact = coerceArtifactEnvelope(
      'design-system',
      'Digital Service DS',
      '/package.json\n```json\n{"name":"ds","scripts":{"storybook":"storybook dev"}}\n```\n\n/index.html\n```html\n<h1>Gallery</h1>\n```\n\n/src/tokens.css\n```css\n:root { --color-primary: #005ea2; }\n```',
      'designer',
    )
    expect(artifact.renderer.type).toBe('code')
    expect(artifact.files?.map((file) => file.path)).toEqual([
      '/package.json',
      '/index.html',
      '/src/tokens.css',
    ])
  })

  it('preserves unknown output as markdown instead of dropping it', () => {
    const artifact = coerceArtifactEnvelope('specification', 'Plan', 'A useful plan')
    expect(artifact.renderer.type).toBe('markdown')
    expect(artifact.payload).toBe('A useful plan')
  })

  it('does not turn an unlabeled prose fence into a fake text file', () => {
    const artifact = coerceArtifactEnvelope(
      'application',
      'Requirements',
      '```\nA prose requirements example\n```',
    )
    expect(artifact.renderer.type).toBe('markdown')
    expect(artifact.files).toBeUndefined()
    expect(artifact.payload).toContain('A prose requirements example')
  })

  it('keeps code examples inside specifications instead of creating a workspace', () => {
    const content = 'Implementation example:\n```typescript\nconst enabled = true\n```'
    const artifact = coerceArtifactEnvelope('specification', 'Plan', content)
    expect(artifact.renderer.type).toBe('markdown')
    expect(artifact.files).toBeUndefined()
    expect(artifact.payload).toBe(content)
  })
})
