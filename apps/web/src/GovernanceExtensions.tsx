import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import type { AgentActionProposal, AgentLink, PortalPrincipal } from '@papyrus/contracts'
import { api, approveProposal, denyProposal, listLinks, listProposals } from './api.js'
import { Alert, Badge, Button, Card, Input } from './components/ui/index.js'

interface ExecutorSummary {
  id: string
  name: string
  catalogId: string
  authority: string
  risk: string
  state: string
  health: string
}

interface LinkExecutorCondition {
  path: string
  equals: string | number | boolean | null
}

interface LinkExecutorAttachment {
  id: string
  linkId: string
  executorIntegrationId: string
  action: string
  target: string
  enabled: boolean
  invocationMode: 'agent_decides' | 'always' | 'conditional'
  condition?: LinkExecutorCondition
  inputMapping: Record<string, string>
  approvalMode: 'inherit' | 'required'
  maxRetries: number
  createdAt: string
  updatedAt: string
}

interface LinkExecutorData {
  link: AgentLink
  attachments: LinkExecutorAttachment[]
  executors: ExecutorSummary[]
}

/**
 * Cross-surface governance UI deliberately lives outside the Agent component.
 * Sessions may request work, but approvals are workspace state and remain usable
 * after the originating session is gone or an external webhook has no session.
 */
export function GovernanceExtensions() {
  const [path, setPath] = useState(() => window.location.pathname)
  const [targetRevision, setTargetRevision] = useState(0)

  useEffect(() => {
    const navigation = () => setPath(window.location.pathname)
    window.addEventListener('popstate', navigation)
    window.addEventListener('papyrus:navigation', navigation)

    const originalPush = history.pushState.bind(history)
    const originalReplace = history.replaceState.bind(history)
    history.pushState = ((...args: Parameters<History['pushState']>) => {
      originalPush(...args)
      window.dispatchEvent(new Event('papyrus:navigation'))
    }) as History['pushState']
    history.replaceState = ((...args: Parameters<History['replaceState']>) => {
      originalReplace(...args)
      window.dispatchEvent(new Event('papyrus:navigation'))
    }) as History['replaceState']

    const observer = new MutationObserver(() => {
      setTargetRevision((value) => value + 1)
      projectSessionApprovalLinks()
    })
    observer.observe(document.body, { childList: true, subtree: true })
    projectSessionApprovalLinks()

    return () => {
      window.removeEventListener('popstate', navigation)
      window.removeEventListener('papyrus:navigation', navigation)
      history.pushState = originalPush
      history.replaceState = originalReplace
      observer.disconnect()
    }
  }, [])

  const portalMain = useMemo(() => document.querySelector<HTMLElement>('.portal-main'), [path, targetRevision])
  const governance = useMemo(() => document.querySelector<HTMLElement>('.governance-surface'), [path, targetRevision])

  return <>
    {path === '/portal/governance' && governance && createPortal(<ApprovalsPanel />, governance)}
    {path === '/portal/links' && portalMain && createPortal(<WebhookExecutorsPanel />, portalMain)}
  </>
}

