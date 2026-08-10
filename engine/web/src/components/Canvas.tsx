import {
  Background,
  Controls,
  type Edge,
  MiniMap,
  type Node,
  ReactFlow,
  type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { tokens } from '@papyrus/core/design'
import type { CanvasNodeDoc, EdgeDoc } from '@papyrus/core/nodes/types'
import gsap from 'gsap'
import {
  ArrowLeft,
  BriefcaseBusiness,
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
import { useCanvas } from '../hooks/useCanvas'
import { AgentChat } from './AgentChat'
import {
  type AgentComposerDraft,
  CanvasNode,
  type CanvasNodeActions,
  CanvasNodeActionsContext,
} from './CanvasNode'
import { TaskList } from './TaskList'

// Module-scope nodeTypes — stable reference forever. React Flow treats a new
// nodeTypes object (or a new component inside it) as a brand-new node type and
// remounts every node, which kills drags. The CanvasNode component reads its
// mutable parent state through CanvasNodeActionsContext, so neither the
// nodeTypes object nor the CanvasNode reference ever needs to change.
const nodeTypes = { canvasNode: CanvasNode }

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

interface CanvasProps {
  projectId: string
  projectName: string
  onBack: () => void
}

export function Canvas({ projectId, projectName, onBack }: CanvasProps) {
  const { apiFetch, loadProjectRole, clearProjectRole, projectRole, user } = useAuth()
  const peerId = user?.memberKey ?? 'anonymous'
  const {
    nodes,
    edges,
    loading,
    saving,
    refresh,
    persistNodePosition,
    upsertNode,
    deleteNode,
    addEdge,
    deleteEdge,
    onNodesChange,
    onEdgesChange,
  } = useCanvas(projectId, apiFetch)
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
    upsertNode({
      ...sourceNode,
      fields: { ...sourceNode.fields, content: briefDraft },
      updatedAt: Date.now(),
    })
  }, [briefDirty, briefDraft, sourceNode, upsertNode])

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

  const rfNodes: Node[] = useMemo(
    () =>
      nodes.map((doc) => ({
        id: doc.id,
        type: 'canvasNode',
        position: doc.position,
        dragHandle: '.canvas-node-drag-handle',
        draggable: true,
        selectable: true,
        data: doc as unknown as Record<string, unknown>,
      })),
    [nodes],
  )

  const repairedArtifactEdgesRef = useRef(new Set<string>())
  useEffect(() => {
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
  }, [addEdge, edges, nodes, peerId, projectId])

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
      await refresh()
    },
    [apiFetch, nodes, projectId, refresh],
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

  const canvasNodeActions = useMemo<CanvasNodeActions>(
    () => ({
      canEdit,
      peerId,
      upsertNode,
      retryAgentNode,
      reviewAgentNode,
      openProjectBrief,
      askPmToRefine,
      setAgentComposerDraft,
    }),
    [askPmToRefine, canEdit, openProjectBrief, peerId, retryAgentNode, reviewAgentNode, upsertNode],
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
          {!sidebarCollapsed && projectRole && (
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
          {!sidebarCollapsed && (
            <div className="conn-status" aria-live="polite">
              <span className={`conn-dot ${saving ? 'saving' : 'live'}`} aria-hidden="true" />
              {saving ? 'Saving…' : 'Synced'}
            </div>
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
          onCanvasChanged={refresh}
        />
      )}

      {/* Canvas */}
      <CanvasNodeActionsContext.Provider value={canvasNodeActions}>
        <div className="canvas-area">
          {!loading && nodes.length === 0 && (
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
            onNodeDragStop={(_event, node) => persistNodePosition(node.id, node.position)}
            onNodesDelete={(deletedNodes) => {
              for (const node of deletedNodes) deleteNode(node.id)
            }}
            onEdgesChange={onEdgesChange}
            onEdgesDelete={(deletedEdges) => {
              for (const edge of deletedEdges) deleteEdge(edge.id)
            }}
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

          {/* Task List */}
          <TaskList projectId={projectId} />
        </div>
      </CanvasNodeActionsContext.Provider>
    </div>
  )
}
