import {
  SandpackLayout,
  type SandpackPredefinedTemplate,
  SandpackPreview,
  SandpackProvider,
  useSandpack,
} from '@codesandbox/sandpack-react'
import Editor from '@monaco-editor/react'
import { tokens } from '@papyrus/core/design'
import {
  Check,
  CircleX,
  Code2,
  FileCode2,
  FileText,
  FolderTree,
  RefreshCw,
  Sparkles,
  Terminal,
} from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import type { Generation, GeneratedFile } from './DevEnvironment'
import { ShellTerminal } from './ShellTerminal'

interface PreviewPanelProps {
  generation: Generation | null
  loading: boolean
  onApprove: (generationId: string) => void
  onReject: (generationId: string) => void
  onFilesUpdate: (generationId: string, files: GeneratedFile[]) => void
}

type RightTab = 'preview' | 'code' | 'terminal'

function detectTemplate(files: GeneratedFile[]): SandpackPredefinedTemplate {
  const paths = files.map((f) => f.path.toLowerCase())
  if (paths.some((p) => p.endsWith('.vue'))) return 'vue'
  if (paths.some((p) => p.endsWith('.svelte'))) return 'svelte'
  if (paths.some((p) => p.endsWith('.tsx'))) return 'react-ts'
  if (paths.some((p) => p.endsWith('.jsx'))) return 'react'
  if (paths.some((p) => p.endsWith('.ts'))) return 'vanilla-ts'
  if (paths.some((p) => p.endsWith('.html'))) return 'static'
  return 'vanilla'
}

function normalizedFiles(files: GeneratedFile[]) {
  return Object.fromEntries(
    files.map((f) => [f.path.startsWith('/') ? f.path : `/${f.path}`, { code: f.content }]),
  )
}

function packageDependencies(files: GeneratedFile[]): Record<string, string> {
  const pkg = files.find((f) => /(^|\/)package\.json$/.test(f.path))
  if (!pkg) return {}
  try {
    const value = JSON.parse(pkg.content) as { dependencies?: Record<string, string> }
    return value.dependencies ?? {}
  } catch {
    return {}
  }
}

