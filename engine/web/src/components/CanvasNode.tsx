/**
 * CanvasNode — the custom React Flow node component for the Papyrus canvas.
 *
 * Extracted to its own module so `nodeTypes` can hold a STABLE reference to it
 * (defined at module scope in Canvas.tsx). React Flow treats a new
 * `nodeTypes.canvasNode` reference as a brand new node type and remounts every
 * node, which kills drags and re-focuses state mid-interaction. Defining the
 * component at module scope — and reading mutable parent state through a
 * Context — avoids that entire class of bugs.
 */
import {
  type ArtifactEnvelope,
  isArtifactEnvelope,
  unwrapUswdsArtifact,
} from '@papyrus/core/artifacts/envelope'
import { tokens } from '@papyrus/core/design'
import type { CanvasNodeDoc } from '@papyrus/core/nodes/types'
import { Handle, type NodeProps, Position } from '@xyflow/react'
import { Check, ChevronDown, ChevronUp, CircleX, FileText, Sparkles } from 'lucide-react'
import { createContext, useContext, useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import { ArtifactRenderer } from './ArtifactRenderer'

export interface AgentComposerDraft {
  id: number
  text: string
  targetNodeId?: string
}

/**
 * Actions and parent state that CanvasNode needs. Provided by Canvas via
 * <CanvasNodeActionsContext.Provider>. Reading these through context (rather
 * than closing over them inside an inline component) keeps this component's
 * reference stable forever.
 */
export interface CanvasNodeActions {
  canEdit: boolean
  peerId: string
  upsertNode: (doc: CanvasNodeDoc) => void
  retryAgentNode: (nodeId: string) => Promise<void>
  reviewAgentNode: (nodeId: string, status: 'approved' | 'rejected') => void
  openProjectBrief: () => void
  askPmToRefine: () => void
  setAgentComposerDraft: Dispatch<SetStateAction<AgentComposerDraft | undefined>>
}

export const CanvasNodeActionsContext = createContext<CanvasNodeActions | null>(null)

const NODE_ICONS: Record<string, string> = {
  specification: '\u{1F4C4}',
  'user-story': '\u{1F4DD}',
  'success-metric': '\u{1F3AF}',
  'ui-mockup': '\u{1F3A8}',
  application: '\u{1F4BB}',
  'mcp-server': '\u{1F5C3}\u{FE0F}',
  'skill-creator': '\u{1F9E9}',
  api: '\u{1F527}',
  dataset: '\u{1F4CA}',
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

export function CanvasNode({ data, selected }: NodeProps) {
  const actions = useContext(CanvasNodeActionsContext)
  if (!actions) {
    throw new Error('CanvasNode must be rendered inside <CanvasNodeActionsContext.Provider>')
  }
  const {
    canEdit,
    peerId,
    upsertNode,
    retryAgentNode,
    reviewAgentNode,
    openProjectBrief,
    askPmToRefine,
    setAgentComposerDraft,
  } = actions

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
}
