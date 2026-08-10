/**
 * Single-agent orchestrator — no multi-persona routing.
 * All requests go to the same general-purpose code generation agent.
 */

export interface OrchestrationRoute {
  expectedArtifact?: string
}

export function routeAgentRequest(text: string): OrchestrationRoute {
  const lower = text.toLowerCase()
  const expectedArtifact = /\b(api|openapi|endpoint)\b/i.test(lower)
    ? 'api'
    : /\b(code|build|create|generate|app|application|component|page|scaffold|fix|modify|update|extend|add)\b/i.test(lower)
      ? 'application'
      : undefined

  return { expectedArtifact }
}
