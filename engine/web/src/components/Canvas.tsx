import type { ArtifactEnvelope } from '@papyrus/core/artifacts/envelope'
import { tokens } from '@papyrus/core/design'
import type { CanvasNodeDoc } from '@papyrus/core/nodes/types'
import {
  ArrowLeft,
  Check,
  Clipboard,
  Code2,
  Copy,
  FileText,
  Maximize2,
  Minimize2,
  Network,
  Palette,
  Pencil,
  RefreshCw,
  Save,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useCanvas } from '../hooks/useCanvas'
import { AgentChat } from './AgentChat'
import { ArtifactRenderer } from './ArtifactRenderer'

const PERSONA_LIST = [
  {
    id: 'pm',
    name: 'Product Manager',
    role: 'PM',
    color: tokens.color.persona.pm ?? '#ff5f1f',
    icon: Clipboard,
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

interface McpSessionInfo {
  sessionId: string
  url: string
}

function artifactTitle(node: CanvasNodeDoc): string {
  return String(node.fields.title ?? node.type)
}

function artifactPreview(node: CanvasNodeDoc): string {
  const content = String(node.fields.content ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return content.slice(0, 110) || 'No summary available.'
}

export function Canvas({ projectId, projectName, onBack }: CanvasProps) {
  const { apiFetch, loadProjectRole, clearProjectRole, projectRole, user } = useAuth()
  const peerId = user?.memberKey ?? 'anonymous'
  const { nodes, loading, saving, refresh, upsertNode } = useCanvas(projectId, apiFetch)
  const [selectedNodeId, setSelectedNodeId] = useState<string>()
  const [briefDraft, setBriefDraft] = useState('')
  const [briefOpen, setBriefOpen] = useState(false)
  const [workspaceExpanded, setWorkspaceExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const [mcpSession, setMcpSession] = useState<McpSessionInfo>()
  const [agentComposerDraft, setAgentComposerDraft] = useState<{
    id: number
    text: string
    targetNodeId?: string
  }>()
  const briefEditorRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    loadProjectRole(projectId)
    return () => clearProjectRole()
  }, [projectId, loadProjectRole, clearProjectRole])

  useEffect(() => {
    let cancelled = false
    void apiFetch(`/api/mcp/session?projectId=${encodeURIComponent(projectId)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error('Unable to create MCP session')
        return response.json() as Promise<McpSessionInfo>
      })
      .then((session) => {
        if (!cancelled) setMcpSession(session)
      })
      .catch((error) => console.error('MCP session load failed', error))
    return () => {
      cancelled = true
    }
  }, [apiFetch, projectId])

  const canEdit = projectRole === 'owner' || projectRole === 'editor' || projectRole === null
  const sourceNode = useMemo(() => nodes.find((node) => node.flowRole === 'source'), [nodes])
  const sourceContent = String(sourceNode?.fields.content ?? '')
  const artifacts = useMemo(
    () =>
      nodes.filter((node) => node.flowRole !== 'source').sort((a, b) => b.updatedAt - a.updatedAt),
    [nodes],
  )
  const selectedNode = useMemo(
    () => artifacts.find((node) => node.id === selectedNodeId) ?? artifacts[0],
    [artifacts, selectedNodeId],
  )

  useEffect(() => {
    if (selectedNode && selectedNode.id !== selectedNodeId) setSelectedNodeId(selectedNode.id)
  }, [selectedNode, selectedNodeId])

  useEffect(() => {
    if (!briefOpen) setBriefDraft(sourceContent)
  }, [briefOpen, sourceContent])

  useEffect(() => {
    if (briefOpen) requestAnimationFrame(() => briefEditorRef.current?.focus())
  }, [briefOpen])

  const agentContext = useMemo(
    () =>
      nodes
        .map((node) => {
          const title = artifactTitle(node)
          const content = String(node.fields.content ?? '')
          return `### ${title} [${node.type}; id=${node.id}]\n${content}`
        })
        .join('\n\n'),
    [nodes],
  )

  const reviewArtifact = useCallback(
    (nodeId: string, status: 'approved' | 'rejected') => {
      const node = nodes.find((candidate) => candidate.id === nodeId)
      if (!node) return
      upsertNode({
        ...node,
        flowRole: status === 'approved' ? 'artifact' : 'review',
        status,
        fields: {
          ...node.fields,
          reviewedBy: peerId,
          reviewedAt: new Date().toISOString(),
        },
        updatedAt: Date.now(),
      })
    },
    [nodes, peerId, upsertNode],
  )

  const retryArtifact = useCallback(
    async (nodeId: string) => {
      const node = nodes.find((candidate) => candidate.id === nodeId)
      const response = await apiFetch('/api/retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nodeId,
          projectId,
          persona: String(node?.fields.requestedPersona ?? 'pm'),
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

  const saveBrief = useCallback(() => {
    if (!sourceNode || briefDraft === sourceContent) return
    upsertNode({
      ...sourceNode,
      fields: { ...sourceNode.fields, content: briefDraft },
      updatedAt: Date.now(),
    })
    setBriefOpen(false)
  }, [briefDraft, sourceContent, sourceNode, upsertNode])

  const saveArtifact = useCallback(
    (artifact: ArtifactEnvelope) => {
      if (!selectedNode) return
      upsertNode({
        ...selectedNode,
        fields: { ...selectedNode.fields, artifact },
        updatedAt: Date.now(),
      })
    },
    [selectedNode, upsertNode],
  )

  const askAgentAboutArtifact = useCallback(() => {
    if (!selectedNode) return
    setAgentComposerDraft({
      id: Date.now(),
      text: `Review and improve "${artifactTitle(selectedNode)}".`,
      targetNodeId: selectedNode.id,
    })
  }, [selectedNode])

  async function copyMcpUrl() {
    if (!mcpSession?.url) return
    await navigator.clipboard.writeText(mcpSession.url)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1800)
  }

  return (
    <div className="agent-workspace-layout">
      <aside className="agent-workspace-sidebar">
        <header className="agent-workspace-brand">
          <div className="agent-workspace-brand-row">
            <img className="papyrus-logo" src="/papyrus-logo.svg" alt="" />
            <span>PAPYRUS</span>
            <button type="button" className="workspace-icon-button" onClick={onBack}>
              <ArrowLeft size={16} aria-hidden="true" /> Projects
            </button>
          </div>
          <div className="agent-project-heading">
            <span>Active project</span>
            <strong>{projectName}</strong>
          </div>
        </header>

        {canEdit ? (
          <AgentChat
            personas={PERSONA_LIST}
            projectId={projectId}
            peerId={peerId}
            canvasContext={agentContext}
            parentNodeIds={sourceNode ? [sourceNode.id] : []}
            composerDraft={agentComposerDraft}
            onReviewNode={reviewArtifact}
            onRetryNode={retryArtifact}
            onOpenArtifact={setSelectedNodeId}
            onCanvasChanged={refresh}
          />
        ) : (
          <div className="workspace-readonly">You have read-only access to this project.</div>
        )}

        <footer className="agent-workspace-status">
          <span className={`conn-dot ${saving ? 'saving' : 'live'}`} aria-hidden="true" />
          {saving ? 'Saving…' : 'Synced'}
          {projectRole && <span className="workspace-role">{projectRole}</span>}
        </footer>
      </aside>

      <main className={`artifact-workspace ${workspaceExpanded ? 'expanded' : ''}`}>
        <header className="artifact-workspace-header">
          <div>
            <span className="artifact-workspace-eyebrow">Project workspace</span>
            <h1>Artifacts</h1>
          </div>
          <div className="artifact-workspace-header-actions">
            <button type="button" className="workspace-control" onClick={() => setBriefOpen(true)}>
              <Pencil size={14} aria-hidden="true" /> Edit brief
            </button>
            <div className="mcp-connection" title={mcpSession?.url ?? 'Preparing MCP session'}>
              <Network size={15} aria-hidden="true" />
              <span>
                <small>MCP session</small>
                <strong>{mcpSession ? 'Ready to connect' : 'Preparing…'}</strong>
              </span>
              <button
                type="button"
                onClick={() => void copyMcpUrl()}
                disabled={!mcpSession}
                aria-label="Copy MCP session URL"
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>
            <button
              type="button"
              className="workspace-control icon-only"
              onClick={() => setWorkspaceExpanded((value) => !value)}
              aria-label={workspaceExpanded ? 'Exit fullscreen workspace' : 'Expand workspace'}
            >
              {workspaceExpanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
          </div>
        </header>

        <div className="artifact-workspace-body">
          <nav className="artifact-index" aria-label="Project artifacts">
            <div className="artifact-index-heading">
              <span>{artifacts.length} artifacts</span>
              <button type="button" onClick={() => void refresh()} aria-label="Refresh artifacts">
                <RefreshCw size={13} />
              </button>
            </div>
            {loading ? (
              <div className="artifact-index-empty">Loading artifacts…</div>
            ) : artifacts.length === 0 ? (
              <div className="artifact-index-empty">
                Ask Papyrus to create a requirement, design, implementation, or review.
              </div>
            ) : (
              artifacts.map((node) => (
                <button
                  key={node.id}
                  type="button"
                  className={`artifact-index-item ${selectedNode?.id === node.id ? 'active' : ''}`}
                  onClick={() => setSelectedNodeId(node.id)}
                >
                  <span className="artifact-index-type">{node.type}</span>
                  <strong>{artifactTitle(node)}</strong>
                  <p>{artifactPreview(node)}</p>
                  <span className={`artifact-status ${node.status}`}>{node.status}</span>
                </button>
              ))
            )}
          </nav>

          <section className="artifact-detail">
            {selectedNode ? (
              <>
                <header className="artifact-detail-header">
                  <div>
                    <span>{selectedNode.type}</span>
                    <h2>{artifactTitle(selectedNode)}</h2>
                    <p>
                      Updated {new Date(selectedNode.updatedAt).toLocaleString()} ·{' '}
                      {selectedNode.status}
                    </p>
                  </div>
                  <div className="artifact-detail-actions">
                    <button type="button" onClick={askAgentAboutArtifact}>
                      <Sparkles size={14} /> Ask agent
                    </button>
                    <button type="button" onClick={() => void retryArtifact(selectedNode.id)}>
                      <RefreshCw size={14} /> Retry
                    </button>
                    {selectedNode.status === 'proposed' && (
                      <>
                        <button
                          type="button"
                          onClick={() => reviewArtifact(selectedNode.id, 'approved')}
                        >
                          <Check size={14} /> Approve
                        </button>
                        <button
                          type="button"
                          onClick={() => reviewArtifact(selectedNode.id, 'rejected')}
                        >
                          <X size={14} /> Reject
                        </button>
                      </>
                    )}
                  </div>
                </header>
                <div className="artifact-detail-content">
                  {selectedNode.fields.artifact ? (
                    <ArtifactRenderer
                      artifact={selectedNode.fields.artifact}
                      status={selectedNode.status}
                      onSaveArtifact={saveArtifact}
                      onAskAgent={askAgentAboutArtifact}
                      onApprove={() => reviewArtifact(selectedNode.id, 'approved')}
                      onReject={() => reviewArtifact(selectedNode.id, 'rejected')}
                    />
                  ) : (
                    <pre>{String(selectedNode.fields.content ?? '')}</pre>
                  )}
                </div>
              </>
            ) : (
              <div className="artifact-detail-empty">
                <FileText size={28} aria-hidden="true" />
                <h2>Your agent’s work will appear here</h2>
                <p>
                  Ask for an outcome. Papyrus will choose the specialist and create a typed
                  artifact.
                </p>
              </div>
            )}
          </section>
        </div>
      </main>

      {briefOpen && (
        <dialog open className="brief-dialog" aria-label="Edit project brief">
          <div className="brief-dialog-card">
            <header>
              <div>
                <span>Shared agent context</span>
                <h2>Project brief</h2>
              </div>
              <button
                type="button"
                onClick={() => setBriefOpen(false)}
                aria-label="Close brief editor"
              >
                <X size={17} />
              </button>
            </header>
            <p>
              This context is supplied to every specialist. Keep it focused on the problem, users,
              constraints, and desired outcome.
            </p>
            <textarea
              ref={briefEditorRef}
              value={briefDraft}
              onChange={(event) => setBriefDraft(event.target.value)}
              readOnly={!canEdit || !sourceNode}
            />
            <footer>
              <span>{briefDraft === sourceContent ? 'No unsaved changes' : 'Unsaved changes'}</span>
              <button type="button" onClick={() => setBriefOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                disabled={!sourceNode || briefDraft === sourceContent}
                onClick={saveBrief}
              >
                <Save size={14} /> Save brief
              </button>
            </footer>
          </div>
        </dialog>
      )}
    </div>
  )
}
