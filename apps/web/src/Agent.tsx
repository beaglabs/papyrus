import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, type UIMessage } from 'ai'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { AgentSession, AgentStatus } from './api.js'
import { approveProposal, connectPlugin, createSessionProposal, denyProposal, issueIngestionToken, sessionMessages, setSessionAttention } from './api.js'
import { ModelGatewayCard } from './Models.js'
import { Alert, Badge, Button, Card, Input, Label, NativeSelect, Textarea } from './components/ui/index.js'

interface PluginField {
  name: string
  label: string
  kind: 'text' | 'url' | 'email' | 'credential_reference' | 'select'
  required: boolean
  placeholder?: string
  help?: string
  options?: Array<{ label: string; value: string }>
}

interface PluginRequest {
  kind: 'plugin_connection_request'
  catalogId: string
  name: string
  description: string
  authority: string
  risk: string
  syncMode: string
  acceptsSignals: boolean
  fields: PluginField[]
  note: string
}

interface ModelGatewayRequest {
  kind: 'model_gateway_request'
  fields: PluginField[]
  note: string
}

interface UrlPreview {
  kind: 'url_preview'
  url: string
  finalUrl: string
  status: number
  contentType: string
  title?: string
  description?: string
  excerpt?: string
}

export function AgentView({ session, status, initialPrompt, canApprove, onChanged }: {
  session: AgentSession
  status: AgentStatus
  initialPrompt?: string | undefined
  canApprove: boolean
  onChanged: () => Promise<void>
}) {
  const [initial, setInitial] = useState<UIMessage[]>([])
  const [input, setInput] = useState(initialPrompt ?? '')
  const [historyError, setHistoryError] = useState<string>()

  useEffect(() => {
    let active = true
    sessionMessages(session.id).then((messages) => { if (active) setInitial(messages) }).catch((cause) => {
      if (active) setHistoryError(cause instanceof Error ? cause.message : 'Unable to load session history')
    })
    return () => { active = false }
  }, [session.id])

  return <Chat key={`${session.id}:${initial.length}`} session={session} status={status} initial={initial} input={input} setInput={setInput} historyError={historyError} canApprove={canApprove} onChanged={onChanged} />
}

function Chat({ session, status, initial, input, setInput, historyError, canApprove, onChanged }: {
  session: AgentSession
  status: AgentStatus
  initial: UIMessage[]
  input: string
  setInput: (value: string) => void
  historyError: string | undefined
  canApprove: boolean
  onChanged: () => Promise<void>
}) {
  const transport = useMemo(() => new DefaultChatTransport<UIMessage>({
    api: '/api/agent/chat', credentials: 'same-origin',
    prepareSendMessagesRequest: ({ messages, trigger }) => ({ body: { threadId: session.id, messages, trigger } }),
  }), [session.id])
  const { messages, sendMessage, status: chatStatus, error, stop } = useChat({ id: session.id, messages: initial, transport })
  const working = chatStatus === 'submitted' || chatStatus === 'streaming'

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const text = input.trim()
    if (!text || working || !status.agentReady) return
    setInput('')
    await sendMessage({ text })
    await onChanged()
  }

  return <div className="agent-surface">
    <div className="agent-session-head"><div><p className="eyebrow">DURABLE SESSION</p><h2>{session.title}</h2></div><div className="agent-badges"><Badge>{status.mode.toUpperCase()}</Badge><Badge className={status.durable ? 'status-good' : ''}>{status.durable ? 'DURABLE' : 'OFFLINE'}</Badge></div></div>
    {!status.agentReady && <Alert className="agent-config-alert"><strong>Agent model not configured</strong><span>Open <a href="/portal/models">Models</a> to configure an approved gateway. Legacy <code>PAPYRUS_AGENT_MODEL</code> values are imported once as a bootstrap fallback.</span></Alert>}
    {historyError && <Alert className="error">{historyError}</Alert>}
    <div className="message-list" aria-live="polite">
      {messages.length === 0 && <Welcome />}
      {messages.map((message) => <Message key={message.id} message={message} sessionId={session.id} canApprove={canApprove} onChanged={onChanged} />)}
      {working && <div className="agent-thinking"><span /><span /><span /> Papyrus is working</div>}
      {error && <Alert className="error">{error.message}</Alert>}
    </div>
    <form className="composer" onSubmit={(event) => void submit(event)}>
      <Textarea value={input} onChange={(event) => setInput(event.target.value)} disabled={!status.agentReady} placeholder="Ask Papyrus to investigate, connect a plugin, run a workflow, or preview a URL…" onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit() }
      }} />
      <div><small>Secrets never enter the conversation.</small>{working ? <Button type="button" onClick={() => void stop()}>Stop</Button> : <Button className="primary" disabled={!input.trim() || !status.agentReady}>Send ↑</Button>}</div>
    </form>
  </div>
}

