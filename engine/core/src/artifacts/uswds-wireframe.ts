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
  theme?: { primaryColor?: string; accentColor?: string }
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
    theme: {
      type: 'object',
      properties: {
        primaryColor: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
        accentColor: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
      },
    },
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

const isHexColor = (value: unknown): value is string =>
  typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)

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
    (value.theme === undefined ||
      (isRecord(value.theme) &&
        (value.theme.primaryColor === undefined || isHexColor(value.theme.primaryColor)) &&
        (value.theme.accentColor === undefined || isHexColor(value.theme.accentColor)))) &&
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
  for (const source of extractJsonObjectsContainingSchema(content)) sources.add(source)

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

function extractJsonObjectsContainingSchema(content: string): string[] {
  const results: string[] = []
  for (let start = 0; start < content.length; start++) {
    if (content[start] !== '{') continue
    let depth = 0
    let inString = false
    let escaped = false
    for (let index = start; index < content.length; index++) {
      const character = content[index]
      if (inString) {
        if (escaped) escaped = false
        else if (character === '\\') escaped = true
        else if (character === '"') inString = false
        continue
      }
      if (character === '"') inString = true
      else if (character === '{') depth++
      else if (character === '}') {
        depth--
        if (depth === 0) {
          const candidate = content.slice(start, index + 1)
          if (candidate.includes(USWDS_WIREFRAME_SCHEMA_ID)) results.push(candidate)
          break
        }
      }
    }
  }
  return results
}

export function createRevisionFallbackUswdsWireframe(
  request: string,
): UswdsWireframeArtifact | undefined {
  const existing = parseUswdsWireframeArtifact(request)
  if (!existing) return undefined
  const artifact = structuredClone(existing)
  const namedColors: Record<string, string> = {
    red: '#b50909',
    orange: '#e66f0e',
    yellow: '#ffbe2e',
    green: '#008817',
    blue: '#005ea8',
    purple: '#54278f',
    black: '#1b1b1b',
  }
  const hex = request.match(/#[0-9a-f]{6}\b/i)?.[0]
  const named = Object.entries(namedColors).find(([name]) =>
    new RegExp(`\\b${name}\\b`, 'i').test(request),
  )?.[1]
  const requestedColor = hex ?? named
  if (requestedColor && /\b(buttons?|actions?|primary|colou?r|theme)\b/i.test(request)) {
    artifact.theme = { ...artifact.theme, primaryColor: requestedColor }
  }
  artifact.description = 'Recovered revision of the existing USWDS wireframe artifact.'
  return artifact
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
