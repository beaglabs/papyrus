export const USWDS_WIREFRAME_SCHEMA_ID = 'papyrus.uswds-wireframe/v1' as const

export type UswdsWireframeSection =
  | { kind: 'banner'; text: string }
  | { kind: 'header'; agency: string; title: string; navigation?: string[] }
  | {
      kind: 'hero'
      eyebrow?: string
      heading: string
      body: string
      primaryAction?: string
      secondaryAction?: string
    }
  | { kind: 'search'; label: string; placeholder?: string; buttonLabel?: string }
  | {
      kind: 'card-grid'
      heading?: string
      cards: Array<{ title: string; body: string; meta?: string; action?: string }>
    }
  | { kind: 'summary-box'; heading: string; body: string; items?: string[] }
  | { kind: 'table'; caption?: string; columns: string[]; rows: string[][] }
  | {
      kind: 'form'
      heading?: string
      fields: Array<{
        label: string
        type: 'text' | 'select' | 'textarea' | 'checkbox'
        options?: string[]
      }>
      submitLabel: string
    }
  | { kind: 'footer'; agency: string; links?: string[] }

export interface UswdsWireframeArtifact {
  schema: typeof USWDS_WIREFRAME_SCHEMA_ID
  title: string
  viewport: 'desktop' | 'tablet' | 'mobile'
  description?: string
  sections: UswdsWireframeSection[]
}

export const USWDS_WIREFRAME_JSON_SCHEMA = {
  $id: USWDS_WIREFRAME_SCHEMA_ID,
  type: 'object',
  required: ['schema', 'title', 'viewport', 'sections'],
  properties: {
    schema: { const: USWDS_WIREFRAME_SCHEMA_ID },
    title: { type: 'string', minLength: 1 },
    viewport: { enum: ['desktop', 'tablet', 'mobile'] },
    description: { type: 'string' },
    sections: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      items: {
        type: 'object',
        required: ['kind'],
        properties: {
          kind: {
            enum: [
              'banner',
              'header',
              'hero',
              'search',
              'card-grid',
              'summary-box',
              'table',
              'form',
              'footer',
            ],
          },
        },
      },
    },
  },
} as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

function validSection(value: unknown): value is UswdsWireframeSection {
  if (!isRecord(value) || typeof value.kind !== 'string') return false
  switch (value.kind) {
    case 'banner':
      return typeof value.text === 'string'
    case 'header':
      return (
        typeof value.agency === 'string' &&
        typeof value.title === 'string' &&
        (value.navigation === undefined || isStringArray(value.navigation))
      )
    case 'hero':
      return (
        typeof value.heading === 'string' &&
        typeof value.body === 'string' &&
        (value.eyebrow === undefined || typeof value.eyebrow === 'string') &&
        (value.primaryAction === undefined || typeof value.primaryAction === 'string') &&
        (value.secondaryAction === undefined || typeof value.secondaryAction === 'string')
      )
    case 'search':
      return (
        typeof value.label === 'string' &&
        (value.placeholder === undefined || typeof value.placeholder === 'string') &&
        (value.buttonLabel === undefined || typeof value.buttonLabel === 'string')
      )
    case 'card-grid':
      return (
        Array.isArray(value.cards) &&
        value.cards.length <= 12 &&
        value.cards.every(
          (card) =>
            isRecord(card) && typeof card.title === 'string' && typeof card.body === 'string',
        )
      )
    case 'summary-box':
      return (
        typeof value.heading === 'string' &&
        typeof value.body === 'string' &&
        (value.items === undefined || isStringArray(value.items))
      )
    case 'table': {
      const columns = value.columns
      return (
        isStringArray(columns) &&
        Array.isArray(value.rows) &&
        value.rows.every((row) => isStringArray(row) && row.length === columns.length)
      )
    }
    case 'form':
      return (
        typeof value.submitLabel === 'string' &&
        Array.isArray(value.fields) &&
        value.fields.every(
          (field) =>
            isRecord(field) &&
            typeof field.label === 'string' &&
            ['text', 'select', 'textarea', 'checkbox'].includes(String(field.type)),
        )
      )
    case 'footer':
      return (
        typeof value.agency === 'string' &&
        (value.links === undefined || isStringArray(value.links))
      )
    default:
      return false
  }
}

export function isUswdsWireframeArtifact(value: unknown): value is UswdsWireframeArtifact {
  return (
    isRecord(value) &&
    value.schema === USWDS_WIREFRAME_SCHEMA_ID &&
    typeof value.title === 'string' &&
    value.title.trim().length > 0 &&
    ['desktop', 'tablet', 'mobile'].includes(String(value.viewport)) &&
    Array.isArray(value.sections) &&
    value.sections.length > 0 &&
    value.sections.length <= 20 &&
    value.sections.every(validSection)
  )
}

export function parseUswdsWireframeArtifact(content: string): UswdsWireframeArtifact | undefined {
  const sources = new Set<string>([content.trim()])
  for (const match of content.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    if (match[1]) sources.add(match[1].trim())
  }
  const firstBrace = content.indexOf('{')
  const lastBrace = content.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    sources.add(content.slice(firstBrace, lastBrace + 1))
  }

  for (const source of sources) {
    try {
      const value: unknown = JSON.parse(source)
      const candidates = [
        value,
        isRecord(value) ? value.artifact : undefined,
        isRecord(value) ? value.wireframe : undefined,
        isRecord(value) ? value.data : undefined,
      ]
      const artifact = candidates.find(isUswdsWireframeArtifact)
      if (artifact) return artifact
    } catch {
      // Try the next plausible JSON body. The final value remains strictly validated.
    }
  }
  return undefined
}

export function createFallbackUswdsWireframe(request: string): UswdsWireframeArtifact {
  const isUasMarketplace = /\b(uas|drone|uncrewed|marketplace)\b/i.test(request)
  const agency = isUasMarketplace ? 'U.S. Army' : 'Federal Agency'
  const service = isUasMarketplace ? 'UAS Marketplace' : 'Mission Service'
  const subject = isUasMarketplace
    ? 'Find and evaluate commercial uncrewed systems'
    : 'Complete the primary mission workflow'

  return {
    schema: USWDS_WIREFRAME_SCHEMA_ID,
    title: `${service} — Primary Workflow`,
    viewport: 'desktop',
    description: 'Schema-valid USWDS recovery wireframe generated from the project request.',
    sections: [
      { kind: 'banner', text: 'An official website of the United States government' },
      {
        kind: 'header',
        agency,
        title: service,
        navigation: ['Overview', 'Requests', 'Resources', 'Help'],
      },
      {
        kind: 'hero',
        eyebrow: 'Primary workflow',
        heading: subject,
        body: 'Move from discovery through review and submission with clear status, ownership, and next actions.',
        primaryAction: 'Start a request',
        secondaryAction: 'View saved work',
      },
      { kind: 'search', label: 'Search available capabilities', buttonLabel: 'Search' },
      {
        kind: 'card-grid',
        heading: 'How it works',
        cards: [
          {
            title: '1. Define the need',
            body: 'Describe the mission, constraints, and desired outcome.',
          },
          {
            title: '2. Review options',
            body: 'Compare relevant capabilities and supporting evidence.',
          },
          {
            title: '3. Submit and track',
            body: 'Route the request and monitor its status through completion.',
          },
        ],
      },
      {
        kind: 'summary-box',
        heading: 'Before you begin',
        body: 'Have the mission need, point of contact, timeline, and required documentation ready.',
      },
      { kind: 'footer', agency, links: ['Accessibility', 'Privacy', 'Contact'] },
    ],
  }
}
