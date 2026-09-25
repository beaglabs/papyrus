import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AgentActionProposal, EntraAppRole, IntegrationConfiguration } from '@papyrus/contracts'
import { api, approveProposal, denyProposal, listProposals } from './api.js'
import { Alert, Badge, Button, Card } from './components/ui/index.js'

const TERMINAL = new Set<AgentActionProposal['status']>(['executed', 'denied', 'expired', 'failed'])

function selectedApprovalFromLocation(): string | undefined {
  return new URLSearchParams(window.location.search).get('approval') ?? undefined
}

export function ApprovalsPanel({ roles }: { roles: EntraAppRole[] }) {
  const [proposals, setProposals] = useState<AgentActionProposal[]>([])
  const [integrations, setIntegrations] = useState<IntegrationConfiguration[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string>()
  const [error, setError] = useState<string>()
  const selectedId = selectedApprovalFromLocation()
  const canApprove = roles.includes('Papyrus.Action.Approve') || roles.includes('Papyrus.System.Owner')

  const refresh = useCallback(async () => {
    try {
      setError(undefined)
      const [nextProposals, integrationResult] = await Promise.all([
        listProposals(),
        api<{ integrations: IntegrationConfiguration[] }>('/api/integrations'),
      ])
      setProposals(nextProposals)
      setIntegrations(integrationResult.integrations)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load approvals')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 8_000)
    return () => window.clearInterval(timer)
  }, [refresh])

  useEffect(() => {
    if (!selectedId || loading) return
    window.requestAnimationFrame(() => document.getElementById(`approval-${selectedId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
  }, [selectedId, loading, proposals])

  const integrationNames = useMemo(() => new Map(integrations.map((integration) => [integration.id, integration.name])), [integrations])
  const pending = useMemo(() => proposals.filter((proposal) => !TERMINAL.has(proposal.status))
    .sort((left, right) => right.proposedAt.localeCompare(left.proposedAt)), [proposals])
  const resolved = useMemo(() => proposals.filter((proposal) => TERMINAL.has(proposal.status))
    .sort((left, right) => right.proposedAt.localeCompare(left.proposedAt)).slice(0, 20), [proposals])

  const decide = async (proposal: AgentActionProposal, approved: boolean) => {
    setBusyId(proposal.id); setError(undefined)
    try {
      if (approved) await approveProposal(proposal.id)
      else {
        const reason = window.prompt('Reason for denial (optional)') ?? undefined
        await denyProposal(proposal.id, reason?.trim() || undefined)
      }
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to record approval decision')
    } finally {
      setBusyId(undefined)
    }
  }

  return <section className="governance-approvals" aria-labelledby="approvals-title" style={{ marginTop: 22 }}>
    <div className="obs-head">
      <div>
        <p className="eyebrow">DURABLE HUMAN AUTHORITY</p>
        <h2 id="approvals-title">Approvals</h2>
        <p>Sessions, Links, schedules, and inbound webhooks can request authority here. The request survives navigation and the originating session is not the approval boundary.</p>
      </div>
      <div className="obs-storage"><span className={`dot ${pending.length ? 'warning' : 'good'}`} /><span><strong>{pending.length} pending</strong><small>Action ledger · workspace scope</small></span></div>
    </div>

    {error && <Alert className="error obs-alert">{error}</Alert>}
    {loading && !proposals.length && <Card><p>Loading workspace approvals…</p></Card>}
    {!loading && !pending.length && <Card><p className="eyebrow">QUEUE CLEAR</p><h3>No pending approvals</h3><p>New action requests will appear here even when the originating Agent session or Link page is not open.</p></Card>}

    <div className="approval-queue" style={{ display: 'grid', gap: 12 }}>
      {pending.map((proposal) => <ApprovalCard
        key={proposal.id}
        proposal={proposal}
        executorName={integrationNames.get(proposal.executorIntegrationId)}
        canApprove={canApprove}
        busy={busyId === proposal.id}
        selected={selectedId === proposal.id}
        onDecide={decide}
      />)}
    </div>

    {resolved.length > 0 && <details style={{ marginTop: 18 }}>
      <summary>Recent decisions and executions ({resolved.length})</summary>
      <div className="approval-queue" style={{ display: 'grid', gap: 10, marginTop: 10 }}>
        {resolved.map((proposal) => <ApprovalCard
          key={proposal.id}
          proposal={proposal}
          executorName={integrationNames.get(proposal.executorIntegrationId)}
          canApprove={false}
          busy={false}
          selected={selectedId === proposal.id}
          onDecide={decide}
        />)}
      </div>
    </details>}
  </section>
}

function ApprovalCard({ proposal, executorName, canApprove, busy, selected, onDecide }: {
  proposal: AgentActionProposal
  executorName?: string
  canApprove: boolean
  busy: boolean
  selected: boolean
  onDecide: (proposal: AgentActionProposal, approved: boolean) => Promise<void>
}) {
  const source = approvalSource(proposal)
  const subject = approvalSubject(proposal)
  return <Card id={`approval-${proposal.id}`} className={selected ? 'selected' : ''} style={selected ? { outline: '3px solid currentColor', outlineOffset: 2 } : undefined}>
    <div className="action-suggestion-head">
      <span className="attention-icon">!</span>
      <div><p className="eyebrow">{subject.kind}</p><h3>{subject.title}</h3></div>
      <Badge>{proposal.status.toUpperCase()}</Badge>
    </div>
    <dl>
      <div><dt>Source</dt><dd>{source}</dd></div>
      <div><dt>Executor</dt><dd>{executorName ?? proposal.executorIntegrationId}</dd></div>
      <div><dt>Target</dt><dd>{proposal.target}</dd></div>
      <div><dt>Requested</dt><dd>{new Date(proposal.proposedAt).toLocaleString()}</dd></div>
      <div><dt>Required authority</dt><dd>{proposal.requiredRole}</dd></div>
    </dl>
    {proposal.parameters && <details><summary>Review parameters</summary><pre style={{ overflow: 'auto', maxHeight: 320 }}>{JSON.stringify(redactedParameters(proposal.parameters), null, 2)}</pre></details>}
    {proposal.denialReason && <Alert>{proposal.denialReason}</Alert>}
    <div className="proposal-controls">
      {proposal.status === 'proposed' && canApprove && <>
        <Button className="primary" disabled={busy} onClick={() => void onDecide(proposal, true)}>{busy ? 'Recording…' : 'Approve & queue'}</Button>
        <Button variant="ghost" disabled={busy} onClick={() => void onDecide(proposal, false)}>Deny</Button>
      </>}
      {proposal.status === 'proposed' && !canApprove && <small>Waiting for a Papyrus.Action.Approve operator.</small>}
      {['approved', 'executing'].includes(proposal.status) && <small>Approved — the leased action worker owns execution now.</small>}
      {proposal.status === 'executed' && <small>Executed. The receipt and observability trace are retained independently of the originating session.</small>}
      {proposal.status === 'failed' && <small>Execution failed. Inspect the action receipt and trace for the executor&apos;s reason.</small>}
      {proposal.status === 'denied' && <small>Denied and not released.</small>}
      {proposal.status === 'expired' && <small>Expired without release.</small>}
    </div>
  </Card>
}

function approvalSource(proposal: AgentActionProposal): string {
  if (proposal.proposedByOperatorId.startsWith('webhook-link:')) return `Webhook Link · ${proposal.proposedByOperatorId.slice('webhook-link:'.length)}`
  if (proposal.action === 'publish_link') return 'Agent session → Link publication'
  if (proposal.action === 'attach_webhook_executor' || proposal.action === 'detach_webhook_executor') return 'Links → executor configuration'
  return `Agent / operator · ${proposal.proposedByOperatorId}`
}

function approvalSubject(proposal: AgentActionProposal): { kind: string; title: string } {
  if (proposal.action === 'publish_link') return { kind: 'LINK PUBLICATION', title: `Publish ${String(proposal.parameters?.['linkType'] ?? 'Link')} · ${proposal.target}` }
  if (proposal.action === 'attach_webhook_executor') return { kind: 'WEBHOOK CONFIGURATION', title: `Attach Action Executor to ${proposal.target}` }
  if (proposal.action === 'detach_webhook_executor') return { kind: 'WEBHOOK CONFIGURATION', title: `Detach Action Executor from ${proposal.target}` }
  if (proposal.proposedByOperatorId.startsWith('webhook-link:')) return { kind: 'WEBHOOK ACTION', title: `${proposal.action} · ${proposal.target}` }
  return { kind: 'ACTION', title: `${proposal.action} · ${proposal.target}` }
}

function redactedParameters(parameters: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(parameters)) {
    if (/secret|password|token|credential|authorization/i.test(key)) result[key] = '[redacted]'
    else result[key] = value
  }
  return result
}
