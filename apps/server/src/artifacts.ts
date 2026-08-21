import type { Artifact, SessionEvent } from '@papyrus/contracts'

export interface ProjectedArtifact extends Artifact {
  encoding: 'utf8' | 'base64'
  content: string
}

export function projectArtifacts(sessionId: string, events: SessionEvent[]): ProjectedArtifact[] {
  const artifacts: ProjectedArtifact[] = []
  const versions = new Map<string, number>()
  for (const event of events) {
    if (event.kind !== 'update' || !record(event.data)) continue
    const update = event.data
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') continue
    if (!Array.isArray(update.content)) continue
    for (const [index, item] of update.content.entries()) {
      if (!record(item)) continue
      const projected = projectItem(sessionId, event, item, index, versions)
      if (projected) artifacts.push(projected)
    }
  }
  return artifacts
}

function projectItem(sessionId: string, event: SessionEvent, item: Record<string, unknown>, index: number, versions: Map<string, number>): ProjectedArtifact | undefined {
  if (item.type === 'diff' && typeof item.path === 'string' && typeof item.newText === 'string') {
    return artifact(sessionId, event, index, versions, {
      name: basename(item.path) || 'change.diff', kind: 'diff', mediaType: mediaType(item.path), encoding: 'utf8', content: item.newText,
    })
  }
  if (item.type !== 'content' || !record(item.content) || item.content.type !== 'resource' || !record(item.content.resource)) return undefined
  const resource = item.content.resource
  const name = typeof resource.uri === 'string' ? basename(resource.uri) || `artifact-${event.sequence}` : `artifact-${event.sequence}`
  if (typeof resource.text === 'string') {
    return artifact(sessionId, event, index, versions, {
      name, kind: 'resource', mediaType: typeof resource.mimeType === 'string' ? resource.mimeType : 'text/plain', encoding: 'utf8', content: resource.text,
    })
  }
  if (typeof resource.blob === 'string') {
    return artifact(sessionId, event, index, versions, {
      name, kind: 'resource', mediaType: typeof resource.mimeType === 'string' ? resource.mimeType : 'application/octet-stream', encoding: 'base64', content: resource.blob,
    })
  }
  return undefined
}

function artifact(
  sessionId: string,
  event: SessionEvent,
  index: number,
  versions: Map<string, number>,
  input: Pick<ProjectedArtifact, 'name' | 'kind' | 'mediaType' | 'encoding' | 'content'>,
): ProjectedArtifact {
  const key = `${input.kind}:${input.name}`
  const version = (versions.get(key) ?? 0) + 1
  versions.set(key, version)
  const id = `${event.sequence}-${index}`
  return {
    id, sessionId, ...(event.runId ? { runId: event.runId } : {}), ...input, version,
    sequence: event.sequence, createdAt: event.occurredAt,
    downloadUrl: `/api/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(id)}/download`,
  }
}

function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) }
function basename(value: string): string { return value.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) ?? '' }
function mediaType(path: string): string {
  const extension = path.toLowerCase().split('.').at(-1)
  return ({ md: 'text/markdown', txt: 'text/plain', json: 'application/json', csv: 'text/csv', html: 'text/html', xml: 'application/xml' } as Record<string, string>)[extension ?? ''] ?? 'text/plain'
}
