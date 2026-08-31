import type { SessionEvent } from '@papyrus/contracts'
import type { ReactNode } from 'react'
import { Message, MessageContent, MessageStreaming } from '@mastra/react/ui'
import { McpUiResource } from './McpUi'

export interface AcpContentItem {
  id: string
  role: 'user' | 'agent' | 'thought'
  sequence: number
  blocks: Array<Record<string, unknown>>
}

export function acpContent(events: SessionEvent[]): AcpContentItem[] {
  const messages = new Map<string, AcpContentItem>()
  for (const event of events) {
    if (event.kind !== 'update' || !record(event.data)) continue
    const kind = event.data.sessionUpdate
    const role = kind === 'user_message_chunk' ? 'user' : kind === 'agent_message_chunk' ? 'agent' : kind === 'agent_thought_chunk' ? 'thought' : undefined
    if (!role || !record(event.data.content)) continue
    const id = typeof event.data.messageId === 'string' ? event.data.messageId : `${role}_${event.sequence}`
    const current = messages.get(id) ?? { id, role, sequence: event.sequence, blocks: [] }
    const block = event.data.content
    const last = current.blocks.at(-1)
    if (block.type === 'text' && last?.type === 'text') last.text = `${String(last.text ?? '')}${String(block.text ?? '')}`
    else current.blocks.push({ ...block })
    messages.set(id, current)
  }
  return [...messages.values()].sort((a, b) => a.sequence - b.sequence)
}

export function ContentMessage({ message, active = false }: { message: AcpContentItem; active?: boolean }) {
  if (message.role === 'thought') {
    if (!active) return null
    return <div className="message thought thought-status" role="status"><span className="thought-orbit" aria-hidden="true" /><strong>Working…</strong></div>
  }
  return <Message position={message.role === 'user' ? 'right' : 'left'} className={`message ${message.role}`}><span>{message.role === 'user' ? 'YOU' : 'PAPYRUS'}</span><MessageContent className="content-blocks" isStreaming={active}>{message.blocks.map((block, index) => <ContentBlock key={index} block={block} />)}{active && <MessageStreaming />}</MessageContent></Message>
}

