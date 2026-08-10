import {
  SandpackCodeEditor,
  SandpackConsole,
  SandpackFileExplorer,
  SandpackLayout,
  type SandpackPredefinedTemplate,
  SandpackPreview,
  SandpackProvider,
  SandpackTests,
  useSandpack,
} from '@codesandbox/sandpack-react'
import {
  type ArtifactEnvelope,
  type ArtifactFile,
  isArtifactEnvelope,
  unwrapUswdsArtifact,
} from '@papyrus/core/artifacts/envelope'
import { tokens } from '@papyrus/core/design'
import { Check, Code2, Expand, Eye, FolderTree, RefreshCw, Save, Sparkles, X } from 'lucide-react'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { UswdsWireframePreview } from './UswdsWireframePreview'

interface ArtifactRendererProps {
  artifact: unknown
  compact?: boolean
  status?: string
  onSaveArtifact?: (artifact: ArtifactEnvelope) => void
  onAskAgent?: () => void
  onApprove?: () => void
  onReject?: () => void
}

function StructuredData({ value }: { value: unknown }) {
  return (
    <pre
      style={{
        margin: 0,
        maxHeight: 360,
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        fontFamily: tokens.font.mono,
        fontSize: 10,
        lineHeight: 1.5,
      }}
    >
      {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
    </pre>
  )
}

function OpenApiPreview({ value }: { value: unknown }) {
  const document = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const paths =
    document.paths && typeof document.paths === 'object'
      ? (document.paths as Record<string, unknown>)
      : {}
  const endpoints = Object.entries(paths).flatMap(([path, operations]) =>
    operations && typeof operations === 'object'
      ? Object.keys(operations)
          .filter((method) => ['get', 'post', 'put', 'patch', 'delete'].includes(method))
          .map((method) => ({ method, path }))
      : [],
  )
  if (!endpoints.length) return <StructuredData value={value} />
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {endpoints.map(({ method, path }) => (
        <div
          key={`${method}-${path}`}
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            border: `1px solid ${tokens.color.border}`,
            padding: '6px 8px',
          }}
        >
          <strong
            style={{ minWidth: 42, color: tokens.color.accent, fontFamily: tokens.font.mono }}
          >
            {method.toUpperCase()}
          </strong>
          <code>{path}</code>
        </div>
      ))}
    </div>
  )
}

function normalizedFiles(artifact: ArtifactEnvelope) {
  return Object.fromEntries(
    (artifact.files ?? []).map((file) => [
      file.path.startsWith('/') ? file.path : `/${file.path}`,
      { code: file.content },
    ]),
  )
}

function packageDependencies(artifact: ArtifactEnvelope): Record<string, string> {
  const packageFile = artifact.files?.find((file) => /(^|\/)package\.json$/.test(file.path))
  if (!packageFile) return {}
  try {
    const value = JSON.parse(packageFile.content) as { dependencies?: Record<string, string> }
    return value.dependencies ?? {}
  } catch {
    return {}
  }
}

export function detectSandpackTemplate(files: ArtifactFile[]): SandpackPredefinedTemplate {
  const paths = files.map((file) => file.path.toLowerCase())
  if (paths.some((path) => path.endsWith('.vue'))) return 'vue'
  if (paths.some((path) => path.endsWith('.svelte'))) return 'svelte'
  if (paths.some((path) => path.endsWith('.tsx'))) return 'react-ts'
  if (paths.some((path) => path.endsWith('.jsx'))) return 'react'
  if (paths.some((path) => path.endsWith('.ts'))) return 'vanilla-ts'
  if (paths.some((path) => path.endsWith('.html'))) return 'static'
  return 'vanilla'
}

function languageFor(path: string): string {
  return path.split('.').pop() || 'text'
}

function canonicalFiles(files: ArtifactFile[]): ArtifactFile[] {
  return files
    .map((file) => {
      const path = file.path.startsWith('/') ? file.path : `/${file.path}`
      return { path, content: file.content, language: languageFor(path) }
    })
    .sort((a, b) => a.path.localeCompare(b.path))
}