function Welcome() {
  return <div className="agent-welcome"><span className="agent-orbit">✦</span><p className="eyebrow">PAPYRUS RUNTIME</p><h2>What should the population work on?</h2><p>Start a task, connect an operational plugin, inspect a URL, or schedule recurring work. Starlings handles collective reasoning; Mastra makes the session durable and event-driven.</p><div className="prompt-chips"><span>Connect Exchange Email</span><span>Preview a URL</span><span>Create a daily briefing</span></div></div>
}

function Message({ message, sessionId, canApprove, onChanged }: { message: UIMessage; sessionId: string; canApprove: boolean; onChanged: () => Promise<void> }) {
  return <article className={`chat-message ${message.role}`}><div className="message-author">{message.role === 'user' ? 'YOU' : 'PAPYRUS'}</div><div className="message-body">{message.parts.map((part, index) => <MessagePart key={`${part.type}:${index}`} part={part as unknown as Record<string, unknown>} sessionId={sessionId} canApprove={canApprove} onChanged={onChanged} />)}</div></article>
}

function MessagePart({ part, sessionId, canApprove, onChanged }: { part: Record<string, unknown>; sessionId: string; canApprove: boolean; onChanged: () => Promise<void> }) {
  if (part['type'] === 'text') return <p className="message-text">{String(part['text'] ?? '')}</p>
  if (part['type'] === 'source-url') return <a className="source-link" href={String(part['url'])} target="_blank" rel="noreferrer">{String(part['title'] ?? part['url'])} ↗</a>
  const type = String(part['type'] ?? '')
  if (type === 'dynamic-tool' || type.startsWith('tool-')) {
    const output = part['output'] as Record<string, unknown> | undefined
    if (output?.['kind'] === 'plugin_connection_request') return <PluginConnectionCard request={output as unknown as PluginRequest} onChanged={onChanged} />
    if (output?.['kind'] === 'model_gateway_request') return <ModelGatewayCard request={output as unknown as ModelGatewayRequest} onChanged={onChanged} />
    if (output?.['kind'] === 'url_preview') return <UrlPreviewCard preview={output as unknown as UrlPreview} />
    if (output?.['kind'] === 'action_suggestion') return <ActionSuggestionCard suggestion={output} sessionId={sessionId} canApprove={canApprove} onChanged={onChanged} />
    const name = type === 'dynamic-tool' ? String(part['toolName'] ?? 'tool') : type.slice(5)
    const state = String(part['state'] ?? 'running')
    return <Card className="tool-card"><div><span className="tool-icon">⌁</span><strong>{humanize(name)}</strong></div><Badge>{humanize(state)}</Badge>{state === 'output-error' && <p>{String(part['errorText'] ?? 'Tool failed')}</p>}</Card>
  }
  return null
}