function ApprovalsPanel() {
  const [proposals, setProposals] = useState<AgentActionProposal[]>([])
  const [principal, setPrincipal] = useState<PortalPrincipal>()
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()

  const refresh = useCallback(async () => {
    try {
      const [items, me] = await Promise.all([listProposals(), api<PortalPrincipal>('/api/me')])
      setProposals(items)
      setPrincipal(me)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load approvals')
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5_000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const pending = proposals.filter((proposal) => proposal.status === 'proposed')
  const history = proposals.filter((proposal) => proposal.status !== 'proposed').slice(0, 12)
  const canApprove = principal?.roles.includes('Papyrus.Action.Approve') || principal?.roles.includes('Papyrus.System.Owner')

  const decide = async (proposal: AgentActionProposal, approved: boolean) => {
    setBusy(proposal.id)
    setError(undefined)
    try {
      if (approved) await approveProposal(proposal.id)
      else {
        const reason = window.prompt('Reason for denial (optional)')?.trim()
        await denyProposal(proposal.id, reason || undefined)
      }
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to record approval decision')
    } finally { setBusy(undefined) }
  }

  return <section className="durable-approvals" aria-labelledby="durable-approvals-title">
    <div className="governance-section-head"><div><p className="eyebrow">DURABLE ACTION AUTHORITY</p><h2 id="durable-approvals-title">Approvals</h2><p>Sessions, Links, schedules, and external signals request actions here. The approval record survives navigation and does not belong to the conversation that requested it.</p></div><Badge>{pending.length} PENDING</Badge></div>
    {error && <Alert className="error">{error}</Alert>}
    <div className="approval-queue">
      {pending.length === 0 && <Card className="approval-empty"><strong>No pending approvals</strong><p>New governed actions will appear here before an executor can run them.</p></Card>}
      {pending.map((proposal) => <Card className="approval-card" key={proposal.id} id={`approval-${proposal.id}`}>
        <div className="approval-card-head"><div><p className="eyebrow">ACTION APPROVAL</p><h3>{proposal.action}</h3></div><Badge>PENDING</Badge></div>
        <dl className="approval-metadata">
          <div><dt>Target</dt><dd>{proposal.target}</dd></div>
          <div><dt>Executor</dt><dd>{proposal.executorIntegrationId}</dd></div>
          <div><dt>Requested by</dt><dd>{proposal.proposedByOperatorId.startsWith('webhook:') ? 'Webhook Link' : proposal.proposedByOperatorId}</dd></div>
          <div><dt>Requested</dt><dd>{new Date(proposal.proposedAt).toLocaleString()}</dd></div>
        </dl>
        {proposal.parameters && Object.keys(proposal.parameters).length > 0 && <details><summary>Input parameters</summary><pre>{JSON.stringify(proposal.parameters, null, 2)}</pre></details>}
        <div className="approval-actions">
          {canApprove
            ? <><Button variant="ghost" disabled={busy === proposal.id} onClick={() => void decide(proposal, false)}>Deny</Button><Button className="primary" disabled={busy === proposal.id} onClick={() => void decide(proposal, true)}>{busy === proposal.id ? 'Recording…' : 'Approve and queue'}</Button></>
            : <small>Waiting for a Papyrus.Action.Approve operator.</small>}
        </div>
      </Card>)}
    </div>
    {history.length > 0 && <div className="approval-history"><p className="eyebrow">RECENT DECISIONS</p>{history.map((proposal) => <div className="approval-history-row" key={proposal.id}><span><strong>{proposal.action}</strong><small>{proposal.target}</small></span><Badge>{proposal.status.toUpperCase()}</Badge></div>)}</div>}
  </section>
}

function WebhookExecutorsPanel() {
  const [links, setLinks] = useState<AgentLink[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const [data, setData] = useState<LinkExecutorData>()
  const [principal, setPrincipal] = useState<PortalPrincipal>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)

  const webhookLinks = links.filter((link) => link.type === 'webhook')
  const canManage = principal?.roles.includes('Papyrus.System.Owner') || principal?.roles.includes('Papyrus.Integration.Manage')

  const refreshLinks = useCallback(async () => {
    try {
      const [items, me] = await Promise.all([listLinks(), api<PortalPrincipal>('/api/me')])
      setLinks(items)
      setPrincipal(me)
      const webhook = items.filter((link) => link.type === 'webhook')
      setSelectedId((current) => current && webhook.some((link) => link.id === current) ? current : webhook[0]?.id)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to load Webhook Links') }
  }, [])

  const refreshSelected = useCallback(async (id: string) => {
    setLoading(true)
    try {
      setData(await api<LinkExecutorData>(`/api/links/${encodeURIComponent(id)}/executors`))
      setError(undefined)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to load Action Executors') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void refreshLinks() }, [refreshLinks])
  useEffect(() => { if (selectedId) void refreshSelected(selectedId); else setData(undefined) }, [selectedId, refreshSelected])

  return <section className="webhook-executor-surface" aria-labelledby="webhook-executor-title">
    <div className="governance-section-head"><div><p className="eyebrow">GOVERNED WEBHOOK ACTIONS</p><h2 id="webhook-executor-title">Webhook Action Executors</h2><p>Attach explicit executor capabilities to a Webhook Link. Deliveries may propose actions, but the Link never bypasses the action ledger or approval boundary.</p></div></div>
    {error && <Alert className="error">{error}</Alert>}
    {webhookLinks.length === 0
      ? <Card><strong>No Webhook Links</strong><p>Create a Webhook Link through the agent, then attach an executor here.</p></Card>
      : <div className="webhook-executor-layout">
          <Card className="webhook-link-picker"><p className="eyebrow">WEBHOOK LINKS</p>{webhookLinks.map((link) => <button type="button" className={link.id === selectedId ? 'active' : ''} onClick={() => setSelectedId(link.id)} key={link.id}><span><strong>{link.name}</strong><small>{link.publicPath}</small></span><Badge>{link.state.toUpperCase()}</Badge></button>)}</Card>
          <div>{loading && <Card>Loading executor attachments…</Card>}{!loading && data && <WebhookLinkExecutors data={data} canManage={Boolean(canManage)} onChanged={() => refreshSelected(data.link.id)} />}</div>
        </div>}
  </section>
}

function WebhookLinkExecutors({ data, canManage, onChanged }: { data: LinkExecutorData; canManage: boolean; onChanged: () => Promise<void> }) {
  const [showAttach, setShowAttach] = useState(false)
  const [error, setError] = useState<string>()

  const toggle = async (attachment: LinkExecutorAttachment) => {
    try {
      await api(`/api/links/${encodeURIComponent(data.link.id)}/executors/${encodeURIComponent(attachment.id)}`, {
        method: 'PATCH', body: JSON.stringify({ enabled: !attachment.enabled }),
      })
      await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to update attachment') }
  }
  const remove = async (attachment: LinkExecutorAttachment) => {
    if (!window.confirm(`Detach ${attachment.executorIntegrationId} from ${data.link.name}?`)) return
    try {
      await api(`/api/links/${encodeURIComponent(data.link.id)}/executors/${encodeURIComponent(attachment.id)}`, { method: 'DELETE' })
      await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to remove attachment') }
  }

  return <Card className="webhook-executor-card">
    <div className="approval-card-head"><div><p className="eyebrow">{data.link.publicPath}</p><h3>{data.link.name}</h3></div>{canManage && <Button className="primary" onClick={() => setShowAttach((value) => !value)}>＋ Attach executor</Button>}</div>
    {error && <Alert className="error">{error}</Alert>}
    {showAttach && <AttachExecutorForm link={data.link} executors={data.executors} onCreated={async () => { setShowAttach(false); await onChanged() }} />}
    <div className="executor-attachment-list">
      {data.attachments.length === 0 && <div className="empty-attachment"><strong>No Action Executors attached</strong><p>This Webhook currently acts only as ingress/context.</p></div>}
      {data.attachments.map((attachment) => {
        const executor = data.executors.find((item) => item.id === attachment.executorIntegrationId)
        return <div className="executor-attachment" key={attachment.id}>
          <div className="executor-attachment-title"><span className="executor-mark">⚡</span><span><strong>{executor?.name ?? attachment.executorIntegrationId}</strong><small>{attachment.action} → {attachment.target}</small></span><Badge>{attachment.enabled ? 'ENABLED' : 'DISABLED'}</Badge></div>
          <div className="executor-attachment-policy"><span>{humanMode(attachment.invocationMode)}</span><span>Approval: {attachment.approvalMode === 'required' ? 'required' : 'workspace policy'}</span>{attachment.condition && <span>When {attachment.condition.path} = {String(attachment.condition.equals)}</span>}</div>
          {Object.keys(attachment.inputMapping).length > 0 && <small className="executor-mapping">Maps {Object.entries(attachment.inputMapping).map(([key, value]) => `${value} → ${key}`).join(' · ')}</small>}
          {canManage && <div className="executor-attachment-actions"><Button variant="ghost" onClick={() => void toggle(attachment)}>{attachment.enabled ? 'Disable' : 'Enable'}</Button><Button variant="ghost" onClick={() => void remove(attachment)}>Detach</Button></div>}
        </div>
      })}
    </div>
  </Card>
}

function AttachExecutorForm({ link, executors, onCreated }: { link: AgentLink; executors: ExecutorSummary[]; onCreated: () => Promise<void> }) {
  const [executorIntegrationId, setExecutorIntegrationId] = useState(executors[0]?.id ?? '')
  const [action, setAction] = useState('webhook.execute')
  const [target, setTarget] = useState('{{id}}')
  const [invocationMode, setInvocationMode] = useState<'agent_decides' | 'always' | 'conditional'>('always')
  const [conditionPath, setConditionPath] = useState('')
  const [conditionEquals, setConditionEquals] = useState('')
  const [mappingText, setMappingText] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true); setError(undefined)
    try {
      const inputMapping = Object.fromEntries(mappingText.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
        const [key, ...path] = line.split('=')
        if (!key?.trim() || !path.join('=').trim()) throw new Error('Mappings use parameter=payload.path, one per line')
        return [key.trim(), path.join('=').trim()]
      }))
      await api(`/api/links/${encodeURIComponent(link.id)}/executors`, {
        method: 'POST',
        body: JSON.stringify({
          executorIntegrationId, action, target, invocationMode, approvalMode: 'inherit', inputMapping,
          ...(invocationMode === 'conditional' ? { condition: { path: conditionPath, equals: parseScalar(conditionEquals) } } : {}),
        }),
      })
      await onCreated()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to attach executor') }
    finally { setSaving(false) }
  }

  return <form className="attach-executor-form" onSubmit={(event) => void submit(event)}>
    {error && <Alert className="error">{error}</Alert>}
    <label>Action Executor<select value={executorIntegrationId} onChange={(event) => setExecutorIntegrationId(event.target.value)} required>{executors.map((executor) => <option value={executor.id} key={executor.id}>{executor.name} · {executor.risk}</option>)}</select></label>
    <div className="form-two"><label>Action<Input value={action} onChange={(event) => setAction(event.target.value)} required /></label><label>Target<Input value={target} onChange={(event) => setTarget(event.target.value)} required /></label></div>
    <label>Invocation<select value={invocationMode} onChange={(event) => setInvocationMode(event.target.value as typeof invocationMode)}><option value="always">Always propose</option><option value="conditional">Conditional</option><option value="agent_decides">Agent decides</option></select></label>
    {invocationMode === 'conditional' && <div className="form-two"><label>Payload path<Input value={conditionPath} placeholder="event.severity" onChange={(event) => setConditionPath(event.target.value)} required /></label><label>Equals<Input value={conditionEquals} placeholder="high" onChange={(event) => setConditionEquals(event.target.value)} required /></label></div>}
    <label>Input mapping<textarea value={mappingText} onChange={(event) => setMappingText(event.target.value)} placeholder={'repository=repository.full_name\nbranch=ref'} rows={3} /><small>Optional. One parameter=payload.path mapping per line. With no mappings, the full payload is supplied as <code>webhook</code>.</small></label>
    <div className="attach-executor-note">Approval policy is inherited from the workspace. The webhook cannot self-authorize an attached executor.</div>
    <Button className="primary" type="submit" disabled={saving || executors.length === 0}>{saving ? 'Attaching…' : 'Attach Action Executor'}</Button>
  </form>
}

/**
 * Session transcript cards remain useful provenance, but their approve/deny buttons
 * are intentionally suppressed. Governance owns the decision and ledger record.
 */
function projectSessionApprovalLinks(): void {
  for (const controls of document.querySelectorAll<HTMLElement>('.action-suggestion .proposal-controls')) {
    const buttons = Array.from(controls.querySelectorAll<HTMLButtonElement>('button'))
    const decisionButtons = buttons.filter((button) => /^(Approve and queue|Deny)$/.test(button.textContent?.trim() ?? ''))
    if (decisionButtons.length === 0 && !/Waiting for a Papyrus\.Action\.Approve operator\./.test(controls.textContent ?? '')) continue
    for (const button of decisionButtons) button.style.display = 'none'
    if (controls.querySelector('[data-governance-approval-link]')) continue
    const link = document.createElement('a')
    link.href = '/portal/governance'
    link.dataset.governanceApprovalLink = 'true'
    link.className = 'nb-button primary'
    link.textContent = 'Review in Governance →'
    controls.appendChild(link)
  }
}

function humanMode(mode: LinkExecutorAttachment['invocationMode']): string {
  if (mode === 'agent_decides') return 'Agent decides'
  if (mode === 'conditional') return 'Conditional'
  return 'Always propose'
}

function parseScalar(value: string): string | number | boolean | null {
  const trimmed = value.trim()
  if (trimmed === 'null') return null
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed !== '' && Number.isFinite(Number(trimmed))) return Number(trimmed)
  return trimmed
}
