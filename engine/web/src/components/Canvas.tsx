import type { ArtifactEnvelope } from '@papyrus/core/artifacts/envelope'
import { tokens } from '@papyrus/core/design'
import {
  ArrowLeft,
  Check,
  Clipboard,
  Code2,
  Copy,
  Network,
  Palette,
  Pencil,
  Save,
  ShieldCheck,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useCanvas } from '../hooks/useCanvas'
import { AgentChat } from './AgentChat'

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

export function Canvas({ projectId, projectName, onBack }: CanvasProps) {
  const { apiFetch, loadProjectRole, clearProjectRole, projectRole, user } = useAuth()
  const peerId = user?.memberKey ?? 'anonymous'
  const { nodes, saving, refresh, upsertNode } = useCanvas(projectId, apiFetch)
  const [briefDraft, setBriefDraft] = useState('')
  const [briefOpen, setBriefOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [mcpSession, setMcpSession] = useState<McpSessionInfo>()
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
          const title = String(node.fields.title ?? node.type)
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

  const saveArtifact = useCallback(
    (nodeId: string, artifact: ArtifactEnvelope) => {
      const node = nodes.find((candidate) => candidate.id === nodeId)
      if (!node) return
      upsertNode({
        ...node,
        fields: { ...node.fields, artifact },
        updatedAt: Date.now(),
      })
    },
    [nodes, upsertNode],
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

  async function copyMcpUrl() {
    if (!mcpSession?.url) return
    await navigator.clipboard.writeText(mcpSession.url)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1800)
  }

  return (
    <div className="agent-thread-layout">
      <header className="agent-thread-topbar">
        <div className="agent-thread-brand">
          <img className="papyrus-logo" src="/papyrus-logo.svg" alt="" />
          <strong>PAPYRUS</strong>
        </div>
        <button type="button" className="workspace-icon-button" onClick={onBack}>
          <ArrowLeft size={15} aria-hidden="true" /> Projects
        </button>
        <div className="agent-thread-project">
          <span>Project</span>
          <strong>{projectName}</strong>
        </div>
        <div className="agent-thread-actions">
          <button type="button" className="workspace-control" onClick={() => setBriefOpen(true)}>
            <Pencil size={14} aria-hidden="true" /> Brief
          </button>
          <button
            type="button"
            className="mcp-inline-control"
            onClick={() => void copyMcpUrl()}
            disabled={!mcpSession}
            title={mcpSession?.url ?? 'Preparing MCP session'}
          >
            <Network size={14} aria-hidden="true" />
            <span>{mcpSession ? 'Connect MCP' : 'Preparing MCP'}</span>
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
          <span className="agent-thread-sync">
            <i className={`conn-dot ${saving ? 'saving' : 'live'}`} />
            {saving ? 'Saving…' : 'Saved'}
          </span>
        </div>
      </header>

      <main className="agent-thread-main">
        {canEdit ? (
          <AgentChat
            personas={PERSONA_LIST}
            projectId={projectId}
            peerId={peerId}
            canvasContext={agentContext}
            parentNodeIds={sourceNode ? [sourceNode.id] : []}
            onReviewNode={reviewArtifact}
            onRetryNode={retryArtifact}
            onSaveArtifact={saveArtifact}
            onCanvasChanged={refresh}
          />
        ) : (
          <div className="workspace-readonly">You have read-only access to this project.</div>
        )}
      </main>

      {briefOpen && (
        <dialog open className="brief-dialog" aria-label="Edit project brief">
          <div className="brief-dialog-card">
            <header>
              <div>
                <span>Shared agent context</span>
                <h2>Project brief</h2>
              </div>
              <button type="button" onClick={() => setBriefOpen(false)} aria-label="Close editor">
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
