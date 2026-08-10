import { describe, expect, it } from 'vitest'
import {
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
