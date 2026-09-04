import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, type UIMessage } from 'ai'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { AgentSession, AgentStatus, WorkspaceLibraryFile } from './api.js'
import { approveProposal, approveSkill, connectPlugin, createSessionProposal, denyProposal, issueIngestionToken, sessionMessages, setSessionAttention, uploadWorkspaceAttachment, workspaceFiles } from './api.js'
import { ModelGatewayCard } from './Models.js'
import { Alert, Badge, Button, Card, Input, Label, NativeSelect, Skeleton } from './components/ui/index.js'
import { MarkdownMessage } from './Markdown.js'

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
  siteName?: string
  type?: string
  image?: string
  imageAlt?: string
  favicon?: string
}

interface ArtifactOutput {
  kind: 'artifact'
  id: string
  name: string
  mediaType: string
  size: number
  sha256: string
  createdAt: string
  contentUrl: string
  downloadUrl: string
  preview: {
    kind: 'pdf' | 'document' | 'spreadsheet' | 'video' | 'image' | 'text' | 'generic'
    text?: string
    sheets?: Array<{ name: string; rows: Array<Array<string | number | boolean | null>> }>
  }
  provenance: { producer: string; skill?: string; skillVersion?: string }
}

interface SkillDraftOutput {
  kind: 'skill_draft'
  skill: {
    id: string
    name: string
    version: string
    description: string
    requestedCapabilities: string[]
    trust: string
    state: string
  }
}

export function AgentView({ session, status, initialPrompt, canApprove, canManageSkills, onChanged }: {
  session: AgentSession
  status: AgentStatus
  initialPrompt?: string | undefined
  canApprove: boolean
  canManageSkills: boolean
  onChanged: () => Promise<void>
}) {
  const [initial, setInitial] = useState<UIMessage[]>([])
  const [input, setInput] = useState(initialPrompt ?? '')
  const [historyError, setHistoryError] = useState<string>()
  const [historyLoading, setHistoryLoading] = useState(true)

  useEffect(() => {
    let active = true
    setHistoryLoading(true)
    setHistoryError(undefined)
    sessionMessages(session.id).then((messages) => {
      if (active) setInitial(messages)
    }).catch((cause) => {
      if (active) setHistoryError(cause instanceof Error ? cause.message : 'Unable to load session history')
    }).finally(() => {
      if (active) setHistoryLoading(false)
    })
    return () => { active = false }
  }, [session.id])

  return <Chat key={`${session.id}:${initial.length}`} session={session} status={status} initial={initial} input={input} setInput={setInput} historyError={historyError} historyLoading={historyLoading} canApprove={canApprove} canManageSkills={canManageSkills} onChanged={onChanged} />
}

