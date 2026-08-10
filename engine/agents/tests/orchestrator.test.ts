import { describe, expect, it } from 'vitest'
import { routeAgentRequest } from '../src/orchestrator.js'

describe('artifact routing', () => {
  it.each([
    ['Create a comprehensive PRD', 'pm', 'specification'],
    ['Draft user stories with acceptance criteria', 'pm', 'user-story'],
    ['Define success metrics and KPIs', 'pm', 'success-metric'],
    ['Define a design system with colors and typography', 'designer', 'specification'],
    ['Create a desktop wireframe', 'designer', 'ui-mockup'],
    ['Design a REST API with all endpoints', 'engineer', 'api'],
    ['Generate React source code', 'engineer', 'application'],
    ['Describe the system architecture', 'engineer', 'specification'],
  ])('routes %s to %s/%s', (request, persona, artifact) => {
    const route = routeAgentRequest(request)
    expect(route.primaryPersona).toBe(persona)
    expect(route.expectedArtifact).toBe(artifact)
  })

  it('lets explicit request intent override the previously active persona', () => {
    const route = routeAgentRequest('Draft user stories with acceptance criteria', 'designer')
    expect(route.primaryPersona).toBe('pm')
    expect(route.expectedArtifact).toBe('user-story')
  })

  it('uses the previous persona for an ambiguous follow-up', () => {
    const route = routeAgentRequest('Make the primary buttons red', 'designer')
    expect(route.primaryPersona).toBe('designer')
  })

  it('preserves the requested artifact contract with an explicit persona mention', () => {
    const route = routeAgentRequest('@designer create a PRD')
    expect(route.primaryPersona).toBe('designer')
    expect(route.expectedArtifact).toBe('specification')
  })
})
