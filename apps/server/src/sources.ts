import type { ResearchSource, SessionEvent } from '@papyrus/contracts'

export function projectResearchSources(sessionId: string, events: SessionEvent[]): ResearchSource[] {
  const sources: ResearchSource[] = []
  for (const event of events) {
    if (event.kind !== 'update' || !record(event.data)) continue
    const update = event.data
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') continue
    const title = typeof update.title === 'string' && update.title.trim() ? update.title.trim().slice(0, 300) : 'Browser research'
    const excerpt = sanitizeExcerpt(firstText(update))
    const urls = [...collectUrls(update)].map(sanitizeUrl).filter((url): url is URL => Boolean(url))
    const unique = new Map(urls.map((url) => [url.href, url]))
    let index = 0
    for (const url of unique.values()) {
      sources.push({
        id: `${event.sequence}-${index++}`, sessionId, ...(event.runId ? { runId: event.runId } : {}), title,
        url: url.href, host: url.host, ...(excerpt ? { excerpt } : {}), sequence: event.sequence, capturedAt: event.occurredAt,
      })
    }
  }
  return sources
}

function* collectUrls(value: unknown, depth = 0): Generator<string> {
  if (depth > 6) return
  if (typeof value === 'string') {
    for (const match of value.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) yield match[0]
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) yield* collectUrls(item, depth + 1)
    return
  }
  if (!record(value)) return
  for (const item of Object.values(value)) yield* collectUrls(item, depth + 1)
}

function sanitizeUrl(value: string): URL | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    url.username = ''; url.password = ''; url.hash = ''; url.search = ''
    return url
  } catch { return undefined }
}

function sanitizeExcerpt(value: string | undefined): string | undefined {
  if (!value) return undefined
  const sanitized = value.replace(/https?:\/\/[^\s<>"')\]]+/gi, (candidate) => sanitizeUrl(candidate)?.href ?? '[invalid URL]')
    .replace(/\s+/g, ' ').trim().slice(0, 500)
  return sanitized || undefined
}

function firstText(value: unknown, depth = 0): string | undefined {
  if (depth > 6) return undefined
  if (record(value) && typeof value.text === 'string' && value.text.trim()) return value.text
  if (Array.isArray(value)) {
    for (const item of value) { const found = firstText(item, depth + 1); if (found) return found }
  } else if (record(value)) {
    for (const item of Object.values(value)) { const found = firstText(item, depth + 1); if (found) return found }
  }
  return undefined
}

function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) }
