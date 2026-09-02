import type { IEdgeBase, INodeBase } from '@memgraph/orb'
import type { TerrainEntity, TerrainRelationship, TerrainSnapshot } from '@papyrus/contracts'

export interface TerrainOrbNode extends INodeBase {
  id: string
  label: string
  kind: string
  icon: string
  color: string
  confidence: number
  firstSeen: string
  lastSeen: string
  attributes: Record<string, unknown>
  sourceIntegrationIds: string[]
  evidenceIds: string[]
}

export interface TerrainOrbEdge extends IEdgeBase {
  id: string
  start: string
  end: string
  label: string
  kind: string
  confidence: number
  firstSeen: string
  lastSeen: string
  attributes: Record<string, unknown>
  sourceIntegrationIds: string[]
  evidenceIds: string[]
}

export interface TerrainTopology { nodes: TerrainOrbNode[]; edges: TerrainOrbEdge[] }

export interface KindPresentation { icon: string; color: string; family: string }

const PRESENTATION: Array<{ match: RegExp; value: KindPresentation }> = [
  { match: /(identity|user|account|principal|group|role|privilege)/i, value: { icon: '/icons/identity.svg', color: '#82c9ff', family: 'Identity' } },
  { match: /(alert|incident|finding|vulnerability|threat)/i, value: { icon: '/icons/evidence.svg', color: '#ff9f72', family: 'Finding' } },
  { match: /(device|host|server|endpoint|router|firewall|workstation|asset)/i, value: { icon: '/icons/infrastructure.svg', color: '#71df98', family: 'Asset' } },
  { match: /(ip|domain|dns|network|connection|flow|subnet|certificate|service)/i, value: { icon: '/icons/terrain.svg', color: '#ffd36e', family: 'Network' } },
  { match: /(process|file|registry|software|application)/i, value: { icon: '/icons/runtime.svg', color: '#d7b7ff', family: 'Software' } },
]

export function presentationFor(kind: string): KindPresentation {
  return PRESENTATION.find((entry) => entry.match.test(kind))?.value
    ?? { icon: '/icons/twin.svg', color: '#b9b2a6', family: 'Other' }
}

export function buildTopology(snapshot: TerrainSnapshot): TerrainTopology {
  const nodeIds = new Set(snapshot.entities.map((entity) => entity.id))
  return {
    nodes: snapshot.entities.map(node),
    edges: snapshot.relationships.filter((relationship) => nodeIds.has(relationship.sourceId) && nodeIds.has(relationship.targetId)).map(edge),
  }
}

function node(entity: TerrainEntity): TerrainOrbNode {
  const presentation = presentationFor(entity.kind)
  return {
    id: entity.id, label: entity.label, kind: entity.kind, icon: presentation.icon, color: presentation.color,
    confidence: entity.confidence, firstSeen: entity.firstSeen, lastSeen: entity.lastSeen, attributes: entity.attributes,
    sourceIntegrationIds: entity.sourceIntegrationIds, evidenceIds: entity.evidenceIds,
  }
}

function edge(relationship: TerrainRelationship): TerrainOrbEdge {
  return {
    id: relationship.id, start: relationship.sourceId, end: relationship.targetId, label: relationship.kind, kind: relationship.kind,
    confidence: relationship.confidence, firstSeen: relationship.firstSeen, lastSeen: relationship.lastSeen, attributes: relationship.attributes,
    sourceIntegrationIds: relationship.sourceIntegrationIds, evidenceIds: relationship.evidenceIds,
  }
}
