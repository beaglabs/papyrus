import { ArrowLeft, FileCode2, Pencil, Save } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useCanvas } from '../hooks/useCanvas'
import { ChatPanel } from './ChatPanel'
import { PreviewPanel } from './PreviewPanel'
import { ProfileBadge } from './ProfileBadge'

interface DevEnvironmentProps {
  projectId: string
  projectName: string
  onBack: () => void
}

export interface GeneratedFile {
  path: string
  content: string
  language?: string
}

export interface Generation {
  id: string
  prompt: string
  files: GeneratedFile[]
  status: 'proposed' | 'approved' | 'rejected'
  createdAt: string
  template?: string
}

export interface BuildValidation {
  generationId: string
  status: 'building' | 'failed' | 'ready'
  error?: string
}

export function DevEnvironment({ projectId, projectName, onBack }: DevEnvironmentProps) {
  const { apiFetch, user } = useAuth()
  const peerId = user?.memberKey ?? 'anonymous'
  const { nodes, saving, refresh, upsertNode } = useCanvas(projectId, apiFetch)
  const [generations, setGenerations] = useState<Generation[]>([])
  const [activeGeneration, setActiveGeneration] = useState<Generation | null>(null)
  const [loading, setLoading] = useState(false)
  const [buildValidation, setBuildValidation] = useState<BuildValidation | null>(null)
  const [briefOpen, setBriefOpen] = useState(false)
  const [briefDraft, setBriefDraft] = useState('')
  const briefEditorRef = useRef<HTMLTextAreaElement>(null)

  const sourceNode = useMemo(() => nodes.find((node) => node.flowRole === 'source'), [nodes])
  const sourceContent = String(sourceNode?.fields.content ?? '')

  useEffect(() => {
    if (!briefOpen) setBriefDraft(sourceContent)
  }, [briefOpen, sourceContent])

  useEffect(() => {
    if (briefOpen) requestAnimationFrame(() => briefEditorRef.current?.focus())
  }, [briefOpen])

  // Load existing generations from canvas nodes
  useEffect(() => {
    const codeNodes = nodes.filter(
      (node) =>
        node.type === 'application' ||
        node.type === 'source-code' ||
        (node.fields.artifact as { renderer?: { type?: string } })?.renderer?.type === 'code',
    )
    if (codeNodes.length === 0) return

    const loaded: Generation[] = codeNodes.map((node) => {
      const artifact = node.fields.artifact as {
        files?: Array<{ path: string; content: string; language?: string }>
        renderer?: { type?: string }
      }
      return {
        id: node.id,
        prompt: String(node.fields.content ?? ''),
        files: artifact?.files ?? [],
        status: node.status as Generation['status'],
        createdAt: new Date(node.updatedAt).toISOString(),
      }
    })
    setGenerations(loaded)
    if (!activeGeneration && loaded.length > 0) {
      const last = loaded[loaded.length - 1]
      if (last) setActiveGeneration(last)
    }
  }, [nodes])

  const handleGenerationComplete = useCallback(
    async (prompt: string, files: GeneratedFile[], template?: string) => {
      const genId = `gen-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      const generation: Generation = {
        id: genId,
        prompt,
        files,
        status: 'proposed',
        createdAt: new Date().toISOString(),
        template,
      }

      setGenerations((prev) => [...prev, generation])
      setActiveGeneration(generation)

      // Persist to canvas
      const nodeDoc = {
        id: genId,
        projectId,
        type: 'application',
        category: 'output' as const,
        flowRole: 'review' as const,
        position: { x: 340, y: 140 },
        fields: {
          title: prompt.slice(0, 80),
          content: prompt,
          artifact: {
            schema: 'papyrus.artifact/v1' as const,
            kind: 'application',
            title: prompt.slice(0, 80),
            renderer: { type: 'code' as const },
            files: files.map((f) => ({
              path: f.path,
              content: f.content,
              language: f.language,
            })),
            producer: { persona: 'engineer' },
          },
          requestedPersona: 'engineer',
        },
        status: 'proposed' as const,
        createdBy: `agent:engineer`,
        updatedAt: Date.now(),
      }

      upsertNode(nodeDoc as any)
      return genId
    },
    [projectId, upsertNode],
  )

  const handleApprove = useCallback(
    (generationId: string) => {
      setGenerations((prev) =>
        prev.map((gen) => (gen.id === generationId ? { ...gen, status: 'approved' } : gen)),
      )
      const node = nodes.find((n) => n.id === generationId)
      if (node) {
        upsertNode({
          ...node,
          flowRole: 'artifact',
          status: 'approved',
          fields: {
            ...node.fields,
            reviewedBy: peerId,
            reviewedAt: new Date().toISOString(),
          },
          updatedAt: Date.now(),
        })
      }
    },
    [nodes, peerId, upsertNode],
  )

  const handleReject = useCallback(
    (generationId: string) => {
      setGenerations((prev) =>
        prev.map((gen) => (gen.id === generationId ? { ...gen, status: 'rejected' } : gen)),
      )
      const node = nodes.find((n) => n.id === generationId)
      if (node) {
        upsertNode({
          ...node,
          flowRole: 'review',
          status: 'rejected',
          fields: {
            ...node.fields,
            reviewedBy: peerId,
            reviewedAt: new Date().toISOString(),
          },
          updatedAt: Date.now(),
        })
      }
    },
    [nodes, peerId, upsertNode],
  )

  const handleFilesUpdate = useCallback(
    (generationId: string, files: GeneratedFile[]) => {
      setGenerations((prev) =>
        prev.map((gen) => (gen.id === generationId ? { ...gen, files } : gen)),
      )
      setActiveGeneration((prev) => (prev?.id === generationId ? { ...prev, files } : prev))
      // Persist updated files
      const node = nodes.find((n) => n.id === generationId)
      if (node) {
        const artifact = node.fields.artifact as {
          files?: unknown[]
          renderer?: unknown
          kind?: string
          title?: string
          schema?: string
          producer?: unknown
        }
        upsertNode({
          ...node,
          fields: {
            ...node.fields,
            artifact: {
              ...artifact,
              files: files.map((f) => ({
                path: f.path,
                content: f.content,
                language: f.language,
              })),
            },
          },
          updatedAt: Date.now(),
        })
      }
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

  return (
    <div className="dev-environment">
      {/* Top bar */}
      <header className="dev-topbar">
        <div className="dev-topbar-left">
          <button type="button" className="dev-back-btn" onClick={onBack}>
            <ArrowLeft size={15} /> Projects
          </button>
          <div className="dev-project-name">
            <FileCode2 size={15} />
            <span>{projectName}</span>
          </div>
        </div>
        <div className="dev-topbar-spacer" />
        <div className="dev-topbar-right">
          <button
            type="button"
            className="dev-icon-btn"
            onClick={() => setBriefOpen(true)}
            title="Edit project brief"
          >
            <Pencil size={14} />
          </button>
          <span className="dev-sync-status">
            <i className={`conn-dot ${saving ? 'saving' : 'live'}`} />
            {saving ? 'Saving...' : 'Saved'}
          </span>
          <ProfileBadge />
        </div>
      </header>

      {/* Main split layout */}
      <div className="dev-main">
        {/* Left panel - Chat */}
        <div className="dev-panel-left">
          <ChatPanel
            projectId={projectId}
            projectBrief={sourceContent}
            generations={generations}
            activeGeneration={activeGeneration}
            onGenerationComplete={handleGenerationComplete}
            onSelectGeneration={setActiveGeneration}
            onLoadingChange={setLoading}
            buildValidation={buildValidation}
          />
        </div>

        {/* Right panel - Preview / Code / Terminal */}
        <div className="dev-panel-right">
          <PreviewPanel
            generation={activeGeneration}
            loading={loading}
            onApprove={handleApprove}
            onReject={handleReject}
            onFilesUpdate={handleFilesUpdate}
            onBuildValidation={setBuildValidation}
          />
        </div>
      </div>

      {/* Brief editor dialog */}
      {briefOpen && (
        <dialog open className="brief-dialog" aria-label="Edit project brief">
          <div className="brief-dialog-card">
            <header>
              <div>
                <span>Agent context</span>
                <h2>Project brief</h2>
              </div>
              <button type="button" onClick={() => setBriefOpen(false)} aria-label="Close">
                &times;
              </button>
            </header>
            <p>
              This context is sent with every request. Keep it focused on the problem, users,
              constraints, and desired outcome.
            </p>
            <textarea
              ref={briefEditorRef}
              value={briefDraft}
              onChange={(event) => setBriefDraft(event.target.value)}
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
