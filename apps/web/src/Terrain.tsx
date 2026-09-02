import { useMemo, useRef, useState, type RefObject } from 'react'
import type { GraphCanvasRef, GraphNode, NodeRendererProps, Theme } from 'reagraph'
import { GraphCanvas, Sphere, SphereWithIcon, lightTheme, useSelection } from 'reagraph'
import type { PortalData } from './api.js'
import { buildTopology, CLASS_META, type TerrainNodeMeta } from './terrain-topology.js'
import { Badge, Button, Card } from './components/ui/index.js'

const terrainTheme: Theme = {
  ...lightTheme,
  canvas: { background: '#f5f1e8', fog: '#f5f1e8' },
  node: {
    ...lightTheme.node,
    fill: '#111111',
    activeFill: '#ff5f1f',
    label: {
      ...lightTheme.node.label, color: '#111111', activeColor: '#111111', stroke: '#f5f1e8',
      backgroundColor: '#fffdf8', backgroundOpacity: 0.9, padding: 1.6, radius: 0.12, strokeColor: '#111111', strokeWidth: 0.28,
    },
  },
  edge: { ...lightTheme.edge, fill: '#a89f8d', activeFill: '#111111', label: { ...lightTheme.edge.label, color: '#68655f', activeColor: '#111111' } },
  arrow: { fill: '#a89f8d', activeFill: '#111111' },
  ring: { fill: '#111111', activeFill: '#ff5f1f' },
  lasso: { background: 'rgba(255, 95, 31, 0.08)', border: '1px dashed #ff5f1f' },
}

const LAYOUTS = [
  { id: 'forceDirected3d', label: 'FORCE 3D' },
  { id: 'concentric3d', label: 'CONCENTRIC 3D' },
] as const
type TerrainLayout = (typeof LAYOUTS)[number]['id']

const KIND_COPY: Record<TerrainNodeMeta['kind'], string> = {
  twin: 'CYBER RESILIENCE TWIN', authority: 'DEPLOYMENT AUTHORITY', class: 'CONNECTOR CLASS', integration: 'CONNECTOR',
}

export function TerrainView({ data, onOpenIntegrations }: { data: PortalData; onOpenIntegrations: () => void }) {
  const topology = useMemo(() => buildTopology(data), [data])
  const [layout, setLayout] = useState<TerrainLayout>('forceDirected3d')
  const graphRef = useRef<GraphCanvasRef | null>(null)
  const { selections, actives, onNodeClick, onCanvasClick } = useSelection({
    ref: graphRef, nodes: topology.nodes, edges: topology.edges, type: 'single', pathHoverType: 'out',
  })
  const selected = topology.nodes.find((node) => selections.includes(node.id))
  const selectedMeta = selected?.data as TerrainNodeMeta | undefined

  const exportImage = () => {
    const url = graphRef.current?.exportCanvas()
    if (!url) return
    const link = document.createElement('a')
    link.href = url
    link.download = 'papyrus-cyber-terrain.png'
    link.click()
  }

  const legend = topology.nodes.flatMap((node) => {
    const meta = node.data as TerrainNodeMeta | undefined
    return meta?.kind === 'class' && meta.integrationClass ? [{ id: node.id, meta: CLASS_META[meta.integrationClass] }] : []
  })

  return <Card className="terrain-graph-card">
    <div className="terrain-toolbar"><Badge>LIVE TWIN</Badge>
      <span>{topology.nodes.length} entities · {topology.edges.length} relationships · 0 unresolved claims</span>
      <div className="terrain-controls">
        <div className="segmented" role="group" aria-label="Topology layout">
          {LAYOUTS.map((option) => <button key={option.id} className={layout === option.id ? 'active' : ''} onClick={() => setLayout(option.id)}>{option.label}</button>)}
        </div>
        <Button onClick={() => graphRef.current?.fitNodesInView()}>FIT</Button>
        <Button onClick={exportImage}>EXPORT PNG</Button>
      </div>
    </div>
    <div className="terrain-stage">
      <GraphCanvas
        ref={graphRef}
        nodes={topology.nodes}
        edges={topology.edges}
        theme={terrainTheme}
        layoutType={layout}
        cameraMode="orbit"
        animated
        labelType="all"
        labelFontUrl="/fonts/Roboto-Regular.ttf"
        selections={selections}
        actives={actives}
        onNodeClick={(node) => onNodeClick?.(node)}
        onCanvasClick={(event) => onCanvasClick?.(event)}
        renderNode={renderTerrainNode}
        contextMenu={(event) => <TerrainContextMenu target={event.data} onClose={event.onClose} graphRef={graphRef} onOpenIntegrations={onOpenIntegrations} />}
        glOptions={{ preserveDrawingBuffer: true }}
      />
      <div className="terrain-legend">
        <span><i style={{ background: '#ff5f1f' }} />CYBER TWIN</span>
        {legend.map((entry) => <span key={entry.id}><i style={{ background: entry.meta.accent }} />{entry.meta.label.toUpperCase()}</span>)}
      </div>
      {selected && selectedMeta && <TerrainDetail node={selected} meta={selectedMeta} onOpenIntegrations={onOpenIntegrations} />}
      {data.integrations.length === 0 && <p className="terrain-hint">Connect terrain and evidence sources to begin forming the graph.</p>}
    </div>
  </Card>
}