export function ContentBlock({ block }: { block: Record<string, unknown> }) {
  if (block.type === 'text') return <MarkdownText text={String(block.text ?? '')} />
  if (block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') return <img className="message-image" src={`data:${block.mimeType};base64,${block.data}`} alt="Agent-provided visual" />
  if (block.type === 'resource_link' && typeof block.uri === 'string') return <a className="resource-card" href={safeUri(block.uri)}><strong>{String(block.title ?? block.name ?? 'Resource')}</strong><small>{String(block.mimeType ?? block.uri)}</small></a>
  if (block.type === 'resource' && record(block.resource)) {
    const rendered = McpUiResource({ resource: block.resource as Record<string, unknown> })
    if (rendered) return rendered
    return <div className="resource-card"><strong>{fileName(String(block.resource.uri ?? 'Embedded resource'))}</strong><small>{String(block.resource.mimeType ?? 'embedded context')}</small></div>
  }
  if (block.type === 'audio') return <div className="resource-card"><strong>Audio content</strong><small>{String(block.mimeType ?? 'audio')}</small></div>
  return <div className="resource-card"><strong>Structured ACP content</strong><small>{String(block.type ?? 'unknown')}</small></div>
}

export function MarkdownText({ text }: { text: string }) {
  return <div className="markdown-text">{markdownBlocks(text)}</div>
}

function markdownBlocks(markdown: string): ReactNode[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const output: ReactNode[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    const fence = line.match(/^\s*```([^\s`]*)\s*$/)
    if (fence) {
      const code: string[] = []
      index += 1
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index] ?? '')) code.push(lines[index++] ?? '')
      if (index < lines.length) index += 1
      output.push(<pre key={output.length}><code className={fence[1] ? `language-${fence[1]}` : undefined}>{code.join('\n')}</code></pre>)
      continue
    }
    if (!line.trim()) { index += 1; continue }
    const nextLine = lines[index + 1] ?? ''
    if (line.includes('|') && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(nextLine)) {
      const headers = tableCells(line)
      const alignments = tableCells(nextLine).map((cell) => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left')
      const rows: string[][] = []
      index += 2
      while (index < lines.length && (lines[index] ?? '').includes('|') && (lines[index] ?? '').trim()) {
        rows.push(tableCells(lines[index] ?? ''))
        index += 1
      }
      output.push(<div className="markdown-table-scroll" key={output.length}><table><thead><tr>{headers.map((cell, cellIndex) => <th className={`align-${alignments[cellIndex] ?? 'left'}`} key={cellIndex}>{inlineMarkdown(cell)}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{headers.map((_, cellIndex) => <td className={`align-${alignments[cellIndex] ?? 'left'}`} key={cellIndex}>{inlineMarkdown(row[cellIndex] ?? '')}</td>)}</tr>)}</tbody></table></div>)
      continue
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      const level = heading[1]!.length
      const content = inlineMarkdown(heading[2]!)
      output.push(level === 1 ? <h1 key={output.length}>{content}</h1>
        : level === 2 ? <h2 key={output.length}>{content}</h2>
        : level === 3 ? <h3 key={output.length}>{content}</h3>
        : level === 4 ? <h4 key={output.length}>{content}</h4>
        : level === 5 ? <h5 key={output.length}>{content}</h5>
        : <h6 key={output.length}>{content}</h6>)
      index += 1
      continue
    }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) { output.push(<hr key={output.length} />); index += 1; continue }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: ReactNode[] = []
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index] ?? '')) {
        items.push(<li key={items.length}>{inlineMarkdown((lines[index] ?? '').replace(/^\s*[-*+]\s+/, ''))}</li>)
        index += 1
      }
      output.push(<ul key={output.length}>{items}</ul>)
      continue
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: ReactNode[] = []
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index] ?? '')) {
        items.push(<li key={items.length}>{inlineMarkdown((lines[index] ?? '').replace(/^\s*\d+[.)]\s+/, ''))}</li>)
        index += 1
      }
      output.push(<ol key={output.length}>{items}</ol>)
      continue
    }
    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = []
      while (index < lines.length && /^\s*>\s?/.test(lines[index] ?? '')) quote.push((lines[index++] ?? '').replace(/^\s*>\s?/, ''))
      output.push(<blockquote key={output.length}>{inlineMarkdown(quote.join(' '))}</blockquote>)
      continue
    }
    const paragraph: string[] = [line]
    index += 1
    while (index < lines.length && (lines[index] ?? '').trim() && !/^(#{1,6})\s+|^\s*```|^\s*[-*+]\s+|^\s*\d+[.)]\s+|^\s*>\s?/.test(lines[index] ?? '')) paragraph.push(lines[index++] ?? '')
    output.push(<p key={output.length}>{inlineMarkdown(paragraph.join('\n'))}</p>)
  }
  return output
}

function tableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll('\\|', '|'))
}

function inlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /(\[([^\]]+)\]\(([^\s)]+)(?:\s+["'][^"']*["'])?\)|`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|\*([^*]+)\*|_([^_]+)_)/g
  let cursor = 0
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0
    if (at > cursor) nodes.push(text.slice(cursor, at))
    if (match[2] && match[3]) {
      const uri = safeUri(match[3])
      nodes.push(uri === '#' ? match[2] : <a key={nodes.length} href={uri} target="_blank" rel="noreferrer">{match[2]}</a>)
    } else if (match[4]) nodes.push(<code key={nodes.length}>{match[4]}</code>)
    else if (match[5] || match[6]) nodes.push(<strong key={nodes.length}>{match[5] ?? match[6]}</strong>)
    else if (match[7]) nodes.push(<del key={nodes.length}>{match[7]}</del>)
    else if (match[8] || match[9]) nodes.push(<em key={nodes.length}>{match[8] ?? match[9]}</em>)
    cursor = at + match[0].length
  }
  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes
}

function safeUri(uri: string) { return /^(https?:|\/)/.test(uri) ? uri : '#' }
function fileName(uri: string) { return decodeURIComponent(uri.split('/').at(-1) ?? uri) }
function record(value: unknown): value is Record<string, any> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) }