function filesFromSandpack(
  files: ReturnType<typeof useSandpack>['sandpack']['files'],
  artifactPaths: Set<string>,
): ArtifactFile[] {
  return canonicalFiles(
    Object.entries(files)
      .filter(([path]) => artifactPaths.has(path))
      .map(([path, file]) => ({ path, content: file.code })),
  )
}

function WorkspaceShell({
  artifact,
  onClose,
  onSaveArtifact,
  onAskAgent,
  onApprove,
  onReject,
}: {
  artifact: ArtifactEnvelope
  onClose: () => void
  onSaveArtifact?: (artifact: ArtifactEnvelope) => void
  onAskAgent?: () => void
  onApprove?: () => void
  onReject?: () => void
}) {
  const { sandpack } = useSandpack()
  const [toolPanel, setToolPanel] = useState<'closed' | 'console' | 'tests'>('closed')
  const artifactPaths = new Set(canonicalFiles(artifact.files ?? []).map((file) => file.path))
  const [lastSaved, setLastSaved] = useState(() =>
    JSON.stringify(canonicalFiles(artifact.files ?? [])),
  )
  const currentFiles = filesFromSandpack(sandpack.files, artifactPaths)
  const currentSnapshot = JSON.stringify(currentFiles)
  const dirty = currentSnapshot !== lastSaved
  const buildFailed = !!sandpack.error || sandpack.status === 'timeout'
  const hasTests = currentFiles.some((file) => /\.(test|spec)\.[jt]sx?$/.test(file.path))
  const statusLabel = buildFailed
    ? 'Build failed'
    : sandpack.status === 'running'
      ? 'Building'
      : dirty
        ? 'Unsaved changes'
        : 'Saved'

  function closeWorkspace() {
    if (dirty && !window.confirm('Discard unsaved workspace changes?')) return
    onClose()
  }

  function saveRevision() {
    const next: ArtifactEnvelope = {
      ...artifact,
      files: currentFiles,
      revision: {
        number: (artifact.revision?.number ?? 0) + 1,
        savedAt: new Date().toISOString(),
      },
    }
    onSaveArtifact?.(next)
    setLastSaved(currentSnapshot)
  }

  return (
    <dialog
      open
      aria-modal="true"
      aria-label={`${artifact.title} source workspace`}
      style={{
        position: 'fixed',
        inset: 0,
        width: '100vw',
        height: '100vh',
        maxWidth: 'none',
        maxHeight: 'none',
        margin: 0,
        padding: 0,
        border: 0,
        zIndex: 10000,
        background: '#fff',
        display: 'grid',
        gridTemplateRows: '58px minmax(0, 1fr)',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '0 18px',
          borderBottom: '2px solid #111',
          background: '#fff',
        }}
      >
        <Code2 size={18} aria-hidden="true" />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              fontWeight: 800,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {artifact.title}
          </div>
          <div
            style={{
              fontSize: 10,
              color: buildFailed ? '#b50909' : dirty ? '#9c3d10' : '#277022',
              fontFamily: tokens.font.mono,
            }}
          >
            {statusLabel} · revision {artifact.revision?.number ?? 0}
          </div>
        </div>
        <button
          type="button"
          className="skill-btn"
          onClick={() => setToolPanel((value) => (value === 'console' ? 'closed' : 'console'))}
        >
          Console
        </button>
        {hasTests && (
          <button
            type="button"
            className="skill-btn"
            onClick={() => setToolPanel((value) => (value === 'tests' ? 'closed' : 'tests'))}
          >
            Tests
          </button>
        )}
        <button type="button" className="skill-btn" onClick={onAskAgent}>
          <Sparkles size={13} /> Ask agent
        </button>
        <button
          type="button"
          className="skill-btn"
          disabled={!dirty}
          onClick={() => sandpack.resetAllFiles()}
        >
          <RefreshCw size={13} /> Revert
        </button>
        <button
          type="button"
          className="skill-btn"
          disabled={!dirty || !onSaveArtifact}
          onClick={saveRevision}
        >
          <Save size={13} /> Save revision
        </button>
        {onApprove && (
          <button type="button" className="skill-btn" onClick={onApprove}>
            <Check size={13} /> Approve
          </button>
        )}
        {onReject && (
          <button type="button" className="skill-btn" onClick={onReject}>
            Reject
          </button>
        )}
        <button
          type="button"
          className="skill-btn"
          onClick={closeWorkspace}
          aria-label="Close workspace"
        >
          <X size={15} />
        </button>
      </header>
      <main
        style={{
          minHeight: 0,
          display: 'grid',
          gridTemplateRows: toolPanel !== 'closed' ? 'minmax(0, 1fr) 220px' : 'minmax(0, 1fr)',
        }}
      >
        <SandpackLayout style={{ height: '100%', border: 0, borderRadius: 0 }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '220px minmax(0, 1fr)',
              minWidth: 0,
              height: '100%',
            }}
          >
            <SandpackFileExplorer style={{ borderRight: '1px solid #d6d7d9', height: '100%' }} />
            <SandpackCodeEditor
              showTabs
              showLineNumbers
              showInlineErrors
              closableTabs
              style={{ height: '100%' }}
            />
          </div>
          <SandpackPreview
            showNavigator
            showRefreshButton
            showOpenInCodeSandbox={false}
            style={{ height: '100%' }}
          />
        </SandpackLayout>
        {toolPanel === 'console' && (
          <SandpackConsole standalone style={{ height: 220, borderTop: '2px solid #111' }} />
        )}
        {toolPanel === 'tests' && (
          <SandpackTests style={{ height: 220, borderTop: '2px solid #111' }} />
        )}
      </main>
    </dialog>
  )
}

