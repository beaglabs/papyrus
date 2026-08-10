import {
  Background,
  Controls,
  type Edge,
  Handle,
  MiniMap,
  type Node,
  type NodeTypes,
  Position,
  ReactFlow,
  type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  type ArtifactEnvelope,
  isArtifactEnvelope,
  unwrapUswdsArtifact,
} from '@papyrus/core/artifacts/envelope'
import { tokens } from '@papyrus/core/design'
import type { CanvasNodeDoc, EdgeDoc } from '@papyrus/core/nodes/types'
import gsap from 'gsap'
import {
  ArrowLeft,
  BriefcaseBusiness,
  Check,
  ChevronDown,
  ChevronUp,
  CircleX,
  Code2,
  FileText,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  Save,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useCanvasSync } from '../hooks/useCanvasSync'
import { usePresence } from '../hooks/usePresence'
import { AgentChat } from './AgentChat'
import { ArtifactRenderer } from './ArtifactRenderer'
import { TaskList } from './TaskList'

const PEER_COLORS = ['#ff5f1f', '#a78bfa', '#60a5fa', '#34d399', '#facc15']

const PERSONA_LIST = [
  {
    id: 'pm',
    name: 'Product Manager',
    role: 'PM',
    color: tokens.color.persona.pm ?? '#ff5f1f',
    icon: BriefcaseBusiness,
    description: 'Defines requirements and product vision.',
  },
  {
    id: 'designer',
    name: 'Designer',
    role: 'DESIGN',
    color: tokens.color.persona.designer ?? '#a78bfa',
    icon: Palette,
    description: 'Creates wireframes and design systems.',
  },
  {
    id: 'engineer',
    name: 'Engineer',
    role: 'ENG',
    color: tokens.color.persona.engineer ?? '#60a5fa',
    icon: Code2,
    description: 'Designs architecture and APIs.',
  },
  {
    id: 'security',
    name: 'Security Reviewer',
    role: 'SEC',
    color: tokens.color.persona.security ?? '#facc15',
    icon: ShieldCheck,
    description: 'Reviews threats and compliance.',
  },
]

const NODE_ICONS: Record<string, string> = {
  specification: '\u{1F4C4}',
  'user-story': '\u{1F4DD}',
  'success-metric': '\u{1F3AF}',
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
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 5,
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
  pointerEvents: 'auto',
  position: 'relative',
  zIndex: 4,
  fontFamily: tokens.font.mono,
  textTransform: 'uppercase',
}

