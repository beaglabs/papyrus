import { Sandpack } from '@codesandbox/sandpack-react'
import {
  type ArtifactEnvelope,
  isArtifactEnvelope,
  unwrapUswdsArtifact,
} from '@papyrus/core/artifacts/envelope'
import { tokens } from '@papyrus/core/design'
import { UswdsWireframePreview } from './UswdsWireframePreview'

interface ArtifactRendererProps {
  artifact: unknown
  compact?: boolean
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

function CodePreview({
  artifact,
  compact = false,
}: { artifact: ArtifactEnvelope; compact?: boolean }) {
  const files = Object.fromEntries(
    (artifact.files ?? []).map((file) => [
      file.path.startsWith('/') ? file.path : `/${file.path}`,
      { code: file.content },
    ]),
  )
  if (!Object.keys(files).length) return <StructuredData value={artifact.payload} />
  if (compact) {
    return (
      <div
        style={{
          border: `1px solid ${tokens.color.border}`,
          padding: 8,
          fontFamily: tokens.font.mono,
          fontSize: 10,
        }}
      >
        {(artifact.files ?? []).map((file) => (
          <div key={file.path}>{file.path}</div>
        ))}
      </div>
    )
  }
  const canPreview = Object.keys(files).some((path) => /\.(tsx|jsx|js|html|css)$/.test(path))
  return (
    <div className="nodrag nowheel" onPointerDown={(event) => event.stopPropagation()}>
      <Sandpack
        template="react"
        files={files}
        options={{
          showNavigator: false,
          showTabs: true,
          showLineNumbers: true,
          editorHeight: 360,
          layout: canPreview ? 'preview' : 'console',
        }}
        customSetup={{ dependencies: {}, devDependencies: {} }}
        theme="light"
      />
    </div>
  )
}

export function ArtifactRenderer({ artifact, compact = false }: ArtifactRendererProps) {
  const wireframe = unwrapUswdsArtifact(artifact)
  if (wireframe) return <UswdsWireframePreview artifact={wireframe} compact={compact} />
  if (!isArtifactEnvelope(artifact)) return <StructuredData value={artifact} />

  if (artifact.renderer.type === 'code' || artifact.renderer.type === 'web-preview') {
    return <CodePreview artifact={artifact} compact={compact} />
  }
  if (artifact.renderer.type === 'openapi') return <OpenApiPreview value={artifact.payload} />
  return <StructuredData value={artifact.payload} />
}