function InlineCodeArtifact({
  artifact,
  compact,
  status,
  ...actions
}: {
  artifact: ArtifactEnvelope
  compact: boolean
  status?: string
  onSaveArtifact?: (artifact: ArtifactEnvelope) => void
  onAskAgent?: () => void
  onApprove?: () => void
  onReject?: () => void
}) {
  const { sandpack } = useSandpack()
  const [activeView, setActiveView] = useState<'preview' | 'code'>('preview')
  const [expanded, setExpanded] = useState(false)
  const files = artifact.files ?? []
  const template = detectSandpackTemplate(files)
  const artifactPaths = new Set(canonicalFiles(files).map((file) => file.path))
  const [lastSaved, setLastSaved] = useState(() => JSON.stringify(canonicalFiles(files)))
  const currentFiles = filesFromSandpack(sandpack.files, artifactPaths)
  const currentSnapshot = JSON.stringify(currentFiles)
  const dirty = currentSnapshot !== lastSaved
  const buildFailed = !!sandpack.error || sandpack.status === 'timeout'

  function saveRevision() {
    const next: ArtifactEnvelope = {
      ...artifact,
      files: currentFiles,
      revision: {
        number: (artifact.revision?.number ?? 0) + 1,
        savedAt: new Date().toISOString(),
      },
    }
    actions.onSaveArtifact?.(next)
    setLastSaved(currentSnapshot)
  }

  return (
    <section className={`inline-code-artifact ${compact ? 'compact' : ''}`}>
      <header className="inline-code-artifact-header">
        <div>
          <span>{artifact.kind}</span>
          <strong>{artifact.title}</strong>
        </div>
        <span className={`inline-build-status ${buildFailed ? 'error' : ''}`}>
          {buildFailed
            ? 'Build failed'
            : sandpack.status === 'running'
              ? 'Building…'
              : dirty
                ? 'Modified'
                : (status ?? 'Ready')}
        </span>
        <div className="inline-artifact-tabs" role="tablist" aria-label="Artifact view">
          <button
            type="button"
            className={activeView === 'preview' ? 'active' : ''}
            onClick={() => setActiveView('preview')}
          >
            <Eye size={13} /> Preview
          </button>
          <button
            type="button"
            className={activeView === 'code' ? 'active' : ''}
            onClick={() => setActiveView('code')}
          >
            <Code2 size={13} /> Code
          </button>
        </div>
      </header>

      <div className="inline-code-artifact-stage nodrag nopan nowheel">
        {activeView === 'preview' ? (
          <SandpackPreview
            showNavigator
            showRefreshButton
            showOpenInCodeSandbox={false}
            showOpenNewtab
            style={{ height: compact ? 300 : 480 }}
          />
        ) : (
          <SandpackLayout style={{ height: compact ? 300 : 480, border: 0, borderRadius: 0 }}>
            <div className="inline-code-editor-layout">
              <SandpackFileExplorer />
              <SandpackCodeEditor
                showTabs
                showLineNumbers
                showInlineErrors
                closableTabs
                wrapContent
                style={{ height: '100%' }}
              />
            </div>
          </SandpackLayout>
        )}
      </div>

      <footer className="inline-code-artifact-footer">
        <span>
          <FolderTree size={12} /> {files.length} files · {template}
        </span>
        <div>
          <button type="button" onClick={actions.onAskAgent}>
            <Sparkles size={12} /> Ask agent
          </button>
          <button type="button" disabled={!dirty} onClick={() => sandpack.resetAllFiles()}>
            <RefreshCw size={12} /> Revert
          </button>
          <button type="button" disabled={!dirty || !actions.onSaveArtifact} onClick={saveRevision}>
            <Save size={12} /> Save
          </button>
          {actions.onApprove && (
            <button type="button" onClick={actions.onApprove}>
              <Check size={12} /> Approve
            </button>
          )}
          {actions.onReject && (
            <button type="button" onClick={actions.onReject}>
              Reject
            </button>
          )}
          <button type="button" onClick={() => setExpanded(true)}>
            <Expand size={12} /> Expand
          </button>
        </div>
      </footer>
      {expanded &&
        createPortal(
          <WorkspaceShell artifact={artifact} onClose={() => setExpanded(false)} {...actions} />,
          document.body,
        )}
    </section>
  )
}

