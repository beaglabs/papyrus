import type { SessionEvent } from '@papyrus/contracts'

export interface AcpContentItem {
  id: string
  role: 'user' | 'agent'
  sequence: number
  blocks: Array<Record<string, unknown>>
}

export function acpContent(events: SessionEvent[]): AcpContentItem[] {
  const messages = new Map<string, AcpContentItem>()
  for (const event of events) {
    if (event.kind !== 'update' || !record(event.data)) continue
    const kind = event.data.sessionUpdate
    const role = kind === 'user_message_chunk' ? 'user' : kind === 'agent_message_chunk' ? 'agent' : undefined
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

export function ContentMessage({ message }: { message: AcpContentItem }) {
  return <article className={`message ${message.role}`}><span>{message.role === 'user' ? 'YOU' : 'PAPYRUS'}</span><div className="content-blocks">{message.blocks.map((block, index) => <ContentBlock key={index} block={block} />)}</div></article>
}

function ContentBlock({ block }: { block: Record<string, unknown> }) {
  if (block.type === 'text') return <p>{String(block.text ?? '')}</p>
  if (block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') return <img className="message-image" src={`data:${block.mimeType};base64,${block.data}`} alt="Agent-provided visual" />
  if (block.type === 'resource_link' && typeof block.uri === 'string') return <a className="resource-card" href={safeUri(block.uri)}><strong>{String(block.title ?? block.name ?? 'Resource')}</strong><small>{String(block.mimeType ?? block.uri)}</small></a>
  if (block.type === 'resource' && record(block.resource)) return <div className="resource-card"><strong>{fileName(String(block.resource.uri ?? 'Embedded resource'))}</strong><small>{String(block.resource.mimeType ?? 'embedded context')}</small></div>
  if (block.type === 'audio') return <div className="resource-card"><strong>Audio content</strong><small>{String(block.mimeType ?? 'audio')}</small></div>
  return <div className="resource-card"><strong>Structured ACP content</strong><small>{String(block.type ?? 'unknown')}</small></div>
}

function safeUri(uri: string) { return /^(https?:|\/)/.test(uri) ? uri : '#' }
function fileName(uri: string) { return decodeURIComponent(uri.split('/').at(-1) ?? uri) }
function record(value: unknown): value is Record<string, any> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) }