function Chat({ session, status, initial, input, setInput, historyError, historyLoading, canApprove, canManageSkills, onChanged }: {
  session: AgentSession
  status: AgentStatus
  initial: UIMessage[]
  input: string
  setInput: (value: string) => void
  historyError: string | undefined
  historyLoading: boolean
  canApprove: boolean
  canManageSkills: boolean
  onChanged: () => Promise<void>
}) {
  const [attachments, setAttachments] = useState<WorkspaceLibraryFile[]>([])
  const attachmentRef = useRef<WorkspaceLibraryFile[]>([])
  const messageListRef = useRef<HTMLDivElement>(null)
  const composerLayerRef = useRef<HTMLDivElement>(null)
  const followLatestRef = useRef(true)
  const transport = useMemo(() => new DefaultChatTransport<UIMessage>({
    api: '/api/agent/chat',
    credentials: 'same-origin',
    prepareSendMessagesRequest: ({ messages, trigger }) => ({
      body: {
        threadId: session.id,
        messages,
        trigger,
        attachments: attachmentRef.current.map((file) => ({ path: file.path })),
      },
    }),
  }), [session.id])
  const { messages, sendMessage, status: chatStatus, error, stop } = useChat({ id: session.id, messages: initial, transport })
  const working = chatStatus === 'submitted' || chatStatus === 'streaming'

  useEffect(() => {
    if (!followLatestRef.current) return
    const frame = window.requestAnimationFrame(() => {
      const list = messageListRef.current
      if (list) list.scrollTop = list.scrollHeight
    })
    return () => window.cancelAnimationFrame(frame)
  }, [messages, working, error, historyLoading])

  useEffect(() => {
    const layer = composerLayerRef.current
    if (!layer) return
    const surface = layer.parentElement
    if (!surface) return

    const updateClearance = () => {
      surface.style.setProperty('--composer-clearance', `${Math.ceil(layer.getBoundingClientRect().height)}px`)
    }
    updateClearance()

    const observer = new ResizeObserver(updateClearance)
    observer.observe(layer)
    return () => {
      observer.disconnect()
      surface.style.removeProperty('--composer-clearance')
    }
  }, [])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const text = input.trim()
    if ((!text && attachments.length === 0) || working || !status.agentReady) return
    followLatestRef.current = true
    attachmentRef.current = attachments
    const messageText = text || `Review the attached ${attachments.length === 1 ? 'file' : 'files'}.`
    setInput('')
    setAttachments([])
    await sendMessage({ text: messageText })
    attachmentRef.current = []
    await onChanged()
  }

  return <div className="agent-surface">
    <div className="agent-session-head"><div><p className="eyebrow">DURABLE SESSION</p><h2>{session.title}</h2></div><div className="agent-badges"><Badge>{status.mode.toUpperCase()}</Badge><Badge className={status.durable ? 'status-good' : ''}>{status.durable ? 'DURABLE' : 'OFFLINE'}</Badge></div></div>
    {!status.agentReady && <Alert className="agent-config-alert"><strong>Agent model not configured</strong><span>Open <a href="/portal/models">Models</a> to configure an approved gateway using the first-run form. Chat unlocks after the daemon has a tested model profile.</span></Alert>}
    {historyError && <Alert className="error">{historyError}</Alert>}
    <div
      ref={messageListRef}
      className="message-list"
      aria-live="polite"
      onScroll={(event) => { followLatestRef.current = isNearScrollBottom(event.currentTarget) }}
    >
      {historyLoading && messages.length === 0 && <MessageSkeleton />}
      {!historyLoading && messages.length === 0 && <Welcome />}
      {messages.map((message) => <Message key={message.id} message={message} sessionId={session.id} canApprove={canApprove} canManageSkills={canManageSkills} onChanged={onChanged} />)}
      {working && <div className="agent-thinking"><span /><span /><span /> Papyrus is working</div>}
      {error && <Alert className="error">{error.message}</Alert>}
    </div>
    <div ref={composerLayerRef} className="composer-layer">
      <Composer
        input={input}
        setInput={setInput}
        attachments={attachments}
        setAttachments={setAttachments}
        disabled={!status.agentReady}
        working={working}
        onStop={() => void stop()}
        onSubmit={(event) => void submit(event)}
        workspace={status.workspace}
      />
    </div>
  </div>
}

