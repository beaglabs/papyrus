import { describe, expect, it } from 'vitest'
import {
  createFallbackUswdsWireframe,
  createRevisionFallbackUswdsWireframe,
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

  it('finds a wireframe embedded in larger revision context', () => {
    const context = `Current canvas\n${JSON.stringify({ unrelated: true })}\nArtifact to revise\n${JSON.stringify(validWireframe)}\nReturn it.`
    expect(parseUswdsWireframeArtifact(context)).toEqual(validWireframe)
  })

  it('preserves an existing artifact while applying a requested button color', () => {
    const request = `Make the buttons red\n\nArtifact to revise in place:\n${JSON.stringify(validWireframe)}`
    const revised = createRevisionFallbackUswdsWireframe(request)
    expect(revised?.title).toBe(validWireframe.title)
    expect(revised?.sections).toEqual(validWireframe.sections)
    expect(revised?.theme?.primaryColor).toBe('#b50909')
  })

  it('creates a schema-valid desktop recovery wireframe', () => {
    const artifact = createFallbackUswdsWireframe('Create a wireframe for a UAS marketplace')
    expect(isUswdsWireframeArtifact(artifact)).toBe(true)
    expect(artifact.viewport).toBe('desktop')
    expect(artifact.sections.some((section) => section.kind === 'card-grid')).toBe(true)
  })

  it('accepts safe theme colors and rejects arbitrary CSS values', () => {
    expect(
      isUswdsWireframeArtifact({ ...validWireframe, theme: { primaryColor: '#b50909' } }),
    ).toBe(true)
    expect(
      isUswdsWireframeArtifact({ ...validWireframe, theme: { primaryColor: 'url(evil)' } }),
    ).toBe(false)
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
