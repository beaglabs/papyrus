import {
  Background,
  Controls,
  type Edge,
  MiniMap,
  type Node,
  type NodeTypes,
  ReactFlow,
  type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { tokens } from '@papyrus/core/design'
import type { CanvasNodeDoc, EdgeDoc } from '@papyrus/core/nodes/types'
import gsap from 'gsap'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useCanvasSync } from '../hooks/useCanvasSync'
import { usePresence } from '../hooks/usePresence'
import { AgentChat } from './AgentChat'
import { NetworkHealth } from './NetworkHealth'
import { TaskList } from './TaskList'

const PEER_ID = `peer-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
const PEER_COLORS = ['#ff5f1f', '#a78bfa', '#60a5fa', '#34d399', '#facc15']
const MY_COLOR = PEER_COLORS[Math.floor(Math.random() * PEER_COLORS.length)] ?? '#ff5f1f'
const MY_NAME = `User ${Math.floor(Math.random() * 900 + 100)}`

const PERSONA_LIST = [
  {
    id: 'pm',
    name: 'Product Manager',
    role: 'PM',
    color: tokens.color.persona.pm ?? '#ff5f1f',
    icon: '\u{1F4CB}',
    description: 'Defines requirements and product vision.',
  },
  {
    id: 'designer',
    name: 'Designer',
    role: 'DESIGN',
    color: tokens.color.persona.designer ?? '#a78bfa',
    icon: '\u{1F3A8}',
    description: 'Creates wireframes and design systems.',
  },
  {
    id: 'engineer',
    name: 'Engineer',
    role: 'ENG',
    color: tokens.color.persona.engineer ?? '#60a5fa',
    icon: '\u{2699}\u{FE0F}',
    description: 'Designs architecture and APIs.',
  },
  {
    id: 'security',
    name: 'Security Reviewer',
    role: 'SEC',
    color: tokens.color.persona.security ?? '#facc15',
    icon: '\u{1F512}',
    description: 'Reviews threats and compliance.',
  },
]

type CanvasPersona = (typeof PERSONA_LIST)[number]

const NODE_ICONS: Record<string, string> = {
  specification: '\u{1F4C4}',
  'ui-mockup': '\u{1F3A8}',
  application: '\u{1F4BB}',
  'mcp-server': '\u{1F5C4}\u{FE0F}',
  'skill-creator': '\u{1F9E9}',
  api: '\u{1F527}',
  dataset: '\u{1F4CA}',
}

interface CanvasProps {
  projectId: string
  projectName: string
  onBack: () => void
}

const nodeActionStyle: React.CSSProperties = {
  marginTop: 8,
  padding: '6px 10px',
  background: tokens.color.accent,
  border: `2px solid ${tokens.color.black}`,
  borderRadius: tokens.radius.sm,
  boxShadow: '2px 2px 0 #111',
  color: tokens.color.black,
  fontSize: 10,
  fontWeight: 800,
  cursor: 'pointer',
  fontFamily: tokens.font.mono,
  textTransform: 'uppercase',
}

const nodeSecondaryActionStyle: React.CSSProperties = {
  ...nodeActionStyle,
  background: tokens.color.surface,
  color: tokens.color.text,
}

/** Animate a new node appearing. */
function animateNodeIn(nodeId: string) {
  const el = document.querySelector(`[data-id="${nodeId}"]`)
  if (!el) return
  gsap.fromTo(
    el,
    { opacity: 0, scale: 0.7, y: 20 },
    { opacity: 1, scale: 1, y: 0, duration: 0.5, ease: 'back.out(1.7)' },
  )
}

export function Canvas({ projectId, projectName, onBack }: CanvasProps) {
  const { apiFetch, loadProjectRole, clearProjectRole, projectRole } = useAuth()
  const {
    nodes,
    edges,
    connected,
    upsertNode,
    deleteNode,
    addEdge,
    deleteEdge,
    onNodesChange,
    onEdgesChange,
    sendCursor,
    setNodes,
  } = useCanvasSync(projectId, PEER_ID, MY_NAME, MY_COLOR)
  const presence = usePresence()
  const [rfInstance, setRfInstance] = useState<ReactFlowInstance | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  useEffect(() => {
    loadProjectRole(projectId)
    return () => clearProjectRole()
  }, [projectId, loadProjectRole, clearProjectRole])

  const canEdit = projectRole === 'owner' || projectRole === 'editor' || projectRole === null
  const [remoteCursors, setRemoteCursors] = useState<
    Map<string, { x: number; y: number; displayName: string; color: string }>
  >(new Map())
  const prevNodeCount = useRef(nodes.length)
  const prevEdgeCount = useRef(edges.length)
  const defaultPersona = PERSONA_LIST[0] as CanvasPersona
  const [activePersona, setActivePersona] = useState<CanvasPersona>(defaultPersona)

  useEffect(() => {
    if (nodes.length > prevNodeCount.current) {
      const newNode = nodes[nodes.length - 1]
      if (newNode) requestAnimationFrame(() => animateNodeIn(newNode.id))
    }
    prevNodeCount.current = nodes.length
  }, [nodes])

  useEffect(() => {
    if (edges.length > prevEdgeCount.current) {
      const newEdge = edges[edges.length - 1]
      if (newEdge) {
        const el = document.querySelector(`[data-id="${newEdge.id}"] .react-flow__edge-path`)
        if (el) {
          const length = (el as SVGPathElement).getTotalLength?.() ?? 200
          gsap.fromTo(
            el,
            { strokeDasharray: length, strokeDashoffset: length },
            { strokeDashoffset: 0, duration: 0.8, ease: 'power2.out' },
          )
        }
      }
    }
    prevEdgeCount.current = edges.length
  }, [edges])

  useEffect(() => {
    function handleCursorUpdate(e: Event) {
      const detail = (e as CustomEvent).detail
      if (detail?.type === 'cursor:update') {
        setRemoteCursors((prev) => {
          const next = new Map(prev)
          next.set(detail.data.peerId, {
            x: detail.data.x,
            y: detail.data.y,
            displayName: detail.data.displayName,
            color: detail.data.color,
          })
          return next
        })
      }
      if (detail?.type === 'cursor:leave') {
        setRemoteCursors((prev) => {
          const next = new Map(prev)
          next.delete(detail.data.peerId)
          return next
        })
      }
    }
    window.addEventListener('papyrus:presence', handleCursorUpdate)
    return () => window.removeEventListener('papyrus:presence', handleCursorUpdate)
  }, [])

  const lastCursorSend = useRef(0)
  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const now = Date.now()
      if (now - lastCursorSend.current < 50) return
      lastCursorSend.current = now
      const rect = e.currentTarget.getBoundingClientRect()
      sendCursor(e.clientX - rect.left, e.clientY - rect.top)
    },
    [sendCursor],
  )

  const rfNodes: Node[] = useMemo(
    () =>
      nodes.map((doc) => ({
        id: doc.id,
        type: 'canvasNode',
        position: doc.position,
        data: doc as unknown as Record<string, unknown>,
      })),
    [nodes],
  )

  const rfEdges: Edge[] = useMemo(
    () =>
      edges.map((e) => ({
        id: e.id,
        source: e.from,
        target: e.to,
        type: 'smoothstep',
        style: { stroke: tokens.color.borderLight, strokeWidth: 2 },
        markerEnd: { type: 'arrowclosed', color: tokens.color.borderLight, width: 16, height: 16 },
      })),
    [edges],
  )

  const agentCanvasContext = useMemo(
    () =>
      nodes
        .map((node) => {
          const title = String(node.fields.title ?? node.type)
          const content = String(node.fields.content ?? '')
          return `### ${title} [${node.type}]\n${content}`
        })
        .join('\n\n'),
    [nodes],
  )

  // ── Node renderer with preview, name, retry ──────────────────
  const nodeTypes: NodeTypes = useMemo(
    () => ({
      canvasNode: ({ data, selected }) => {
        const doc = data as unknown as CanvasNodeDoc
        const color = tokens.color.category[doc.category] ?? tokens.color.textMuted
        const icon = NODE_ICONS[doc.type] ?? '\u{1F4C4}'
        const title = (doc.fields.title as string) ?? doc.type
        const content = (doc.fields.content as string) ?? ''
        const isOutput = doc.category === 'output'
        const isSource = doc.flowRole === 'source'
        const isGenerating = doc.status === 'running'
        const [showPreview, setShowPreview] = useState(false)
        const [editingName, setEditingName] = useState(false)
        const [nameValue, setNameValue] = useState(title)
        const [editingContent, setEditingContent] = useState(false)
        const [contentValue, setContentValue] = useState(content)
        const isEditableSpec = doc.type === 'specification'

        useEffect(() => {
          if (!editingName) setNameValue(title)
        }, [title, editingName])

        useEffect(() => {
          if (!editingContent) setContentValue(content)
        }, [content, editingContent])

        async function handleRetry() {
          try {
            await apiFetch('/api/retry', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                nodeId: doc.id,
                projectId: doc.projectId,
                persona: activePersona.id,
              }),
            })
          } catch (err) {
            console.error('Retry failed:', err)
          }
        }

        function handleNameSave() {
          if (nameValue.trim() && nameValue !== title) {
            upsertNode({
              ...doc,
              fields: { ...doc.fields, title: nameValue.trim() },
              updatedAt: Date.now(),
            })
          }
          setEditingName(false)
        }

        function handleContentSave() {
          if (contentValue !== content) {
            upsertNode({
              ...doc,
              fields: { ...doc.fields, content: contentValue },
              updatedAt: Date.now(),
            })
          }
          setEditingContent(false)
        }

        return (
          <div
            style={{
              background: tokens.color.surface,
              border: `2px solid ${selected ? tokens.color.accent : tokens.color.black}`,
              borderRadius: tokens.radius.lg,
              minWidth: 240,
              maxWidth: 340,
              boxShadow: selected ? tokens.shadow.glow : '5px 5px 0 #111',
              transition: 'border-color 0.15s, box-shadow 0.15s',
              overflow: 'hidden',
            }}
          >
            {/* Node header */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 12px',
                borderBottom: `1px solid ${tokens.color.border}`,
                background: isSource ? `${color}15` : 'transparent',
              }}
            >
              <span style={{ fontSize: 14, flexShrink: 0 }}>
                {isGenerating ? '\u{23F3}' : icon}
              </span>
              {editingName ? (
                <input
                  type="text"
                  value={nameValue}
                  onChange={(e) => setNameValue(e.target.value)}
                  onBlur={handleNameSave}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleNameSave()
                    if (e.key === 'Escape') {
                      setNameValue(title)
                      setEditingName(false)
                    }
                  }}
                  style={{
                    flex: 1,
                    background: tokens.color.bg,
                    border: `1px solid ${tokens.color.accent}`,
                    borderRadius: tokens.radius.sm,
                    color: tokens.color.text,
                    fontSize: 12,
                    fontWeight: 600,
                    padding: '2px 6px',
                    outline: 'none',
                  }}
                />
              ) : (
                <span
                  onDoubleClick={() => canEdit && setEditingName(true)}
                  style={{
                    flex: 1,
                    fontSize: 12,
                    fontWeight: 600,
                    color: tokens.color.text,
                    cursor: canEdit ? 'text' : 'default',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={canEdit ? 'Double-click to rename' : undefined}
                >
                  {title}
                </span>
              )}
              <span
                style={{
                  fontSize: 9,
                  fontFamily: tokens.font.mono,
                  color: tokens.color.textDim,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}
              >
                {doc.type}
              </span>
            </div>

            {/* Editable specification / content preview */}
            <div style={{ padding: '10px 12px' }}>
              {editingContent ? (
                <>
                  <textarea
                    className="nodrag nowheel"
                    value={contentValue}
                    onChange={(event) => setContentValue(event.target.value)}
                    onKeyDown={(event) => {
                      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter')
                        handleContentSave()
                      if (event.key === 'Escape') {
                        setContentValue(content)
                        setEditingContent(false)
                      }
                    }}
                    rows={12}
                    style={{
                      width: '100%',
                      minWidth: 300,
                      resize: 'vertical',
                      background: tokens.color.bg,
                      color: tokens.color.text,
                      border: `2px solid ${tokens.color.black}`,
                      borderRadius: tokens.radius.md,
                      padding: 10,
                      fontFamily: tokens.font.mono,
                      fontSize: 12,
                      lineHeight: 1.5,
                      outline: 'none',
                    }}
                  />
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <button type="button" onClick={handleContentSave} style={nodeActionStyle}>
                      Save & sync
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setContentValue(content)
                        setEditingContent(false)
                      }}
                      style={nodeSecondaryActionStyle}
                    >
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <div
                  onDoubleClick={() => isEditableSpec && canEdit && setEditingContent(true)}
                  style={{
                    fontSize: 12,
                    color: tokens.color.textMuted,
                    lineHeight: 1.5,
                    maxHeight: showPreview ? 300 : 60,
                    overflow: showPreview ? 'auto' : 'hidden',
                    position: 'relative',
                    whiteSpace: 'pre-wrap',
                    cursor: isEditableSpec && canEdit ? 'text' : 'default',
                  }}
                  title={
                    isEditableSpec && canEdit ? 'Double-click to edit specification' : undefined
                  }
                >
                  {content.slice(0, showPreview ? 5000 : 150)}
                  {!showPreview && content.length > 150 ? '...' : ''}
                </div>
              )}

              {isEditableSpec && canEdit && !editingContent && (
                <button
                  type="button"
                  onClick={() => setEditingContent(true)}
                  style={nodeActionStyle}
                >
                  Edit specification
                </button>
              )}

              {/* Toggle preview */}
              {content.length > 150 && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    setShowPreview(!showPreview)
                  }}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: tokens.color.accent,
                    fontSize: 11,
                    cursor: 'pointer',
                    padding: '4px 0',
                    fontFamily: tokens.font.mono,
                  }}
                >
                  {showPreview ? '\u{25B2} Show less' : '\u{25BC} Preview'}
                </button>
              )}
            </div>

            {/* Node footer with actions */}
            {isOutput && canEdit && !isSource && (
              <div
                style={{
                  display: 'flex',
                  gap: 4,
                  padding: '6px 12px',
                  borderTop: `1px solid ${tokens.color.border}`,
                }}
              >
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    handleRetry()
                  }}
                  disabled={isGenerating}
                  style={{
                    flex: 1,
                    padding: '4px 8px',
                    background: 'transparent',
                    border: `1px solid ${tokens.color.border}`,
                    borderRadius: tokens.radius.sm,
                    color: tokens.color.textMuted,
                    fontSize: 10,
                    fontWeight: 600,
                    cursor: isGenerating ? 'not-allowed' : 'pointer',
                    fontFamily: tokens.font.mono,
                    opacity: isGenerating ? 0.5 : 1,
                  }}
                >
                  {isGenerating ? '\u{23F3} Generating...' : '\u{21BB} Retry'}
                </button>
              </div>
            )}

            {/* Source badge */}
            {isSource && (
              <div
                style={{
                  padding: '4px 12px',
                  fontSize: 9,
                  fontFamily: tokens.font.mono,
                  color: color,
                  textTransform: 'uppercase',
                  letterSpacing: '0.1em',
                  fontWeight: 700,
                  textAlign: 'center',
                }}
              >
                Source
              </div>
            )}
          </div>
        )
      },
    }),
    [apiFetch, canEdit, activePersona.id, upsertNode],
  )

  const onConnect = useCallback(
    (connection: { source?: string | null; target?: string | null }) => {
      if (!connection.source || !connection.target) return
      const edge: EdgeDoc = {
        id: `edge-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        projectId,
        from: connection.source,
        to: connection.target,
        kind: 'flow',
        createdBy: PEER_ID,
        updatedAt: Date.now(),
      }
      addEdge(edge)
    },
    [addEdge, projectId],
  )

  return (
    <div className="app-layout">
      {/* Sidebar — collapsible */}
      <nav className="sidebar" style={{ width: sidebarCollapsed ? 48 : 260 }}>
        <div
          className="sidebar-brand"
          style={{ justifyContent: sidebarCollapsed ? 'center' : 'flex-start' }}
        >
          {!sidebarCollapsed && (
            <>
              <span className="logo">P</span>
              <span className="name">PAPYRUS</span>
            </>
          )}
          {sidebarCollapsed && <span className="logo">P</span>}
        </div>
        {!sidebarCollapsed && (
          <div className="sidebar-nav">
            <button type="button" onClick={onBack}>
              <span className="icon">{'\u{2190}'}</span>
              Back
            </button>
            <button type="button" className="active">
              <span className="icon">{'\u{1F4A1}'}</span>
              Canvas
            </button>
          </div>
        )}
        <div className="sidebar-spacer" />
        <div className="sidebar-footer">
          {!sidebarCollapsed && (
            <>
              <div style={{ marginBottom: 4 }}>{projectName}</div>
              {projectRole && (
                <div
                  style={{
                    fontSize: 11,
                    padding: '2px 8px',
                    borderRadius: 4,
                    background:
                      projectRole === 'owner'
                        ? 'rgba(255,95,31,0.15)'
                        : projectRole === 'editor'
                          ? 'rgba(96,165,250,0.15)'
                          : 'rgba(156,163,175,0.15)',
                    color:
                      projectRole === 'owner'
                        ? tokens.color.accent
                        : projectRole === 'editor'
                          ? '#60a5fa'
                          : '#9ca3af',
                    marginBottom: 8,
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    fontWeight: 600,
                  }}
                >
                  {projectRole}
                </div>
              )}
              <div className="conn-status">
                <span className={`conn-dot ${connected ? 'live' : 'offline'}`} />
                {connected ? 'Connected' : 'Offline'}
              </div>
            </>
          )}
          {/* Collapse toggle */}
          <button
            type="button"
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            style={{
              marginTop: 8,
              background: 'none',
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.sm,
              color: tokens.color.textDim,
              padding: sidebarCollapsed ? '6px' : '4px 8px',
              fontSize: 11,
              cursor: 'pointer',
              width: '100%',
            }}
          >
            {sidebarCollapsed ? '\u{25B6}' : '\u{25C0} Collapse'}
          </button>
        </div>
      </nav>

      {/* Agent chat panel */}
      {canEdit &&
        PERSONA_LIST.map((persona) => (
          <div
            key={persona.id}
            style={{ display: persona.id === activePersona.id ? 'contents' : 'none' }}
          >
            <AgentChat
              persona={persona}
              personas={PERSONA_LIST}
              onPersonaChange={setActivePersona}
              projectId={projectId}
              peerId={PEER_ID}
              canvasContext={agentCanvasContext}
            />
          </div>
        ))}

      {/* Canvas */}
      <div className="canvas-area" onMouseMove={handleMouseMove}>
        {nodes.length === 0 && (
          <div className="canvas-empty">
            <div className="canvas-empty-icon">{'\u{1F4A1}'}</div>
            <div className="canvas-empty-title">Canvas is empty</div>
            <div className="canvas-empty-desc">
              Ask an agent to create something — they'll add nodes here.
            </div>
          </div>
        )}
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onInit={setRfInstance}
          nodeTypes={nodeTypes}
          fitView
          snapToGrid
          snapGrid={[20, 20]}
          defaultEdgeOptions={{
            type: 'smoothstep',
            style: { stroke: tokens.color.borderLight, strokeWidth: 2 },
          }}
        >
          <Background gap={24} size={1} color={tokens.color.border} />
          <Controls />
          <MiniMap
            nodeColor={(n) =>
              tokens.color.category[(n.data as unknown as CanvasNodeDoc).category] ??
              tokens.color.textMuted
            }
            maskColor="rgba(255, 95, 31, 0.08)"
          />
        </ReactFlow>

        {/* Remote cursors */}
        {[...remoteCursors.entries()].map(([peerId, cursor]) => {
          const initials = cursor.displayName
            .split(' ')
            .map((w) => w.charAt(0))
            .join('')
            .slice(0, 2)
            .toUpperCase()
          return (
            <div
              key={peerId}
              style={{
                position: 'absolute',
                left: cursor.x,
                top: cursor.y,
                pointerEvents: 'none',
                zIndex: 1000,
                transition: 'left 0.1s, top 0.1s',
              }}
            >
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: '50%',
                  background: cursor.color || tokens.color.accent,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 10,
                  fontWeight: 700,
                  color: '#fff',
                  boxShadow: '0 2px 6px rgba(0,0,0,0.4)',
                  border: '2px solid rgba(255,255,255,0.2)',
                }}
              >
                {initials}
              </div>
              {cursor.displayName && (
                <div
                  style={{
                    position: 'absolute',
                    left: 30,
                    top: 4,
                    background: cursor.color || tokens.color.accent,
                    color: '#fff',
                    fontSize: 10,
                    fontFamily: tokens.font.mono,
                    padding: '1px 6px',
                    borderRadius: tokens.radius.sm,
                    whiteSpace: 'nowrap',
                    fontWeight: 600,
                  }}
                >
                  {cursor.displayName}
                </div>
              )}
            </div>
          )
        })}

        {/* Presence */}
        <div
          style={{
            position: 'absolute',
            bottom: 16,
            right: 16,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <div className="presence-avatars">
            {[...presence.values()].map((p) => (
              <div
                key={p.peerId}
                className="presence-avatar"
                style={{ background: p.color }}
                title={p.displayName}
              >
                {p.displayName.charAt(0)}
              </div>
            ))}
          </div>
        </div>

        {/* Task List */}
        <TaskList projectId={projectId} />
      </div>

      {/* Network health popout */}
      <NetworkHealth />
    </div>
  )
}
