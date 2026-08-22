import { Fragment, type ReactNode, useEffect, useState } from 'react'
import type { ResearchSource } from '@papyrus/contracts'
import { researchSources } from './api.js'

export function SourcesView() {
  const [sources, setSources] = useState<ResearchSource[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  useEffect(() => {
    void researchSources().then(setSources).catch((cause) => setError(cause instanceof Error ? cause.message : 'Unable to load sources')).finally(() => setLoading(false))
  }, [])
  if (loading) return <div className="empty">Loading governed sources…</div>
  if (error) return <div className="error">{error}</div>
  return <SourceList sources={sources} empty="Browser evidence captured by your authorized sessions will appear here." />
}

export function SourceList({ sources, empty }: { sources: ResearchSource[]; empty?: string }) {
  return <div className="source-view">{sources.length ? sources.map((source) => <article key={`${source.sessionId}-${source.id}`}>
    <div className="source-host">{source.host}</div>
    <div className="source-body">
      <strong>{source.title}</strong>
      <a href={source.url} target="_blank" rel="noreferrer">{source.url}</a>
      {source.preview
        ? <SourcePreview content={source.preview} mediaType={source.previewMediaType ?? 'text/plain'} />
        : source.excerpt && <p>{source.excerpt}</p>}
      <span>Captured {new Date(source.capturedAt).toLocaleString()} · event {source.sequence}</span>
    </div>
  </article>) : <div className="conversation-empty"><h2>No research sources yet.</h2><p>{empty ?? 'Sources emitted by governed browser research will appear here.'}</p></div>}</div>
}

function SourcePreview({ content, mediaType = 'text/plain' }: { content: string; mediaType?: string }) {
  if (mediaType === 'text/markdown' || mediaType === 'text/x-markdown') {
    return <div className="source-preview source-preview-markdown">{markdownBlocks(content)}</div>
  }
  return <pre className="source-preview">{content}</pre>
}

function markdownBlocks(markdown: string): ReactNode[] {
  const blocks: ReactNode[] = []
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  let paragraph: string[] = []
  let code: string[] = []
  let codeLanguage = ''
  let inCode = false

  const flushParagraph = () => {
    if (!paragraph.length) return
    const text = paragraph.join(' ').trim()
    if (text) blocks.push(<p key={`p-${blocks.length}`}>{inlineMarkdown(text)}</p>)
    paragraph = []
  }
  const flushCode = () => {
    blocks.push(<pre key={`code-${blocks.length}`}><code data-language={codeLanguage || undefined}>{code.join('\n')}</code></pre>)
    code = []
    codeLanguage = ''
  }

  for (const line of lines) {
    const fence = line.match(/^\s*```\s*([^\s]*)/)
    if (fence) {
      if (inCode) flushCode()
      else { flushParagraph(); codeLanguage = fence[1] ?? '' }
      inCode = !inCode
      continue
    }
    if (inCode) { code.push(line); continue }
    const heading = line.match(/^(#{1,4})\s+(.+)$/)
    if (heading) {
      flushParagraph()
      const level = heading[1]!.length
      const children = inlineMarkdown(heading[2]!)
      blocks.push(level === 1 ? <h1 key={`h-${blocks.length}`}>{children}</h1>
        : level === 2 ? <h2 key={`h-${blocks.length}`}>{children}</h2>
          : level === 3 ? <h3 key={`h-${blocks.length}`}>{children}</h3>
            : <h4 key={`h-${blocks.length}`}>{children}</h4>)
      continue
    }
    if (/^\s*([-*_])\1\1+\s*$/.test(line)) { flushParagraph(); blocks.push(<hr key={`hr-${blocks.length}`} />); continue }
    const item = line.match(/^\s*[-*+]\s+(.+)$/)
    if (item) { flushParagraph(); blocks.push(<div className="source-preview-item" key={`li-${blocks.length}`}>• {inlineMarkdown(item[1]!)}</div>); continue }
    if (!line.trim()) { flushParagraph(); continue }
    if (/^\s*<\/?(?:div|p|center)(?:\s[^>]*)?>\s*$/i.test(line)) continue
    paragraph.push(line.trim())
  }
  flushParagraph()
  if (inCode || code.length) flushCode()
  return blocks
}

function inlineMarkdown(value: string): ReactNode[] {
  const output: ReactNode[] = []
  const pattern = /(!?\[[^\]]*\]\([^)]+\)|\*\*[^*]+\*\*|`[^`]+`)/g
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(value))) {
    if (match.index > cursor) output.push(value.slice(cursor, match.index))
    const token = match[0]
    const link = token.match(/^(!?)\[([^\]]*)\]\(([^)]+)\)$/)
    if (link) {
      const image = link[1]! === '!'
      const label = link[2]!
      const href = safeHttpUrl(link[3]!)
      output.push(image
        ? href ? <img key={match.index} src={href} alt={label} loading="lazy" /> : <span key={match.index}>{label}</span>
        : href ? <a key={match.index} href={href} target="_blank" rel="noreferrer">{label}</a> : <span key={match.index}>{label}</span>)
    } else if (token.startsWith('**')) output.push(<strong key={match.index}>{token.slice(2, -2)}</strong>)
    else output.push(<code key={match.index}>{token.slice(1, -1)}</code>)
    cursor = match.index + token.length
  }
  if (cursor < value.length) output.push(value.slice(cursor))
  return output.map((node, index) => <Fragment key={index}>{node}</Fragment>)
}

function safeHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined
  } catch { return undefined }
}