function canonicalFiles(files: GeneratedFile[]): GeneratedFile[] {
  return files
    .map((f) => ({
      ...f,
      path: f.path.startsWith('/') ? f.path : `/${f.path}`,
    }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

function MonacoCodeTab({
  files,
  onFilesUpdate,
}: {
  files: GeneratedFile[]
  onFilesUpdate: (files: GeneratedFile[]) => void
}) {
  const [selectedFile, setSelectedFile] = useState(files[0]?.path ?? '')
  const currentFile = files.find((f) => f.path === selectedFile) ?? files[0]

  const languageMap: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.css': 'css',
    '.html': 'html',
    '.json': 'json',
    '.md': 'markdown',
    '.py': 'python',
    '.rs': 'rust',
    '.go': 'go',
    '.sql': 'sql',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.toml': 'toml',
    '.svg': 'xml',
  }

  function getLanguage(filename: string): string {
    const ext = '.' + filename.split('.').pop()
    return languageMap[ext] ?? 'plaintext'
  }

  function handleEditorChange(value: string | undefined) {
    if (!currentFile || value === undefined) return
    const updated = files.map((f) =>
      f.path === currentFile.path ? { ...f, content: value } : f,
    )
    onFilesUpdate(updated)
  }

  return (
    <div className="monaco-code-tab">
      <div className="monaco-file-tree">
        <div className="monaco-file-tree-header">
          <FolderTree size={12} /> Files
        </div>
        {files.map((file) => (
          <button
            key={file.path}
            type="button"
            className={`monaco-file-item ${file.path === selectedFile ? 'active' : ''}`}
            onClick={() => setSelectedFile(file.path)}
          >
            <FileText size={12} />
            <span>{file.path.replace(/^\//, '')}</span>
          </button>
        ))}
      </div>
      <div className="monaco-editor-container">
        {currentFile && (
          <Editor
            key={currentFile.path}
            language={getLanguage(currentFile.path)}
            value={currentFile.content}
            onChange={handleEditorChange}
            theme="vs-dark"
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              lineNumbers: 'on',
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              padding: { top: 8 },
              renderLineHighlight: 'gutter',
              bracketPairColorization: { enabled: true },
            }}
            width="100%"
            height="100%"
          />
        )}
      </div>
    </div>
  )
}

function SandpackShell({
  generation,
  onApprove,
  onReject,
  onFilesUpdate,
}: {
  generation: Generation
  onApprove: (id: string) => void
  onReject: (id: string) => void
  onFilesUpdate: (id: string, files: GeneratedFile[]) => void
}) {
  const { sandpack } = useSandpack()
  const [activeTab, setActiveTab] = useState<RightTab>('preview')
  const artifactPaths = useMemo(
    () => new Set(canonicalFiles(generation.files).map((f) => f.path)),
    [generation.files],
  )

  const currentFiles = useMemo(() => {
    return canonicalFiles(
      Object.entries(sandpack.files)
        .filter(([path]) => artifactPaths.has(path))
        .map(([path, file]) => ({ path, content: file.code })),
    )
  }, [sandpack.files, artifactPaths])

  const buildFailed = !!sandpack.error || sandpack.status === 'timeout'
  const statusLabel = buildFailed
    ? 'Build failed'
    : sandpack.status === 'running'
      ? 'Building...'
      : 'Ready'

  const handleSave = useCallback(() => {
    onFilesUpdate(generation.id, currentFiles)
  }, [generation.id, currentFiles, onFilesUpdate])

  return (
    <div className="preview-shell">
      <div className="preview-shell-header">
        <div className="preview-shell-tabs">
          <button
            type="button"
            className={`preview-tab ${activeTab === 'preview' ? 'active' : ''}`}
            onClick={() => setActiveTab('preview')}
          >
            Preview
          </button>
          <button
            type="button"
            className={`preview-tab ${activeTab === 'code' ? 'active' : ''}`}
            onClick={() => setActiveTab('code')}
          >
            <Code2 size={13} /> Code
          </button>
          <button
            type="button"
            className={`preview-tab ${activeTab === 'terminal' ? 'active' : ''}`}
            onClick={() => setActiveTab('terminal')}
          >
            <Terminal size={13} /> Console
          </button>
        </div>
        <div className="preview-shell-actions">
          <span className={`preview-status ${buildFailed ? 'error' : ''}`}>
            {statusLabel}
          </span>
          <span className="preview-file-count">
            <FolderTree size={12} /> {generation.files.length} files
          </span>
          <div className="preview-action-divider" />
          <button
            type="button"
            className="preview-action-btn"
            onClick={() => sandpack.resetAllFiles()}
            title="Revert changes"
          >
            <RefreshCw size={13} />
          </button>
          <button
            type="button"
            className="preview-action-btn"
            onClick={handleSave}
            title="Save changes"
          >
            <Sparkles size={13} />
          </button>
          {generation.status === 'proposed' && (
            <>
              <div className="preview-action-divider" />
              <button
                type="button"
                className="preview-approve-btn"
                onClick={() => onApprove(generation.id)}
              >
                <Check size={13} /> Approve
              </button>
              <button
                type="button"
                className="preview-reject-btn"
                onClick={() => onReject(generation.id)}
              >
                <CircleX size={13} /> Reject
              </button>
            </>
          )}
          {generation.status === 'approved' && (
            <span className="preview-approved-badge">
              <Check size={12} /> Approved
            </span>
          )}
          {generation.status === 'rejected' && (
            <span className="preview-rejected-badge">
              <CircleX size={12} /> Rejected
            </span>
          )}
        </div>
      </div>

      <div className="preview-shell-content">
        {activeTab === 'preview' && (
          <SandpackPreview
            showNavigator
            showRefreshButton
            showOpenInCodeSandbox={false}
            style={{ height: '100%' }}
          />
        )}
        {activeTab === 'code' && (
          <MonacoCodeTab
            files={currentFiles}
            onFilesUpdate={(updated) => onFilesUpdate(generation.id, updated)}
          />
        )}
        {activeTab === 'terminal' && (
          <ShellTerminal />
        )}
      </div>
    </div>
  )
}

export function PreviewPanel({
  generation,
  loading,
  onApprove,
  onReject,
  onFilesUpdate,
}: PreviewPanelProps) {
  if (!generation && !loading) {
    return (
      <div className="preview-empty">
        <div className="preview-empty-content">
          <FileCode2 size={48} strokeWidth={1} />
          <h3>No code yet</h3>
          <p>Describe what you want to build in the chat, and the code will appear here.</p>
        </div>
      </div>
    )
  }

  if (!generation && loading) {
    return (
      <div className="preview-skeleton">
        <div className="preview-skeleton-header">
          <div className="skeleton-tab" />
          <div className="skeleton-tab" />
          <div className="skeleton-tab" />
        </div>
        <div className="preview-skeleton-body">
          <div className="skeleton-browser-bar">
            <span /><span /><span />
            <div className="skeleton-url" />
          </div>
          <div className="skeleton-content">
            <div className="skeleton-hero" />
            <div className="skeleton-line wide" />
            <div className="skeleton-line medium" />
            <div className="skeleton-line narrow" />
            <div className="skeleton-cards">
              <div className="skeleton-card" />
              <div className="skeleton-card" />
              <div className="skeleton-card" />
            </div>
          </div>
        </div>
        <div className="preview-skeleton-status">
          <span className="preview-status">Generating...</span>
          <span className="preview-file-count">Building project structure</span>
        </div>
      </div>
    )
  }

  if (!generation) return null

  const template = detectTemplate(generation.files)
  const files = normalizedFiles(generation.files)
  const deps = packageDependencies(generation.files)

  return (
    <SandpackProvider
      template={template}
      files={files}
      customSetup={{ dependencies: deps }}
      options={{
        autorun: true,
        autoReload: true,
        initMode: 'user-visible',
        recompileMode: 'delayed',
        recompileDelay: 350,
      }}
      theme="light"
    >
      <SandpackShell
        generation={generation}
        onApprove={onApprove}
        onReject={onReject}
        onFilesUpdate={onFilesUpdate}
      />
    </SandpackProvider>
  )
}
