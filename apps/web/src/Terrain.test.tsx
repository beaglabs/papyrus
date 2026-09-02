import { describe, expect, it } from 'vitest'
import type { IntegrationCatalogEntry, IntegrationConfiguration } from '@papyrus/contracts'
import type { PortalData } from './api.js'
import { buildTopology, CLASS_META, DISABLED_FILL } from './terrain-topology.js'

function integration(overrides: Partial<IntegrationConfiguration>): IntegrationConfiguration {
  return {
    id: 'int-1', catalogId: 'zeek', name: 'Zeek East', integrationClass: 'evidence_source', authority: 'read_only', risk: 'low',
    state: 'draft', scope: 'east enclave', settings: {}, health: 'unknown', createdByOid: 'owner-oid', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', version: 1,
    ...overrides,
  }
}

function catalogEntry(overrides: Partial<IntegrationCatalogEntry> & Pick<IntegrationCatalogEntry, 'id'>): IntegrationCatalogEntry {
  return {
    name: 'Connector', vendor: 'Test', description: '', integrationClass: 'evidence_source', authority: 'read_only', risk: 'low',
    capabilities: [], evidenceTypes: [], authSchemes: ['none'], supportedProfiles: ['gcc'], licenseFeature: 'core', accent: '#123456', initials: 'CN',
    ...overrides,
  }
}

function portalData(integrations: IntegrationConfiguration[], catalog: IntegrationCatalogEntry[] = []): PortalData {
  return {
    config: { organizationName: 'Example Agency', profile: 'gcc', cloud: 'Public', entraConfigured: true, developmentIdentity: false, loginUrl: '/api/auth/entra/login?returnTo=/portal' },
    me: { oid: 'owner-oid', tenantId: 'tenant', displayName: 'Owner', roles: ['Papyrus.System.Owner'], groups: [], source: 'development' },
    overview: {
      deployment: { profile: 'gcc', topology: 'customer-hosted', identityAuthority: 'Microsoft Entra ID', runtime: 'Starlings', license: { valid: true, deploymentId: 'deployment-1' } },
      posture: { integrations: integrations.length, healthy: 0, degraded: 0, awaitingApproval: 0, evidenceSources: 0, actionExecutors: 0 },
    },
    catalog,
    integrations,
  }
}

describe('cyber terrain topology', () => {
  it('anchors the topology on the twin and deployment authorities before any connector exists', () => {
    const topology = buildTopology(portalData([]))
    expect(topology.nodes.map((node) => node.id)).toEqual(['twin', 'authority:identity', 'authority:runtime', 'authority:license'])
    expect(topology.edges.map((edge) => edge.target)).toEqual(['twin', 'twin', 'twin'])
  })

  it('flags the entitlement node when the offline license is not active', () => {
    const data = portalData([])
    data.overview.deployment.license = { valid: false, deploymentId: 'deployment-1', reason: 'missing' }
    const license = buildTopology(data).nodes.find((node) => node.id === 'authority:license')
    expect(license?.label).toBe('ACTIVATION REQUIRED')
    expect(license?.fill).toBe('#ffd36e')
  })

  it('groups connectors under a class anchor between the connector and the twin', () => {
    const topology = buildTopology(portalData([
      integration({ id: 'zeek-1', state: 'active' }),
      integration({ id: 'zeek-2', catalogId: 'suricata', name: 'Suricata West', state: 'draft' }),
    ]))
    const anchor = topology.nodes.find((node) => node.id === 'class:evidence_source')
    expect(anchor?.label).toBe(CLASS_META.evidence_source.label.toUpperCase())
    expect(topology.edges).toContainEqual(expect.objectContaining({ source: 'class:evidence_source', target: 'twin' }))
    expect(topology.edges).toContainEqual(expect.objectContaining({ source: 'zeek-1', target: 'class:evidence_source' }))
    expect(topology.edges).toContainEqual(expect.objectContaining({ source: 'zeek-2', target: 'class:evidence_source' }))
  })

  it('only creates class anchors for classes that have configured connectors', () => {
    const topology = buildTopology(portalData([integration({ id: 'teams-1', integrationClass: 'human_interface', catalogId: 'microsoft-teams' })]))
    const anchors = topology.nodes.filter((node) => node.id.startsWith('class:')).map((node) => node.id)
    expect(anchors).toEqual(['class:human_interface'])
  })

  it('distinguishes live evidence links from inactive ones', () => {
    const topology = buildTopology(portalData([
      integration({ id: 'active-1', state: 'active' }),
      integration({ id: 'draft-1', state: 'draft' }),
      integration({ id: 'disabled-1', state: 'disabled' }),
    ]))
    const edge = (id: string) => topology.edges.find((entry) => entry.id === `edge:${id}`)
    expect(edge('active-1')).toMatchObject({ dashed: false })
    expect(edge('draft-1')).toMatchObject({ dashed: true, fill: DISABLED_FILL })
    expect(topology.nodes.find((node) => node.id === 'disabled-1')?.fill).toBe(DISABLED_FILL)
    expect(topology.nodes.find((node) => node.id === 'active-1')?.fill).toBe(CLASS_META.evidence_source.accent)
  })

  it('prefers the catalog accent over the class accent when the manifest is present', () => {
    const topology = buildTopology(
      portalData([integration({ id: 'zeek-1', state: 'active' })], [catalogEntry({ id: 'zeek', accent: '#ffd36e' })]),
    )
    expect(topology.nodes.find((node) => node.id === 'zeek-1')?.fill).toBe('#ffd36e')
  })

  it('emits unique node and edge identifiers', () => {
    const topology = buildTopology(portalData([
      integration({ id: 'a' }), integration({ id: 'b', integrationClass: 'action_executor', catalogId: 'firewall-executor', authority: 'controlled_actions', risk: 'critical' }),
    ]))
    const nodeIds = topology.nodes.map((node) => node.id)
    const edgeIds = topology.edges.map((edge) => edge.id)
    expect(new Set(nodeIds).size).toBe(nodeIds.length)
    expect(new Set(edgeIds).size).toBe(edgeIds.length)
  })
})
