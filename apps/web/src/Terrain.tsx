import { useEffect, useMemo, useRef, useState } from 'react'
import type { IEdgeLineStyle, IGraphStyle, NodeShapeType, OrbView as OrbViewType } from '@memgraph/orb'
import type { PortalData } from './api.js'
import { buildTopology, presentationFor, type TerrainOrbEdge, type TerrainOrbNode } from './terrain-topology.js'
import { Badge, Button, Card } from './components/ui/index.js'

const LAYOUTS = [
  { id: 'force', label: 'FORCE' },
  { id: 'hierarchical', label: 'HIERARCHY' },
  { id: 'circular', label: 'CIRCULAR' },
] as const
type TerrainLayout = (typeof LAYOUTS)[number]['id']

const graphStyle: IGraphStyle<TerrainOrbNode, TerrainOrbEdge> = {
  getNodeStyle(node) {
    const data = node.getData()
    return {
      color: data.color, colorHover: '#ffcf33', colorSelected: '#ff5f1f', borderColor: '#111111', borderColorHover: '#111111',
      borderColorSelected: '#111111', borderWidth: 2, borderWidthSelected: 4, size: 18, shape: 'circle' as NodeShapeType,
      imageUrl: data.icon, imageUrlSelected: data.icon, label: data.label.toUpperCase(), fontColor: '#111111', fontBackgroundColor: '#fffdf8',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, shadowColor: '#111111', shadowSize: 0,
    }
  },
  getEdgeStyle(edge) {
    const data = edge.getData()
    return {
      color: '#8f897c', colorHover: '#111111', colorSelected: '#ff5f1f', width: 1.5, widthHover: 2.5, widthSelected: 3,
      label: data.label.toUpperCase(), fontColor: '#5f5a51', fontBackgroundColor: '#f5f1e8', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 10, arrowSize: 8, lineStyle: { type: 'solid' } as IEdgeLineStyle,
    }
  },
}

