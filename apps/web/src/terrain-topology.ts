import type { GraphEdge, GraphNode } from 'reagraph'
import type { IntegrationClass, IntegrationConfiguration, IntegrationState } from '@papyrus/contracts'
import type { PortalData } from './api.js'

export interface TerrainNodeMeta {
  kind: 'twin' | 'authority' | 'class' | 'integration'
  integrationClass?: IntegrationClass
  state?: IntegrationState
  health?: IntegrationConfiguration['health']
  risk?: IntegrationConfiguration['risk']
  authority?: IntegrationConfiguration['authority']
  scope?: string
  endpoint?: string
}

export interface TerrainTopology { nodes: GraphNode[]; edges: GraphEdge[] }

export const CLASS_META: Record<IntegrationClass, { label: string; icon: string; accent: string }> = {
  human_interface: { label: 'Human interface', icon: '/icons/human-interface.svg', accent: '#82c9ff' },
  evidence_source: { label: 'Evidence source', icon: '/icons/evidence.svg', accent: '#ffd36e' },
  terrain_source: { label: 'Terrain source', icon: '/icons/terrain.svg', accent: '#ff9fb4' },
  action_executor: { label: 'Action executor', icon: '/icons/executor.svg', accent: '#ff6b4a' },
  agent_peer: { label: 'Agent peer', icon: '/icons/peer.svg', accent: '#c4f078' },
  infrastructure: { label: 'Infrastructure', icon: '/icons/infrastructure.svg', accent: '#b9b2a6' },
}

export const DISABLED_FILL = '#b9b2a6'
const RISK_BUMP: Record<IntegrationConfiguration['risk'], number> = { low: 0, moderate: 1, high: 2, critical: 3 }

export function buildTopology(data: PortalData): TerrainTopology {
  const license = data.overview.deployment.license
  const nodes: GraphNode[] = [
    { id: 'twin', label: 'CYBER TWIN', subLabel: 'customer-hosted', icon: '/icons/twin.svg', fill: '#ff5f1f', size: 26, labelVisible: true, data: { kind: 'twin' } satisfies TerrainNodeMeta },
    { id: 'authority:identity', label: 'MICROSOFT ENTRA', subLabel: 'identity authority', icon: '/icons/identity.svg', fill: '#82c9ff', size: 13, data: { kind: 'authority' } satisfies TerrainNodeMeta },
    { id: 'authority:runtime', label: 'STARLINGS', subLabel: 'collective runtime', icon: '/icons/runtime.svg', fill: '#d7b7ff', size: 13, data: { kind: 'authority' } satisfies TerrainNodeMeta },
    { id: 'authority:license', label: license.valid ? 'LICENSE ACTIVE' : 'ACTIVATION REQUIRED', subLabel: 'offline entitlement', icon: '/icons/license.svg', fill: license.valid ? '#71df98' : '#ffd36e', size: 13, data: { kind: 'authority' } satisfies TerrainNodeMeta },
  ]
  const edges: GraphEdge[] = [
    { id: 'edge:authority:identity', source: 'authority:identity', target: 'twin', label: 'identity authority', arrowPlacement: 'end' },
    { id: 'edge:authority:runtime', source: 'authority:runtime', target: 'twin', label: 'computation', arrowPlacement: 'end' },
    { id: 'edge:authority:license', source: 'authority:license', target: 'twin', label: 'entitlement', arrowPlacement: 'end' },
  ]
  const byClass = new Map<IntegrationClass, IntegrationConfiguration[]>()
  for (const integration of data.integrations) {
    byClass.set(integration.integrationClass, [...(byClass.get(integration.integrationClass) ?? []), integration])
  }
  for (const [integrationClass, members] of byClass) {
    const meta = CLASS_META[integrationClass]
    const anchorId = `class:${integrationClass}`
    nodes.push({ id: anchorId, label: meta.label.toUpperCase(), subLabel: `${members.length} connector${members.length === 1 ? '' : 's'}`, icon: meta.icon, fill: meta.accent, size: 16, data: { kind: 'class', integrationClass } satisfies TerrainNodeMeta })
    edges.push({ id: `edge:${anchorId}`, source: anchorId, target: 'twin', label: meta.label.toLowerCase(), arrowPlacement: 'end' })
    for (const integration of members) {
      const accent = data.catalog.find((entry) => entry.id === integration.catalogId)?.accent ?? meta.accent
      const active = integration.state === 'active'
      nodes.push({
        id: integration.id, label: integration.name.toUpperCase(), subLabel: integration.state.replaceAll('_', ' ').toUpperCase(),
        icon: meta.icon, fill: integration.state === 'disabled' ? DISABLED_FILL : accent, size: 9 + RISK_BUMP[integration.risk],
        data: {
          kind: 'integration', integrationClass, state: integration.state, health: integration.health, risk: integration.risk, authority: integration.authority, scope: integration.scope,
          ...(integration.endpoint ? { endpoint: integration.endpoint } : {}),
        } satisfies TerrainNodeMeta,
      })
      edges.push({ id: `edge:${integration.id}`, source: integration.id, target: anchorId, label: integration.state.replaceAll('_', ' '), dashed: !active, arrowPlacement: 'end', ...(active ? {} : { fill: DISABLED_FILL }) })
    }
  }
  return { nodes, edges }
}