export function Composer({ input, setInput, attachments, setAttachments, disabled, working, onStop, onSubmit, workspace }: {
  input: string
  setInput: (value: string) => void
  attachments: WorkspaceLibraryFile[]
  setAttachments: (value: WorkspaceLibraryFile[] | ((current: WorkspaceLibraryFile[]) => WorkspaceLibraryFile[])) => void
  disabled: boolean
  working: boolean
  onStop: () => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  workspace: AgentStatus['workspace']
}) {
  const fileInput = useRef<HTMLInputElement>(null)
  const [dragActive, setDragActive] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [libraryQuery, setLibraryQuery] = useState('')
  const [results, setResults] = useState<WorkspaceLibraryFile[]>([])
  const [loading, setLoading] = useState(false)
  const [attachmentError, setAttachmentError] = useState<string>()
  const mention = mentionQuery(input)

  useEffect(() => {
    if (!libraryOpen && mention === undefined) return
    let active = true
    const query = libraryOpen ? libraryQuery : mention ?? ''
    const timeout = window.setTimeout(() => {
      setLoading(true)
      workspaceFiles(query).then((files) => {
        if (active) setResults(files)
      }).catch((cause) => {
        if (active) setAttachmentError(cause instanceof Error ? cause.message : 'Unable to read the workspace library')
      }).finally(() => { if (active) setLoading(false) })
    }, mention !== undefined && !libraryOpen ? 120 : 0)
    return () => { active = false; window.clearTimeout(timeout) }
  }, [libraryOpen, libraryQuery, mention])

  const attach = (file: WorkspaceLibraryFile, fromMention = false) => {
    setAttachments((current) => current.some((item) => item.path === file.path) ? current : [...current, file].slice(0, 12))
    if (fromMention && mention !== undefined) {
      const match = /(?:^|\s)@[^\s@]*$/.exec(input)
      if (match) {
        const at = input.lastIndexOf('@', match.index + match[0].length)
        setInput(`${input.slice(0, at)}@${file.name} `)
      }
    }
    setLibraryOpen(false)
  }

  const upload = async (files: FileList | null) => {
    if (!files?.length) return
    setAttachmentError(undefined)
    setLoading(true)
    try {
      for (const file of Array.from(files).slice(0, Math.max(0, 12 - attachments.length))) {
        if (file.size > 8 * 1024 * 1024) throw new Error(`${file.name} exceeds the 8 MiB attachment limit`)
        const saved = await uploadWorkspaceAttachment({
          name: file.name,
          ...(file.type ? { mediaType: file.type } : {}),
          dataBase64: await fileBase64(file),
        })
        setAttachments((current) => current.some((item) => item.path === saved.path) ? current : [...current, saved].slice(0, 12))
      }
    } catch (cause) {
      setAttachmentError(cause instanceof Error ? cause.message : 'Unable to attach file')
    } finally {
      setLoading(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  const showMention = mention !== undefined && !libraryOpen

  return <form
    className={`composer${dragActive ? ' drag-active' : ''}`}
    onSubmit={onSubmit}
    onDragEnter={(event) => { event.preventDefault(); if (!disabled) setDragActive(true) }}
    onDragOver={(event) => { event.preventDefault(); if (!disabled) setDragActive(true) }}
    onDragLeave={(event) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
      setDragActive(false)
    }}
    onDrop={(event) => {
      event.preventDefault()
      setDragActive(false)
      if (!disabled) void upload(event.dataTransfer.files)
    }}
  >
    {attachments.length > 0 && <div className="composer-attachments">{attachments.map((file) => <span className="composer-attachment-chip" key={file.path}><span>▤</span><span><strong>{file.name}</strong><small>{formatBytes(file.size)} · AgentFS</small></span><button type="button" aria-label={`Remove ${file.name}`} onClick={() => setAttachments((current) => current.filter((item) => item.path !== file.path))}>×</button></span>)}</div>}
    <div className="composer-input-row">
      <Input
        className="composer-prompt-input"
        value={input}
        onChange={(event) => setInput(event.target.value)}
        disabled={disabled}
        autoComplete="off"
        placeholder="Ask Papyrus… Type @ to attach from Library."
        onKeyDown={(event) => {
          if (event.key === 'Escape') setLibraryOpen(false)
        }}
      />
      {working
        ? <Button className="composer-send-circle" size="icon" type="button" aria-label="Stop generation" onClick={onStop}>■</Button>
        : <Button className="primary composer-send-circle" size="icon" type="submit" aria-label="Send message" disabled={disabled || (!input.trim() && attachments.length === 0)}>↑</Button>}
      {showMention && <LibraryResults files={results} query={mention ?? ''} loading={loading} label="ATTACH FROM LIBRARY" onSelect={(file) => attach(file, true)} />}
    </div>
    <div className="composer-toolbar">
      <div className="composer-tools">
        <Button variant="neutral" className="composer-tool-button" type="button" disabled={disabled || loading} onClick={() => fileInput.current?.click()}>
          <span className="composer-tool-icon">＋</span><span>Upload</span>
        </Button>
        <Button variant="neutral" className="composer-tool-button" type="button" disabled={disabled} onClick={() => { setLibraryOpen(true); setLibraryQuery('') }}>
          <span className="composer-tool-icon">▤</span><span>Library</span>
        </Button>
        <input ref={fileInput} className="composer-file-input" type="file" multiple onChange={(event) => void upload(event.currentTarget.files)} />
        <span className="composer-workspace-state"><span className="status-dot" />{workspace ? `AgentFS · Enclave STRICT · nono-ts ${workspace.isolation}` : 'Local workspace'}</span>
      </div>
    </div>
    {libraryOpen && <div className="library-picker">
      <div className="library-picker-head"><div><p className="eyebrow">AGENTFS LIBRARY</p><strong>Attach workspace context</strong></div><button type="button" onClick={() => setLibraryOpen(false)}>×</button></div>
      <Input autoFocus value={libraryQuery} onChange={(event) => setLibraryQuery(event.target.value)} placeholder="Search files…" />
      <LibraryResults files={results} query={libraryQuery} loading={loading} label="" onSelect={(file) => attach(file)} embedded />
    </div>}
    {attachmentError && <Alert className="error composer-error">{attachmentError}</Alert>}
    {dragActive && <div className="composer-drop-target"><span>＋</span><strong>Drop files to attach</strong><small>Files are stored in the local AgentFS Library.</small></div>}
  </form>
}

function LibraryResults({ files, query, loading, label, onSelect, embedded = false }: {
  files: WorkspaceLibraryFile[]
  query: string
  loading: boolean
  label: string
  onSelect: (file: WorkspaceLibraryFile) => void
  embedded?: boolean
}) {
  return <div className={embedded ? 'library-results embedded' : 'library-results'}>
    {label && <p className="eyebrow">{label}</p>}
    {loading && <div className="library-loading"><Skeleton /><Skeleton /><Skeleton /></div>}
    {!loading && files.length === 0 && <small className="library-empty">{query ? `No files matching “${query}”` : 'No files in Library yet.'}</small>}
    {!loading && files.slice(0, 10).map((file) => <button type="button" key={file.path} onClick={() => onSelect(file)}><span className="library-file-icon">{fileIcon(file.mediaType)}</span><span><strong>{file.name}</strong><small>{file.path} · {formatBytes(file.size)}</small></span><span className="library-attach-hint">Attach</span></button>)}
  </div>
}

function MessageSkeleton() {
  return <div className="message-skeleton" aria-label="Loading session history">
    <div><Skeleton className="skeleton-author" /><div><Skeleton className="skeleton-line wide" /><Skeleton className="skeleton-line" /><Skeleton className="skeleton-line short" /></div></div>
    <div><Skeleton className="skeleton-author" /><div><Skeleton className="skeleton-line wide" /><Skeleton className="skeleton-line short" /></div></div>
  </div>
}

function Welcome() {
  return <div className="agent-welcome"><span className="agent-orbit">✦</span><p className="eyebrow">PAPYRUS RUNTIME</p><h2>What should the population work on?</h2><p>Start a task, create a durable artifact, connect an operational plugin, or schedule recurring work. Starlings handles collective reasoning; Mastra makes the session durable and event-driven.</p><div className="prompt-chips"><span>Create a PDF briefing</span><span>Build an XLSX risk register</span><span>Create a reusable skill</span></div></div>
}

function Message({ message, sessionId, canApprove, canManageSkills, onChanged }: { message: UIMessage; sessionId: string; canApprove: boolean; canManageSkills: boolean; onChanged: () => Promise<void> }) {
  return <article className={`chat-message ${message.role}`}><div className="message-author">{message.role === 'user' ? 'YOU' : 'PAPYRUS'}</div><div className="message-body">{message.parts.map((part, index) => <MessagePart key={`${part.type}:${index}`} part={part as unknown as Record<string, unknown>} sessionId={sessionId} canApprove={canApprove} canManageSkills={canManageSkills} onChanged={onChanged} />)}</div></article>
}

function MessagePart({ part, sessionId, canApprove, canManageSkills, onChanged }: { part: Record<string, unknown>; sessionId: string; canApprove: boolean; canManageSkills: boolean; onChanged: () => Promise<void> }) {
  if (part['type'] === 'text') return <MarkdownMessage>{String(part['text'] ?? '')}</MarkdownMessage>
  if (part['type'] === 'source-url') return <a className="source-link" href={String(part['url'])} target="_blank" rel="noreferrer">{String(part['title'] ?? part['url'])} ↗</a>
  const type = String(part['type'] ?? '')
  if (type === 'dynamic-tool' || type.startsWith('tool-')) {
    const output = part['output'] as Record<string, unknown> | undefined
    if (output?.['kind'] === 'plugin_connection_request') return <PluginConnectionCard request={output as unknown as PluginRequest} onChanged={onChanged} />
    if (output?.['kind'] === 'model_gateway_request') return <ModelGatewayCard request={output as unknown as ModelGatewayRequest} onChanged={onChanged} />
    if (output?.['kind'] === 'url_preview') return <UrlPreviewCard preview={output as unknown as UrlPreview} />
    if (output?.['kind'] === 'action_suggestion') return <ActionSuggestionCard suggestion={output} sessionId={sessionId} canApprove={canApprove} onChanged={onChanged} />
    if (output?.['kind'] === 'artifact') return <ArtifactCard artifact={output as unknown as ArtifactOutput} />
    if (output?.['kind'] === 'skill_draft') return <SkillDraftCard output={output as unknown as SkillDraftOutput} canManage={canManageSkills} onChanged={onChanged} />
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
  const image = preview.image ? previewAssetUrl(preview.image) : undefined
  const favicon = preview.favicon ? previewAssetUrl(preview.favicon) : undefined
  return <article className={`url-preview ${image ? 'with-image' : ''}`}>
    {image && <a className="url-preview-hero" href={preview.finalUrl} target="_blank" rel="noreferrer"><img src={image} alt={preview.imageAlt ?? ''} loading="lazy" /></a>}
    <div className="url-preview-body">
      <div className="url-preview-status">
        <span className="url-preview-site">{favicon && <img src={favicon} alt="" />}<span><strong>{preview.siteName ?? host}</strong><small>{host}{preview.type ? ` · ${preview.type}` : ''}</small></span></span>
        <Badge>{preview.status}</Badge>
      </div>
      <h3><a href={preview.finalUrl} target="_blank" rel="noreferrer">{preview.title ?? preview.finalUrl}</a></h3>
      {preview.description && <p>{preview.description}</p>}
      {preview.excerpt && preview.excerpt !== preview.description && <small className="url-preview-excerpt">{preview.excerpt}</small>}
      <a className="url-preview-open" href={preview.finalUrl} target="_blank" rel="noreferrer">Open URL ↗</a>
    </div>
  </article>
}


function ArtifactCard({ artifact }: { artifact: ArtifactOutput }) {
  const [sheetIndex, setSheetIndex] = useState(0)
  const sheets = artifact.preview.sheets ?? []
  const selectedSheet = sheets[Math.min(sheetIndex, Math.max(0, sheets.length - 1))]
  return <Card className="artifact-card">
    <div className="artifact-head">
      <span className="artifact-icon">{artifact.preview.kind === 'spreadsheet' ? '▦' : artifact.preview.kind === 'video' ? '▶' : artifact.preview.kind === 'image' ? '▧' : '▤'}</span>
      <div><p className="eyebrow">DURABLE ARTIFACT</p><h3>{artifact.name}</h3><small>{artifact.mediaType} · {formatBytes(artifact.size)}</small></div>
      <Badge>{artifact.preview.kind}</Badge>
    </div>
    {artifact.preview.kind === 'pdf' && <iframe className="artifact-pdf-preview" src={artifact.contentUrl} title={`Preview ${artifact.name}`} />}
    {artifact.preview.kind === 'video' && <video className="artifact-video-preview" controls src={artifact.contentUrl} />}
    {artifact.preview.kind === 'image' && <img className="artifact-image-preview" src={artifact.contentUrl} alt={artifact.name} />}
    {artifact.preview.kind === 'document' && artifact.preview.text && <div className="artifact-document-preview">{artifact.preview.text.slice(0, 1800)}</div>}
    {artifact.preview.kind === 'text' && artifact.preview.text && <pre className="artifact-text-preview">{artifact.preview.text}</pre>}
    {artifact.preview.kind === 'spreadsheet' && sheets.length > 0 && <div className="artifact-sheet-preview">
      {sheets.length > 1 && <div className="artifact-sheet-tabs">{sheets.map((sheet, index) => <button key={sheet.name} type="button" className={index === sheetIndex ? 'active' : ''} onClick={() => setSheetIndex(index)}>{sheet.name}</button>)}</div>}
      {selectedSheet && <div className="artifact-sheet-table"><table><tbody>{selectedSheet.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => rowIndex === 0 ? <th key={cellIndex}>{String(cell ?? '')}</th> : <td key={cellIndex}>{String(cell ?? '')}</td>)}</tr>)}</tbody></table></div>}
    </div>}
    <div className="artifact-actions">
      <span className="artifact-hash">SHA-256 {artifact.sha256.slice(0, 12)}…{artifact.provenance.skill ? ` · ${artifact.provenance.skill}@${artifact.provenance.skillVersion ?? 'current'}` : ''}</span>
      <div><a className="nb-button" href={artifact.contentUrl} target="_blank" rel="noreferrer">Open ↗</a><a className="nb-button primary" href={artifact.downloadUrl}>Download</a></div>
    </div>
  </Card>
}