export function Canvas({ projectId, projectName, onBack }: CanvasProps) {
  const { apiFetch, loadProjectRole, clearProjectRole, projectRole, user, token } = useAuth()
  const peerId = user?.memberKey ?? 'anonymous'
  const peerName = user?.displayName ?? 'Anonymous'
  const peerColor =
    PEER_COLORS[
      [...peerId].reduce((sum, character) => sum + character.charCodeAt(0), 0) % PEER_COLORS.length
    ] ?? '#ff5f1f'
  const {
    nodes,
    edges,
    connected,
    pendingOperations,
    syncStatus,
    upsertNode,
    deleteNode,
    addEdge,
    deleteEdge,
    onNodesChange,
    onEdgesChange,
    sendCursor,
    updateDocumentText,
    setNodes,
  } = useCanvasSync(projectId, peerId, peerName, peerColor, token)
  const presence = usePresence()
  const [rfInstance, setRfInstance] = useState<ReactFlowInstance | null>(null)
  const fittedProjectRef = useRef<string | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([])
  const [briefDraft, setBriefDraft] = useState('')
  const [briefEditing, setBriefEditing] = useState(false)
  const [agentComposerDraft, setAgentComposerDraft] = useState<{
    id: number
    text: string
    targetNodeId?: string
  }>()
  const briefEditorRef = useRef<HTMLTextAreaElement>(null)
  const lastSyncedBriefRef = useRef('')

  useEffect(() => {
    loadProjectRole(projectId)
    return () => clearProjectRole()
  }, [projectId, loadProjectRole, clearProjectRole])

  const canEdit = projectRole === 'owner' || projectRole === 'editor' || projectRole === null
  const sourceNode = useMemo(() => nodes.find((node) => node.flowRole === 'source'), [nodes])
  const sourceContent = String(sourceNode?.fields.content ?? '')
  const briefDirty = briefDraft !== sourceContent

  useEffect(() => {
    if (!briefEditing && (briefDraft === '' || briefDraft === lastSyncedBriefRef.current)) {
      setBriefDraft(sourceContent)
    }
    lastSyncedBriefRef.current = sourceContent
  }, [briefDraft, briefEditing, sourceContent])

  const saveProjectBrief = useCallback(() => {
    if (!sourceNode || !briefDirty) return
    updateDocumentText(sourceNode.id, sourceContent, briefDraft)
  }, [briefDirty, briefDraft, sourceContent, sourceNode, updateDocumentText])

  const openProjectBrief = useCallback(() => {
    setSidebarCollapsed(false)
    requestAnimationFrame(() => briefEditorRef.current?.focus())
  }, [])

  const askPmToRefine = useCallback(() => {
    if (briefDirty) saveProjectBrief()
    setAgentComposerDraft({
      id: Date.now(),
      text: `Review and refine the current project brief. Preserve the intent, remove ambiguity, and propose a clearer version for my approval.\n\nCurrent brief:\n${briefDraft || sourceContent}`,
    })
  }, [briefDirty, briefDraft, saveProjectBrief, sourceContent])
  const [remoteCursors, setRemoteCursors] = useState<
    Map<string, { x: number; y: number; displayName: string; color: string }>
  >(new Map())
  const prevEdgeCount = useRef(edges.length)
  useEffect(() => {
    if (!rfInstance || nodes.length === 0 || fittedProjectRef.current === projectId) return
    fittedProjectRef.current = projectId
    requestAnimationFrame(() => rfInstance.fitView({ padding: 0.16, duration: 300 }))
  }, [nodes.length, projectId, rfInstance])

  useEffect(() => {
    if (edges.length > prevEdgeCount.current) {
      const newEdge = edges[edges.length - 1]
      if (newEdge) {
        requestAnimationFrame(() => rfInstance?.fitView({ padding: 0.14, duration: 450 }))
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
  }, [edges, rfInstance])

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
        draggable: true,
        selectable: true,
        data: doc as unknown as Record<string, unknown>,
      })),
    [nodes],
  )

  const repairedArtifactEdgesRef = useRef(new Set<string>())
  useEffect(() => {
    if (!connected) return
    const source = nodes.find((node) => node.flowRole === 'source')
    if (!source) return
    for (const node of nodes) {
      if (node.id === source.id || node.category !== 'output') continue
      if (edges.some((edge) => edge.to === node.id)) continue
      if (repairedArtifactEdgesRef.current.has(node.id)) continue
      repairedArtifactEdgesRef.current.add(node.id)
      addEdge({
        id: `edge-${source.id}-${node.id}`,
        projectId,
        from: source.id,
        to: node.id,
        kind: 'derives',
        createdBy: peerId,
        updatedAt: Date.now(),
      })
    }
  }, [addEdge, connected, edges, nodes, peerId, projectId])

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
          return `### ${title} [${node.type}; id=${node.id}]\n${content}`
        })
        .join('\n\n'),
    [nodes],
  )

  const agentParentNodeIds = useMemo(() => {
    if (selectedNodeIds.length > 0) return selectedNodeIds
    const source = nodes.find((node) => node.flowRole === 'source')
    return source ? [source.id] : []
  }, [nodes, selectedNodeIds])

  const reviewAgentNode = useCallback(
    (nodeId: string, status: 'approved' | 'rejected') => {
      const doc = nodes.find((node) => node.id === nodeId)
      if (!doc) return
      upsertNode({
        ...doc,
        flowRole: status === 'approved' ? 'artifact' : 'review',
        status,
        fields: {
          ...doc.fields,
          reviewedBy: peerId,
          reviewedAt: new Date().toISOString(),
        },
        updatedAt: Date.now(),
      })
    },
    [nodes, peerId, upsertNode],
  )

  const retryAgentNode = useCallback(
    async (nodeId: string) => {
      const doc = nodes.find((node) => node.id === nodeId)
      const response = await apiFetch('/api/retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nodeId,
          projectId,
          persona: String(doc?.fields.requestedPersona ?? 'pm'),
        }),
      })
      if (!response.ok) {
        const body = (await response.json()) as { error?: string }
        throw new Error(body.error ?? 'Retry failed')
      }
    },
    [apiFetch, nodes, projectId],
  )

  const focusAgentNode = useCallback(
    (nodeId: string) => {
      const node = nodes.find((candidate) => candidate.id === nodeId)
      if (!node || !rfInstance) return
      rfInstance.setCenter(node.position.x + 320, node.position.y + 220, {
        zoom: 0.85,
        duration: 500,
      })
      setSelectedNodeIds([nodeId])
    },
    [nodes, rfInstance],
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
        const isWireframe = !!unwrapUswdsArtifact(doc.fields.artifact)
        const hasArtifact = isArtifactEnvelope(doc.fields.artifact) || isWireframe
        const [showPreview, setShowPreview] = useState(false)
        const [editingName, setEditingName] = useState(false)
        const [nameValue, setNameValue] = useState(title)
        const isEditableSpec = doc.type === 'specification' || doc.flowRole === 'source'
        const nodeWidth = hasArtifact ? 640 : isSource ? 360 : isEditableSpec ? 520 : 340

        useEffect(() => {
          if (!editingName) setNameValue(title)
        }, [title, editingName])

        async function handleRetry() {
          try {
            await retryAgentNode(doc.id)
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

        function setProposalStatus(status: 'approved' | 'rejected') {
          reviewAgentNode(doc.id, status)
        }

        function saveArtifactRevision(artifact: ArtifactEnvelope) {
          const savedArtifact: ArtifactEnvelope = {
            ...artifact,
            revision: artifact.revision ? { ...artifact.revision, savedBy: peerId } : undefined,
          }
          upsertNode({
            ...doc,
            fields: {
              ...doc.fields,
              artifact: savedArtifact,
              content: JSON.stringify(savedArtifact, null, 2),
              humanEditedAt: new Date().toISOString(),
              humanEditedBy: peerId,
            },
            updatedAt: Date.now(),
          })
        }

        function askAgentToModifyArtifact() {
          setAgentComposerDraft({
            id: Date.now(),
            targetNodeId: doc.id,
            text: `Modify the existing artifact "${title}". Describe the requested change here: `,
          })
        }

        return (
          <div
            className="canvas-node-surface"
            data-canvas-node-id={doc.id}
            style={{
              background: tokens.color.surface,
              border: `2px solid ${selected ? tokens.color.accent : tokens.color.black}`,
              borderRadius: tokens.radius.lg,
              width: nodeWidth,
              minWidth: isSource ? 320 : isEditableSpec ? 520 : 240,
              maxWidth: nodeWidth,
              boxShadow: selected ? tokens.shadow.glow : '5px 5px 0 #111',
              transition: 'border-color 0.15s, box-shadow 0.15s',
              overflow: 'hidden',
              pointerEvents: 'all',
              position: 'relative',
            }}
          >
            {!isSource && <Handle type="target" position={Position.Left} id="target" />}
            <Handle type="source" position={Position.Right} id="source" />
            {/* Node header */}
            <div
              className="canvas-node-drag-handle"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 12px',
                borderBottom: `1px solid ${tokens.color.border}`,
                background: isSource ? `${color}15` : 'transparent',
                cursor: 'grab',
                touchAction: 'none',
              }}
            >
              <span style={{ fontSize: 14, flexShrink: 0 }}>
                {isGenerating ? '\u{23F3}' : icon}
              </span>
              {editingName ? (
                <input
                  className="nodrag nopan"
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

            {/* Read-only project brief / content preview */}
            <div style={{ padding: '10px 12px' }}>
              {isSource && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                    marginBottom: 8,
                  }}
                >
                  <div>
                    <div
                      style={{
                        color: tokens.color.text,
                        fontSize: 11,
                        fontWeight: 800,
                        textTransform: 'uppercase',
                        letterSpacing: '0.06em',
                      }}
                    >
                      Project Brief
                    </div>
                    <div style={{ color: tokens.color.textDim, fontSize: 10, marginTop: 2 }}>
                      Updated {new Date(doc.updatedAt).toLocaleString()}
                    </div>
                  </div>
                </div>
              )}

              {hasArtifact ? (
                <ArtifactRenderer
                  artifact={doc.fields.artifact}
                  status={doc.status}
                  onSaveArtifact={saveArtifactRevision}
                  onAskAgent={askAgentToModifyArtifact}
                  onApprove={
                    doc.status === 'proposed' ? () => setProposalStatus('approved') : undefined
                  }
                  onReject={
                    doc.status === 'proposed' ? () => setProposalStatus('rejected') : undefined
                  }
                />
              ) : isSource ? (
                <>
                  <div
                    style={{
                      color: content ? tokens.color.textMuted : tokens.color.textDim,
                      fontSize: 12,
                      lineHeight: 1.55,
                      maxHeight: 96,
                      overflow: 'hidden',
                      whiteSpace: 'pre-wrap',
                    }}
                  >
                    {content ? content.slice(0, 280) : 'No project brief has been provided yet.'}
                    {content.length > 280 ? '…' : ''}
                  </div>
                  {canEdit && (
                    <div style={{ display: 'flex', gap: 7, marginTop: 10 }}>
                      <button
                        className="nodrag nopan"
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation()
                          openProjectBrief()
                        }}
                        style={{ ...nodeActionStyle, flex: 1, marginTop: 0 }}
                      >
                        <FileText size={13} aria-hidden="true" /> Open brief
                      </button>
                      <button
                        className="nodrag nopan"
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation()
                          askPmToRefine()
                        }}
                        style={{
                          ...nodeActionStyle,
                          flex: 1,
                          marginTop: 0,
                          background: tokens.color.surface,
                        }}
                      >
                        <Sparkles size={13} aria-hidden="true" /> Ask PM
                      </button>
                    </div>
                  )}
                </>
              ) : isEditableSpec ? (
                <div
                  style={{
                    width: '100%',
                    minHeight: 150,
                    padding: 12,
                    whiteSpace: 'pre-wrap',
                    background: tokens.color.bg,
                    color: content ? tokens.color.text : tokens.color.textDim,
                    border: `2px solid ${tokens.color.black}`,
                    borderRadius: tokens.radius.md,
                    fontFamily: tokens.font.mono,
                    fontSize: 12,
                    lineHeight: 1.6,
                  }}
                >
                  {content || 'No specification content has been provided.'}
                </div>
              ) : (
                <div
                  style={{
                    color: content ? tokens.color.textMuted : tokens.color.textDim,
                    fontSize: 12,
                    lineHeight: 1.5,
                    maxHeight: showPreview ? 300 : 84,
                    overflow: showPreview ? 'auto' : 'hidden',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {content ? content.slice(0, showPreview ? 5000 : 220) : 'No content'}
                  {!showPreview && content.length > 220 ? '…' : ''}
                </div>
              )}

              {/* Toggle preview */}
              {!isSource && content.length > 220 && (
                <button
                  className="nodrag"
                  type="button"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation()
                    setShowPreview(!showPreview)
                  }}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: tokens.color.accent,
                    fontSize: 11,
                    cursor: 'pointer',
                    padding: '6px 0 0',
                    fontFamily: tokens.font.mono,
                  }}
                >
                  {showPreview ? (
                    <>
                      <ChevronUp size={12} aria-hidden="true" /> Show less
                    </>
                  ) : (
                    <>
                      <ChevronDown size={12} aria-hidden="true" /> Read full specification
                    </>
                  )}
                </button>
              )}
            </div>

            {/* Node footer with actions */}
            {isOutput && canEdit && !isSource && (
              <div
                className="nodrag nopan nowheel"
                onPointerDownCapture={(event) => event.stopPropagation()}
                onMouseDownCapture={(event) => event.stopPropagation()}
                style={{
                  display: 'flex',
                  gap: 4,
                  padding: '6px 12px',
                  borderTop: `1px solid ${tokens.color.border}`,
                }}
              >
                {doc.status === 'proposed' && (
                  <>
                    <button
                      type="button"
                      className="nodrag nopan nowheel"
                      onClick={(event) => {
                        event.stopPropagation()
                        setProposalStatus('approved')
                      }}
                      style={{ ...nodeActionStyle, flex: 1, marginTop: 0 }}
                    >
                      <Check size={13} aria-hidden="true" /> Approve
                    </button>
                    <button
                      type="button"
                      className="nodrag nopan nowheel"
                      onClick={(event) => {
                        event.stopPropagation()
                        setProposalStatus('rejected')
                      }}
                      style={{
                        ...nodeActionStyle,
                        flex: 1,
                        marginTop: 0,
                        background: tokens.color.surface,
                        color: tokens.color.text,
                      }}
                    >
                      <CircleX size={13} aria-hidden="true" /> Reject
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className="nodrag nopan nowheel"
                  onClick={(e) => {
                    e.stopPropagation()
                    handleRetry()
                  }}
                  disabled={isGenerating}
                  style={{
                    flex: doc.status === 'proposed' ? 0 : 1,
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
                  {isGenerating ? '\u{23F3} Generating...' : 'Retry'}
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
                Project brief
              </div>
            )}
          </div>
        )
      },
    }),
    [canEdit, askPmToRefine, openProjectBrief, peerId, retryAgentNode, reviewAgentNode, upsertNode],
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
        createdBy: peerId,
        updatedAt: Date.now(),
      }
      addEdge(edge)
    },
    [addEdge, peerId, projectId],
  )

  return (
    <div className="app-layout">
      {/* Sidebar — collapsible */}
      <nav className="sidebar" style={{ width: sidebarCollapsed ? 48 : 330 }}>
        <div
          className="sidebar-brand"
          style={{ justifyContent: sidebarCollapsed ? 'center' : 'flex-start' }}
        >
          {!sidebarCollapsed && (
            <>
              <img className="papyrus-logo" src="/papyrus-logo.svg" alt="" />
              <span className="name">PAPYRUS</span>
            </>
          )}
          {sidebarCollapsed && (
            <img className="papyrus-logo" src="/papyrus-logo.svg" alt="Papyrus" />
          )}
        </div>
        {!sidebarCollapsed && (
          <div className="project-brief-panel">
            <div className="project-brief-heading">
              <button type="button" className="project-brief-back" onClick={onBack}>
                <ArrowLeft size={15} aria-hidden="true" /> Back
              </button>
              <div className="project-brief-eyebrow">
                <FileText size={13} aria-hidden="true" /> Project brief
              </div>
              <h1>{projectName}</h1>
              <p>The shared context used by every agent working on this canvas.</p>
            </div>
            <textarea
              ref={briefEditorRef}
              className="project-brief-editor"
              aria-label="Project brief"
              value={briefDraft}
              readOnly={!canEdit || !sourceNode}
              onFocus={() => setBriefEditing(true)}
              onBlur={() => setBriefEditing(false)}
              onChange={(event) => setBriefDraft(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault()
                  saveProjectBrief()
                }
              }}
              placeholder="Describe what you are building, who it serves, the problem it solves, constraints, and desired outcomes…"
            />
            <div className="project-brief-meta">
              <span>{briefDirty ? 'Unsaved changes' : 'Saved'}</span>
              {sourceNode && <span>Updated {new Date(sourceNode.updatedAt).toLocaleString()}</span>}
            </div>
            {canEdit && (
              <div className="project-brief-actions">
                <button
                  type="button"
                  className="project-brief-save"
                  disabled={!sourceNode || !briefDirty}
                  onClick={saveProjectBrief}
                >
                  <Save size={14} aria-hidden="true" /> Save brief
                </button>
                <button type="button" className="project-brief-refine" onClick={askPmToRefine}>
                  <Sparkles size={14} aria-hidden="true" /> Ask PM to refine
                </button>
              </div>
            )}
          </div>
        )}
        <div className="sidebar-footer">
          {!sidebarCollapsed && (
            <>
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
                {syncStatus === 'synced'
                  ? 'Synced'
                  : syncStatus === 'conflict'
                    ? 'Conflict'
                    : pendingOperations > 0
                      ? `${pendingOperations} pending`
                      : connected
                        ? 'Syncing'
                        : 'Offline'}
              </div>
            </>
          )}
          {/* Collapse toggle */}
          <button
            type="button"
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            style={{
              marginTop: 8,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 7,
              background: tokens.color.surface,
              border: `2px solid ${tokens.color.black}`,
              borderRadius: tokens.radius.md,
              boxShadow: '3px 3px 0 #111',
              color: tokens.color.text,
              padding: sidebarCollapsed ? '8px' : '7px 10px',
              fontSize: 11,
              cursor: 'pointer',
              width: '100%',
            }}
          >
            {sidebarCollapsed ? (
              <PanelLeftOpen size={16} aria-label="Expand sidebar" />
            ) : (
              <>
                <PanelLeftClose size={16} aria-hidden="true" /> Collapse sidebar
              </>
            )}
          </button>
        </div>
      </nav>

      {/* Agent chat panel */}
      {canEdit && (
        <AgentChat
          personas={PERSONA_LIST}
          projectId={projectId}
          peerId={peerId}
          canvasContext={agentCanvasContext}
          parentNodeIds={agentParentNodeIds}
          composerDraft={agentComposerDraft}
          onReviewNode={reviewAgentNode}
          onRetryNode={retryAgentNode}
          onFocusNode={focusAgentNode}
        />
      )}

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
          onSelectionChange={({ nodes: selectedNodes }) =>
            setSelectedNodeIds(selectedNodes.map((node) => node.id))
          }
          onInit={setRfInstance}
          nodeTypes={nodeTypes}
          nodesDraggable
          selectNodesOnDrag
          nodeDragThreshold={1}
          panOnDrag={[1, 2]}
          noDragClassName="nodrag"
          noPanClassName="nopan"
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
    </div>
  )
}
