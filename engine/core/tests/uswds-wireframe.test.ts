import { describe, expect, it } from 'vitest'
import {
  createFallbackUswdsWireframe,
  isUswdsWireframeArtifact,
  parseUswdsWireframeArtifact,
} from '../src/artifacts/uswds-wireframe.js'

const validWireframe = {
  schema: 'papyrus.uswds-wireframe/v1',
  title: 'Request dashboard',
  viewport: 'desktop',
  sections: [
    { kind: 'banner', text: 'An official website of the United States government' },
    { kind: 'header', agency: 'U.S. Army', title: 'Marketplace' },
    {
      kind: 'card-grid',
      cards: [{ title: 'Capability', body: 'A verified commercial capability.' }],
    },
  ],
}

describe('USWDS wireframe artifacts', () => {
  it('accepts a valid versioned artifact', () => {
    expect(isUswdsWireframeArtifact(validWireframe)).toBe(true)
    expect(parseUswdsWireframeArtifact(JSON.stringify(validWireframe))).toEqual(validWireframe)
  })

  it('accepts a JSON fenced artifact body', () => {
    expect(
      parseUswdsWireframeArtifact(`\`\`\`json\n${JSON.stringify(validWireframe)}\n\`\`\``),
    ).toEqual(validWireframe)
  })

  it('recovers a valid artifact surrounded by model prose', () => {
    expect(
      parseUswdsWireframeArtifact(
        `Here is the artifact:\n\n\`\`\`json\n${JSON.stringify(validWireframe)}\n\`\`\`\nDone.`,
      ),
    ).toEqual(validWireframe)
  })

  it('recovers a valid artifact from a common wrapper object', () => {
    expect(parseUswdsWireframeArtifact(JSON.stringify({ artifact: validWireframe }))).toEqual(
      validWireframe,
    )
  })

  it('creates a schema-valid desktop recovery wireframe', () => {
    const artifact = createFallbackUswdsWireframe('Create a wireframe for a UAS marketplace')
    expect(isUswdsWireframeArtifact(artifact)).toBe(true)
    expect(artifact.viewport).toBe('desktop')
    expect(artifact.sections.some((section) => section.kind === 'card-grid')).toBe(true)
  })

  it('rejects ASCII and malformed component data', () => {
    expect(parseUswdsWireframeArtifact('| HEADER |\n| CARD |')).toBeUndefined()
    expect(
      isUswdsWireframeArtifact({
        ...validWireframe,
        sections: [{ kind: 'card-grid', cards: [{ title: 'Missing body' }] }],
      }),
    ).toBe(false)
  })
})
