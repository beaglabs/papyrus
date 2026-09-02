import { describe, expect, it } from 'vitest'
import type { TerrainEntity, TerrainRelationship, TerrainSnapshot } from '@papyrus/contracts'
import { buildTopology, presentationFor } from './terrain-topology.js'

function entity(id: string, externalId: string, kind: string, label: string): TerrainEntity {
  return {
    id, externalId, kind, label, attributes: {}, confidence: 0.9, firstSeen: '2026-01-01T00:00:00.000Z',
    lastSeen: '2026-01-01T00:00:00.000Z', sourceIntegrationIds: ['integration-1'], evidenceIds: ['evidence-1'],
  }
}

function relationship(id: string, sourceId: string, targetId: string): TerrainRelationship {
  return {
    id, externalId: id, kind: 'connects_to', sourceId, targetId, attributes: {}, confidence: 0.8,
    firstSeen: '2026-01-01T00:00:00.000Z', lastSeen: '2026-01-01T00:00:00.000Z',
    sourceIntegrationIds: ['integration-1'], evidenceIds: ['evidence-1'],
  }
}

function snapshot(entities: TerrainEntity[], relationships: TerrainRelationship[] = []): TerrainSnapshot {
  return { generatedAt: '2026-01-01T00:00:00.000Z', entities, relationships, observationCount: 1, unresolvedClaims: 0 }
}

describe('cyber terrain topology', () => {
  it('is genuinely empty before evidence creates entities', () => {
    expect(buildTopology(snapshot([]))).toEqual({ nodes: [], edges: [] })
  })

  it('projects persisted terrain entities instead of integrations or deployment metadata', () => {
    const topology = buildTopology(snapshot([
      entity('device-1', 'device:1', 'Device', 'Workstation 1'),
      entity('ip-1', 'ip:10.0.0.8', 'IPAddress', '10.0.0.8'),
    ], [relationship('edge-1', 'device-1', 'ip-1')]))
    expect(topology.nodes.map((node) => node.id)).toEqual(['device-1', 'ip-1'])
    expect(topology.edges).toContainEqual(expect.objectContaining({ id: 'edge-1', start: 'device-1', end: 'ip-1' }))
    expect(topology.nodes.map((node) => node.label)).toEqual(['Workstation 1', '10.0.0.8'])
  })

  it('drops orphan relationships rather than giving Orb invalid topology', () => {
    const topology = buildTopology(snapshot([entity('device-1', 'device:1', 'Device', 'Workstation 1')], [relationship('orphan', 'device-1', 'missing')]))
    expect(topology.edges).toEqual([])
  })

  it('assigns neutral icon families from entity kinds', () => {
    expect(presentationFor('UserAccount').family).toBe('Identity')
    expect(presentationFor('NetworkConnection').family).toBe('Network')
    expect(presentationFor('unknown-custom-kind').family).toBe('Other')
  })
})