function ActionSuggestionCard({ suggestion, sessionId, canApprove, onChanged }: { suggestion: Record<string, unknown>; sessionId: string; canApprove: boolean; onChanged: () => Promise<void> }) {
  const [proposalId, setProposalId] = useState<string>()
  const [status, setStatus] = useState<'suggested' | 'saving' | 'proposed' | 'approved' | 'denied'>('suggested')
  const [error, setError] = useState<string>()
  useEffect(() => { void setSessionAttention(sessionId, true).then(onChanged).catch(() => undefined) }, [sessionId, onChanged])
  const propose = async () => {
    setStatus('saving'); setError(undefined)
    try {
      const proposal = await createSessionProposal(sessionId, {
        executorIntegrationId: String(suggestion['executorIntegrationId'] ?? ''), action: String(suggestion['action'] ?? ''), target: String(suggestion['target'] ?? ''),
        rationaleClaimIds: Array.isArray(suggestion['rationaleClaimIds']) ? suggestion['rationaleClaimIds'].filter((value): value is string => typeof value === 'string') : [],
        ...(suggestion['parameters'] && typeof suggestion['parameters'] === 'object' && !Array.isArray(suggestion['parameters']) ? { parameters: suggestion['parameters'] as Record<string, unknown> } : {}),
      })
      setProposalId(proposal.id); setStatus('proposed'); await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to create proposal'); setStatus('suggested') }
  }
  const decide = async (approved: boolean) => {
    if (!proposalId) return
    try {
      if (approved) { await approveProposal(proposalId); setStatus('approved') } else { await denyProposal(proposalId); setStatus('denied') }
      await setSessionAttention(sessionId, false); await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to record decision') }
  }
  return <Card className="action-suggestion"><div className="action-suggestion-head"><span className="attention-icon">!</span><div><p className="eyebrow">ACTION SUGGESTION</p><h3>{String(suggestion['action'] ?? 'Proposed action')}</h3></div><Badge>{status}</Badge></div><dl><div><dt>Target</dt><dd>{String(suggestion['target'] ?? '—')}</dd></div><div><dt>Executor</dt><dd>{String(suggestion['executorIntegrationId'] ?? '—')}</dd></div></dl><p>{String(suggestion['rationale'] ?? '')}</p>{error && <Alert className="error">{error}</Alert>}<div className="proposal-controls">{status === 'suggested' && <Button className="primary" onClick={() => void propose()}>Submit for approval</Button>}{status === 'saving' && <Button disabled>Recording…</Button>}{status === 'proposed' && canApprove && <><Button className="primary" onClick={() => void decide(true)}>Approve and queue</Button><Button variant="ghost" onClick={() => void decide(false)}>Deny</Button></>}{status === 'proposed' && !canApprove && <small>Waiting for a Papyrus.Action.Approve operator.</small>}</div></Card>
}

function PluginConnectionCard({ request, onChanged }: { request: PluginRequest; onChanged: () => Promise<void> }) {
  const [state, setState] = useState<'ready' | 'saving' | 'connected'>('ready')
  const [error, setError] = useState<string>()
  const [webhook, setWebhook] = useState<{ endpoint: string; token: string }>()
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setState('saving'); setError(undefined)
    const form = new FormData(event.currentTarget)
    const settings: Record<string, string> = {}
    for (const field of request.fields) if (!['name', 'scope', 'endpoint', 'credentialRef'].includes(field.name)) settings[field.name] = String(form.get(field.name) ?? '')
    try {
      const connected = await connectPlugin({
        catalogId: request.catalogId, name: String(form.get('name') ?? request.name), scope: String(form.get('scope') ?? 'daemon'), settings,
        ...(form.get('endpoint') ? { endpoint: String(form.get('endpoint')) } : {}),
        ...(form.get('credentialRef') ? { credentialRef: String(form.get('credentialRef')) } : {}),
      })
      const plugin = connected.plugin
      if (request.acceptsSignals && plugin.state === 'active') {
        const issued = await issueIngestionToken(plugin.id)
        setWebhook({ endpoint: `${window.location.origin}/api/signals/${plugin.id}/webhook`, token: issued.token })
      }
      setState('connected'); await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to connect plugin'); setState('ready') }
  }
  if (state === 'connected') return <Card className="plugin-tool-card connected"><span className="tool-icon">✓</span><div><strong>{request.name} connected</strong><p>The daemon validated and activated the plugin under your Entra authority.</p>{webhook && <div className="webhook-command"><small>Push any JSON event into this agent’s durable signal session:</small><pre>{`curl --fail-with-body -X POST \\\n  -H 'Authorization: Bearer ${webhook.token}' \\\n  -H 'Content-Type: application/json' \\\n  '${webhook.endpoint}' \\\n  --data '{"kind":"event","summary":"Describe what changed"}'`}</pre><Button type="button" onClick={() => void navigator.clipboard.writeText(`curl --fail-with-body -X POST -H 'Authorization: Bearer ${webhook.token}' -H 'Content-Type: application/json' '${webhook.endpoint}' --data '{"kind":"event","summary":"Describe what changed"}'`)}>Copy command</Button></div>}</div></Card>
  return <Card className="plugin-tool-card"><div className="plugin-tool-head"><div><p className="eyebrow">SECURE PLUGIN SETUP</p><h3>{request.name}</h3></div><Badge className={`risk-${request.risk}`}>{request.authority.replaceAll('_', ' ')}</Badge></div><p>{request.description}</p><form onSubmit={(event) => void submit(event)}><div className="agent-form-grid">{request.fields.map((field) => <Label key={field.name}>{field.label}{field.kind === 'select'
      ? <NativeSelect name={field.name} required={field.required}>{field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</NativeSelect>
      : <Input name={field.name} type={field.kind === 'credential_reference' ? 'password' : field.kind} required={field.required} defaultValue={field.name === 'name' ? request.name : undefined} placeholder={field.placeholder} autoComplete={field.kind === 'credential_reference' ? 'off' : undefined} />}{field.help && <small>{field.help}</small>}</Label>)}</div>{error && <Alert className="error">{error}</Alert>}<div className="plugin-tool-foot"><small>{request.note}</small><Button className="primary" disabled={state === 'saving'}>{state === 'saving' ? 'Connecting…' : 'Connect plugin'}</Button></div></form></Card>
}

function UrlPreviewCard({ preview }: { preview: UrlPreview }) {
  let host = preview.finalUrl
  try { host = new URL(preview.finalUrl).hostname } catch { /* keep URL */ }
  return <a className="url-preview" href={preview.finalUrl} target="_blank" rel="noreferrer"><div className="url-preview-status"><span>{host}</span><Badge>{preview.status}</Badge></div><h3>{preview.title ?? preview.finalUrl}</h3>{preview.description && <p>{preview.description}</p>}{preview.excerpt && <small>{preview.excerpt}</small>}<span className="url-preview-open">Open URL ↗</span></a>
}

function humanize(value: string): string { return value.replaceAll('_', ' ').replace(/([a-z])([A-Z])/g, '$1 $2') }