function renderTerrainNode({ node, ...rest }: NodeRendererProps) {
  return node.icon ? <SphereWithIcon {...rest} node={node} image={node.icon} /> : <Sphere {...rest} node={node} />
}

function TerrainContextMenu({ target, onClose, graphRef, onOpenIntegrations }: {
  target: TerrainContextMenuTarget
  onClose: () => void
  graphRef: RefObject<GraphCanvasRef | null>
  onOpenIntegrations: () => void
}) {
  const meta = (target.data ?? undefined) as TerrainNodeMeta | undefined
  const edge = 'source' in target ? target : undefined
  const center = () => {
    if (edge) graphRef.current?.centerGraph([edge.source, edge.target])
    else graphRef.current?.centerGraph([target.id])
    onClose()
  }
  return <div className="terrain-context-menu">
    <p className="eyebrow">{meta ? KIND_COPY[meta.kind] : edge ? 'EVIDENCE LINK' : 'TOPOLOGY'}</p>
    <strong>{(target.label ?? target.id).toString().toUpperCase()}</strong>
    <button onClick={center}>Center camera</button>
    <button onClick={() => { void navigator.clipboard?.writeText(target.id); onClose() }}>Copy identifier</button>
    {meta?.kind === 'integration' && <button onClick={() => { onClose(); onOpenIntegrations() }}>Open in Integrations →</button>}
    <button onClick={onClose}>Dismiss</button>
  </div>
}

type TerrainContextMenuTarget = Parameters<NonNullable<Parameters<typeof GraphCanvas>[0]['contextMenu']>>[0]['data']

function TerrainDetail({ node, meta, onOpenIntegrations }: { node: GraphNode; meta: TerrainNodeMeta; onOpenIntegrations: () => void }) {
  return <aside className="terrain-detail">
    <p className="eyebrow">{KIND_COPY[meta.kind]}</p>
    <h3>{node.label ?? node.id}</h3>
    {node.subLabel && <span className="terrain-detail-sub">{node.subLabel}</span>}
    {meta.kind === 'integration' && <dl className="facts">
      <div><dt>State</dt><dd>{(meta.state ?? '').replaceAll('_', ' ').toUpperCase()}</dd></div>
      <div><dt>Health</dt><dd>{(meta.health ?? 'unknown').toUpperCase()}</dd></div>
      <div><dt>Risk</dt><dd>{(meta.risk ?? '').toUpperCase()}</dd></div>
      <div><dt>Authority</dt><dd>{(meta.authority ?? '').replaceAll('_', ' ').toUpperCase()}</dd></div>
      <div><dt>Scope</dt><dd>{meta.scope}</dd></div>
      {meta.endpoint && <div><dt>Endpoint</dt><dd>{meta.endpoint}</dd></div>}
    </dl>}
    {meta.kind === 'integration' && <Button className="primary" onClick={onOpenIntegrations}>Open in Integrations →</Button>}
  </aside>
}
