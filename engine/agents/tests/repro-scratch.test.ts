import { describe, expect, it } from 'vitest'
import { createPersonaAgent } from '../src/persona.js'
import { resolveModelProvider } from '../src/model-provider.js'

describe('repro: design-system request with wireframe canvas context', () => {
  it('does not force a USWDS repair when the request is a design system', async () => {
    const provider = { provider: 'demo', baseURL: '', apiKey: '', model: 'demo-model' } as const
    const agent = createPersonaAgent('designer', provider, { expectedArtifact: 'design-system' })
    const requestWithCanvasContext =
      'Define a design system with colors, typography, and spacing.\n\n' +
      '--- Current Shared Canvas ---\n' +
      'ui-mockup "Wireframe" (approved), ui-mockup "Mockup of checkout" (proposed)'
    const result = await agent.chat([
      { role: 'user', content: requestWithCanvasContext },
    ])
    expect(result.nodes.length).toBeGreaterThan(0)
  }, 15000)
})