function SkillDraftCard({ output, canManage, onChanged }: { output: SkillDraftOutput; canManage: boolean; onChanged: () => Promise<void> }) {
  const [state, setState] = useState<'draft' | 'approving' | 'enabled'>(output.skill.state === 'enabled' ? 'enabled' : 'draft')
  const [error, setError] = useState<string>()
  const approve = async () => {
    setState('approving'); setError(undefined)
    try { await approveSkill(output.skill.id); setState('enabled'); await onChanged() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to approve skill'); setState('draft') }
  }
  return <Card className="skill-draft-card">
    <div className="skill-draft-head"><span className="artifact-icon">◇</span><div><p className="eyebrow">SKILL DRAFT</p><h3>{output.skill.name} <small>v{output.skill.version}</small></h3></div><Badge>{state}</Badge></div>
    <p>{output.skill.description}</p>
    <div className="skill-capabilities">{output.skill.requestedCapabilities.length ? output.skill.requestedCapabilities.map((capability) => <Badge key={capability}>{capability}</Badge>) : <small>No additional capabilities requested.</small>}</div>
    <p className="skill-trust-note">This draft is inert. Requested capabilities do not grant authority; Papyrus only exposes tools already allowed by deployment policy.</p>
    {error && <Alert className="error">{error}</Alert>}
    <div className="proposal-controls">{state === 'enabled' ? <Badge className="status-good">ENABLED</Badge> : canManage ? <Button className="primary" disabled={state === 'approving'} onClick={() => void approve()}>{state === 'approving' ? 'Approving…' : 'Approve & enable'}</Button> : <small>A Papyrus.System.Owner must approve this skill.</small>}</div>
  </Card>
}

export function isNearScrollBottom(element: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>, threshold = 96): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function mentionQuery(value: string): string | undefined {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(value)
  return match ? match[1] ?? '' : undefined
}

function fileBase64(file: File): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read attachment'))
    reader.onload = () => {
      const value = String(reader.result ?? '')
      const comma = value.indexOf(',')
      if (comma < 0) return reject(new Error('Unable to encode attachment'))
      resolvePromise(value.slice(comma + 1))
    }
    reader.readAsDataURL(file)
  })
}

function fileIcon(mediaType: string): string {
  if (mediaType.includes('pdf')) return 'PDF'
  if (mediaType.includes('spreadsheet') || mediaType.includes('csv')) return 'XLS'
  if (mediaType.includes('wordprocessing') || mediaType.includes('text')) return 'DOC'
  if (mediaType.startsWith('image/')) return 'IMG'
  if (mediaType.startsWith('video/')) return 'VID'
  return 'FILE'
}

function previewAssetUrl(url: string): string {
  return `/api/url-preview/image?url=${encodeURIComponent(url)}`
}

function humanize(value: string): string { return value.replaceAll('_', ' ').replace(/([a-z])([A-Z])/g, '$1 $2') }
