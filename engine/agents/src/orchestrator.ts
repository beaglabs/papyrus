export type PersonaId = 'pm' | 'designer' | 'engineer' | 'security'

export interface OrchestrationRoute {
  primaryPersona: PersonaId
  invitedPersonas: PersonaId[]
  expectedArtifact?: string
  announcement: string
}

const RULES: Array<{ persona: PersonaId; pattern: RegExp; artifact: string }> = [
  {
    persona: 'security',
    pattern:
      /\b(threat|security|secure|stride|nist|fedramp|compliance|vulnerab|auth(?:entication|orization)?|risk)\b/i,
    artifact: 'security-report',
  },
  {
    persona: 'designer',
    pattern: /\b(wireframe|mockup|design system|user journey|ux|ui|screen|layout|figma)\b/i,
    artifact: 'ui-mockup',
  },
  {
    persona: 'engineer',
    pattern:
      /\b(api|openapi|code|source|architecture|database|schema|endpoint|application|sandbox|mcp|server|typescript|react)\b/i,
    artifact: 'application',
  },
  {
    persona: 'pm',
    pattern: /\b(prd|requirement|user stor|roadmap|success metric|kpi|product brief|priorit)\b/i,
    artifact: 'specification',
  },
]

const ALIASES: Record<string, PersonaId> = {
  pm: 'pm',
  product: 'pm',
  designer: 'designer',
  design: 'designer',
  engineer: 'engineer',
  eng: 'engineer',
  security: 'security',
  sec: 'security',
}

export function routeAgentRequest(text: string, requestedPersona?: string): OrchestrationRoute {
  const explicit =
    text
      .match(/@([\w-]+)/g)
      ?.map((value) => ALIASES[value.slice(1).toLowerCase()])
      .filter((persona): persona is PersonaId => !!persona) ?? []
  const requested = requestedPersona ? ALIASES[requestedPersona.toLowerCase()] : undefined
  const matched = RULES.filter((rule) => rule.pattern.test(text))
  const primaryPersona = explicit[0] ?? requested ?? matched[0]?.persona ?? 'pm'
  const invitedPersonas = [
    ...new Set([primaryPersona, ...explicit, ...matched.map((rule) => rule.persona)]),
  ]
  const expectedArtifact = matched.find((rule) => rule.persona === primaryPersona)?.artifact
  const labels = invitedPersonas.map((persona) => `@${persona}`).join(' and ')
  return {
    primaryPersona,
    invitedPersonas,
    expectedArtifact,
    announcement: `Inviting ${labels} to help.`,
  }
}

export const PERSONA_CAPABILITIES: Record<PersonaId, string[]> = {
  pm: ['requirements', 'prioritization', 'documents', 'sandbox.render'],
  designer: ['uswds-wireframe', 'design-system', 'accessibility', 'sandbox.render'],
  engineer: ['source-code', 'openapi', 'architecture', 'mcp', 'sandbox.render'],
  security: ['threat-model', 'control-mapping', 'code-review', 'sandbox.render'],
}