export function TerrainView({ data, onOpenIntegrations, onRefresh }: { data: PortalData; onOpenIntegrations: () => void; onRefresh: () => Promise<void> }) {
  const topology = useMemo(() => buildTopology(data.terrain), [data.terrain])
  const [layout, setLayout] = useState<TerrainLayout>('force')
  const [selected, setSelected] = useState<TerrainOrbNode>()
  const stage = useRef<HTMLDivElement | null>(null)
  const orb = useRef<OrbViewType<TerrainOrbNode, TerrainOrbEdge> | null>(null)

  useEffect(() => {
    const timer = window.setInterval(() => { void onRefresh() }, 5_000)
    return () => window.clearInterval(timer)
  }, [onRefresh])

  useEffect(() => {
    if (!stage.current || topology.nodes.length === 0) return
    let view: OrbViewType<TerrainOrbNode, TerrainOrbEdge> | undefined
    let cancelled = false
    void import('@memgraph/orb').then(({ OrbEventType, OrbView, RendererType }) => {
      if (cancelled || !stage.current) return
      view = new OrbView<TerrainOrbNode, TerrainOrbEdge>(stage.current, {
      render: {
        type: RendererType.CANVAS, backgroundColor: 'rgba(0,0,0,0)', labelsIsEnabled: true, labelsOnEventIsEnabled: true,
        shadowIsEnabled: false, fitZoomMargin: 80, minZoom: 0.08, maxZoom: 5,
      },
      layout: {
        type: layout,
        options: layout === 'force'
          ? { links: { distance: 150, strength: 0.65, iterations: 2 }, manyBody: { strength: -420, distanceMin: 25, distanceMax: 900, theta: 0.9 } }
          : layout === 'hierarchical'
            ? { orientation: 'vertical', nodeGap: 70, levelGap: 130, treeGap: 90 }
            : { radius: Math.max(180, topology.nodes.length * 16), centerX: 0, centerY: 0 },
      },
      zoomFitTransitionMs: 300,
    })
      view.data.setDefaultStyle(graphStyle)
      view.data.setup(topology)
      view.events.on(OrbEventType.NODE_CLICK, ({ node }) => setSelected(node.getData()))
      view.events.on(OrbEventType.MOUSE_CLICK, ({ subject }) => { if (!subject) setSelected(undefined) })
      view.render(() => view?.recenter())
      orb.current = view
    })
    return () => { cancelled = true; view?.destroy(); if (orb.current === view) orb.current = null }
  }, [layout, topology])

  const exportSvg = () => {
    const svg = orb.current?.getSVG({})
    if (!svg) return
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
    const link = document.createElement('a')
    link.href = url; link.download = 'papyrus-cyber-terrain.svg'; document.body.appendChild(link); link.click(); link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  const legend = [...new Map(topology.nodes.map((node) => {
    const presentation = presentationFor(node.kind)
    return [presentation.family, presentation] as const
  })).entries()]

  return <Card className="terrain-graph-card">
    <div className="terrain-toolbar"><Badge>{topology.nodes.length ? 'LIVE TERRAIN' : 'NO TERRAIN DATA'}</Badge>
      <span>{topology.nodes.length} entities · {topology.edges.length} relationships · {data.terrain.observationCount} observations · {data.terrain.unresolvedClaims} unresolved claims</span>
      <div className="terrain-controls">
        <div className="segmented" role="group" aria-label="Topology layout">
          {LAYOUTS.map((option) => <button key={option.id} className={layout === option.id ? 'active' : ''} onClick={() => setLayout(option.id)}>{option.label}</button>)}
        </div>
        <Button onClick={() => void onRefresh()}>REFRESH</Button>
        <Button disabled={!topology.nodes.length} onClick={() => orb.current?.recenter()}>FIT</Button>
        <Button disabled={!topology.nodes.length} onClick={exportSvg}>EXPORT SVG</Button>
      </div>
    </div>
    <div className="terrain-stage">
      {topology.nodes.length > 0 ? <div ref={stage} className="terrain-orb" aria-label="Cyber terrain graph" /> : <TerrainEmpty onOpenIntegrations={onOpenIntegrations} />}
      {legend.length > 0 && <div className="terrain-legend">{legend.map(([family, presentation]) => <span key={family}><i style={{ background: presentation.color }} />{family.toUpperCase()}</span>)}</div>}
      {selected && <TerrainDetail node={selected} onClose={() => setSelected(undefined)} />}
    </div>
  </Card>
}

function TerrainEmpty({ onOpenIntegrations }: { onOpenIntegrations: () => void }) {
  return <div className="terrain-empty"><span aria-hidden="true">⌘</span><h2>No observed topology</h2>
    <p>Terrain begins when an active connector publishes evidence. Integration configuration and deployment metadata are never rendered as entities.</p>
    <Button className="primary" onClick={onOpenIntegrations}>Configure integrations →</Button>
  </div>
}

function TerrainDetail({ node, onClose }: { node: TerrainOrbNode; onClose: () => void }) {
  return <aside className="terrain-detail">
    <div className="terrain-detail-head"><p className="eyebrow">{node.kind.toUpperCase()}</p><Button variant="ghost" aria-label="Close details" onClick={onClose}>×</Button></div>
    <h3>{node.label}</h3>
    <span className="terrain-detail-sub">{node.id.slice(0, 16)}…</span>
    <dl className="facts">
      <div><dt>Confidence</dt><dd>{Math.round(node.confidence * 100)}%</dd></div>
      <div><dt>First seen</dt><dd>{new Date(node.firstSeen).toLocaleString()}</dd></div>
      <div><dt>Last seen</dt><dd>{new Date(node.lastSeen).toLocaleString()}</dd></div>
      <div><dt>Sources</dt><dd>{node.sourceIntegrationIds.length}</dd></div>
      <div><dt>Evidence</dt><dd>{node.evidenceIds.length}</dd></div>
    </dl>
    {Object.keys(node.attributes).length > 0 && <div className="terrain-attributes"><p className="eyebrow">ATTRIBUTES</p>{Object.entries(node.attributes).slice(0, 12).map(([key, value]) => <div key={key}><span>{key}</span><strong>{String(value)}</strong></div>)}</div>}
  </aside>
}
