import {
  type UswdsWireframeArtifact,
  isUswdsWireframeArtifact,
  parseUswdsWireframeArtifact,
} from './uswds-wireframe.js'

export const ARTIFACT_SCHEMA = 'papyrus.artifact/v1' as const

export type ArtifactRenderer =
  | 'uswds-wireframe'
  | 'markdown'
  | 'json'
  | 'openapi'
  | 'code'
  | 'web-preview'
  | 'security'

export interface ArtifactFile {
  path: string
  content: string
  language?: string
}

export interface ArtifactEnvelope {
  schema: typeof ARTIFACT_SCHEMA
  kind: string
  title: string
  summary?: string
  schemaRef?: string
  renderer: { type: ArtifactRenderer; options?: Record<string, unknown> }
  payload?: unknown
  files?: ArtifactFile[]
  entrypoint?: string
  producer?: { persona: string; skill?: string; tool?: string }
  lineage?: { parentNodeIds?: string[]; revisionOf?: string }
  revision?: { number: number; savedAt: string; savedBy?: string }
  permissions?: {
    network?: 'none' | 'approval' | 'allowed'
    credentials?: string[]
  }
}

export function isArtifactEnvelope(value: unknown): value is ArtifactEnvelope {
  if (!value || typeof value !== 'object') return false
  const artifact = value as Partial<ArtifactEnvelope>
  return (
    artifact.schema === ARTIFACT_SCHEMA &&
    typeof artifact.kind === 'string' &&
    typeof artifact.title === 'string' &&
    !!artifact.renderer &&
    typeof artifact.renderer.type === 'string'
  )
}

function parseJson(content: string): unknown {
  try {
    return JSON.parse(content)
  } catch {
    return undefined
  }
}

function codeFiles(content: string): ArtifactFile[] {
  const files: ArtifactFile[] = []
  let index = 0
  for (const match of content.matchAll(/```([\w.+-]*)\s*(?:file=([^\s]+))?\n([\s\S]*?)```/g)) {
    const language = (match[1] || '').toLowerCase()
    const precedingPath = content.slice(0, match.index).match(/(?:^|\n)(\/[^\s\n]+)\s*\n\s*$/)?.[1]
    const explicitPath = match[2] ?? precedingPath
    const extension: Record<string, string> = {
      typescript: 'ts',
      ts: 'ts',
      tsx: 'tsx',
      javascript: 'js',
      js: 'js',
      jsx: 'jsx',
      css: 'css',
      html: 'html',
      python: 'py',
      py: 'py',
      json: 'json',
      yaml: 'yaml',
      yml: 'yml',
      shell: 'sh',
      bash: 'sh',
      sh: 'sh',
      rust: 'rs',
      go: 'go',
      java: 'java',
      sql: 'sql',
      vue: 'vue',
      svelte: 'svelte',
    }

    // Markdown commonly uses unlabeled fences for examples, diagrams, or quoted
    // material. Those are not source files. Only create a code workspace when the
    // provider supplied a recognized source language or an explicit file path.
    const inferredExtension = extension[language]
    if (!explicitPath && !inferredExtension) continue

    index++
    files.push({
      path: explicitPath || `/artifact-${index}.${inferredExtension}`,
      content: match[3] ?? '',
      language: language || undefined,
    })
  }
  return files
}

/** Convert both v1 envelopes and legacy artifact bodies into one renderable contract. */
export function coerceArtifactEnvelope(
  kind: string,
  title: string,
  content: string,
  persona = 'agent',
): ArtifactEnvelope {
  const parsed = parseJson(content)
  if (isArtifactEnvelope(parsed)) return parsed

  const wireframe: UswdsWireframeArtifact | undefined = isUswdsWireframeArtifact(parsed)
    ? parsed
    : parseUswdsWireframeArtifact(content)
  if (wireframe) {
    return {
      schema: ARTIFACT_SCHEMA,
      kind: 'ui-mockup',
      title: wireframe.title || title,
      schemaRef: 'papyrus.uswds-wireframe/v1',
      renderer: { type: 'uswds-wireframe' },
      payload: wireframe,
      producer: { persona },
    }
  }

  const files = codeFiles(content)
  if (
    ['application', 'source-code', 'mcp-server', 'skill-creator', 'design-system'].includes(kind)
  ) {
    return {
      schema: ARTIFACT_SCHEMA,
      kind,
      title,
      renderer: { type: files.length ? 'code' : 'markdown' },
      files: files.length ? files : undefined,
      payload: files.length ? undefined : content,
      entrypoint: files.find((file) => /\/(App|index)\.(tsx|jsx|html)$/.test(file.path))?.path,
      permissions: { network: 'none' },
      producer: { persona },
    }
  }

  const renderer: ArtifactRenderer =
    kind === 'api' && parsed && typeof parsed === 'object'
      ? 'openapi'
      : ['security-report', 'threat-model'].includes(kind)
        ? 'security'
        : parsed !== undefined
          ? 'json'
          : 'markdown'
  return {
    schema: ARTIFACT_SCHEMA,
    kind,
    title,
    renderer: { type: renderer },
    payload: parsed ?? content,
    producer: { persona },
  }
}

export function unwrapUswdsArtifact(value: unknown): UswdsWireframeArtifact | undefined {
  if (isUswdsWireframeArtifact(value)) return value
  if (isArtifactEnvelope(value) && isUswdsWireframeArtifact(value.payload)) return value.payload
  return undefined
}