function CodeArtifactCard({
  artifact,
  compact,
  status,
  ...actions
}: {
  artifact: ArtifactEnvelope
  compact: boolean
  status?: string
  onSaveArtifact?: (artifact: ArtifactEnvelope) => void
  onAskAgent?: () => void
  onApprove?: () => void
  onReject?: () => void
}) {
  const template = detectSandpackTemplate(artifact.files ?? [])
  return (
    <SandpackProvider
      template={template}
      files={normalizedFiles(artifact)}
      customSetup={{ dependencies: packageDependencies(artifact) }}
      options={{
        activeFile: artifact.entrypoint,
        visibleFiles: (artifact.files ?? []).map((file) =>
          file.path.startsWith('/') ? file.path : `/${file.path}`,
        ),
        autorun: true,
        autoReload: true,
        initMode: 'user-visible',
        recompileMode: 'delayed',
        recompileDelay: 350,
        bundlerURL: import.meta.env.VITE_SANDPACK_BUNDLER_URL as string | undefined,
      }}
      theme="light"
    >
      <InlineCodeArtifact artifact={artifact} compact={compact} status={status} {...actions} />
    </SandpackProvider>
  )
}

export function ArtifactRenderer({
  artifact,
  compact = false,
  status,
  ...actions
}: ArtifactRendererProps) {
  const wireframe = unwrapUswdsArtifact(artifact)
  if (wireframe)
    return (
      <div className="nodrag nopan nowheel">
        <UswdsWireframePreview artifact={wireframe} compact={compact} />
      </div>
    )
  if (!isArtifactEnvelope(artifact)) return <StructuredData value={artifact} />
  if (artifact.renderer.type === 'code' || artifact.renderer.type === 'web-preview')
    return <CodeArtifactCard artifact={artifact} compact={compact} status={status} {...actions} />
  if (artifact.renderer.type === 'openapi') return <OpenApiPreview value={artifact.payload} />
  return <StructuredData value={artifact.payload} />
}
