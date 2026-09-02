import { useCallback, useEffect, useState } from 'react'
import type { CyberActionProposal, CyberInvestigation, PortalPrincipal } from '@papyrus/contracts'
import { approveProposal, denyProposal, listReceipts, type ApiError } from './api.js'
import type { CyberActionReceipt } from '@papyrus/contracts'
import { Alert, Badge, Button, Card } from './components/ui/index.js'

interface InvestigationsViewProps {
  me: PortalPrincipal
  investigations: CyberInvestigation[]
  proposals: CyberActionProposal[]
  onChanged: () => void
}

type ReceiptsMap = Record<string, CyberActionReceipt>

function investigationStatusLabel(status: CyberInvestigation['status']): { label: string; className: string } {
  const map: Record<CyberInvestigation['status'], { label: string; className: string }> = {
    open: { label: 'Open', className: 'status-info' },
    analyzing: { label: 'Analyzing', className: 'status-good' },
    action_proposed: { label: 'Action Proposed', className: 'status-warning' },
    awaiting_approval: { label: 'Awaiting Approval', className: 'status-warning' },
    executing: { label: 'Executing', className: 'status-critical' },
    resolved: { label: 'Resolved', className: 'status-good' },
    abandoned: { label: 'Abandoned', className: 'status-neutral' },
  }
  return map[status] ?? { label: status, className: 'status-neutral' }
}

function proposalStatusLabel(status: CyberActionProposal['status']): { label: string; className: string } {
  const map: Record<CyberActionProposal['status'], { label: string; className: string }> = {
    proposed: { label: 'Proposed', className: 'status-warning' },
    approved: { label: 'Approved', className: 'status-good' },
    denied: { label: 'Denied', className: 'status-neutral' },
    expired: { label: 'Expired', className: 'status-neutral' },
    executing: { label: 'Executing', className: 'status-critical' },
    executed: { label: 'Executed', className: 'status-good' },
    failed: { label: 'Failed', className: 'status-error' },
  }
  return map[status] ?? { label: status, className: 'status-neutral' }
}

function hasApproveRole(me: PortalPrincipal): boolean {
  return me.roles.includes('Papyrus.Action.Approve') || me.roles.includes('Papyrus.System.Owner')
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMin = Math.floor(diffMs / 60_000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  return date.toLocaleDateString()
}

export interface InvestigationsListProps {
  me: PortalPrincipal
  investigations: CyberInvestigation[]
  proposals: CyberActionProposal[]
  receipts?: Record<string, CyberActionReceipt>
  pendingId?: string
  onApprove?: (proposalId: string) => void
  onDeny?: (proposalId: string) => void
}

/**
 * Pure renderer that performs no I/O of its own. The portal supplies these
 * shapes from a portal fetch; a chat surface supplies the same shapes from a
 * tool result.
 *
 * Approve and deny are deliberately not agent-callable tools. They are human
 * actions invoked with the operator's own Entra session against the action
 * ledger, which re-checks the Papyrus.Action.Approve role server-side.
 */
export function InvestigationsList({ me, investigations, proposals, receipts = {}, pendingId, onApprove, onDeny }: InvestigationsListProps) {
  if (investigations.length === 0 && proposals.length === 0) {
    return <Card className="empty-product">
      <p className="eyebrow">COLLECTIVE ANALYSIS</p>
      <span className="empty-product-mark">◎</span>
      <h2>Investigations</h2>
      <p>No active investigations. When evidence triggers analysis, Starlings will assemble claims, contradictions, and action proposals here.</p>
    </Card>
  }

  // Group proposals by investigation
  const proposalsByInvestigation = new Map<string, CyberActionProposal[]>()
  for (const proposal of proposals) {
    const list = proposalsByInvestigation.get(proposal.investigationId) ?? []
    list.push(proposal)
    proposalsByInvestigation.set(proposal.investigationId, list)
  }

  const canApprove = hasApproveRole(me)

  return <div className="investigations-list">
    {investigations.map((inv) => {
      const invProposals = proposalsByInvestigation.get(inv.id) ?? []
      const hasProposedActions = invProposals.some((p) => p.status === 'proposed')
      const status = investigationStatusLabel(inv.status)
      return <Card key={inv.id} className={`investigation-card ${hasProposedActions ? 'has-action' : ''}`}>
        <div className="investigation-header">
          <div className="investigation-title-row">
            {hasProposedActions && <span className="action-flag" title="Action proposed — approval required">⚠</span>}
            <h3>{inv.title}</h3>
            <Badge className={status.className}>{status.label}</Badge>
          </div>
          <small className="investigation-meta">
            Trigger: {inv.trigger} · {formatTime(inv.createdAt)}
            {inv.claimIds.length > 0 && ` · ${inv.claimIds.length} claims`}
          </small>
        </div>
        {inv.summary && <p className="investigation-summary">{inv.summary}</p>}
        {invProposals.length > 0 && <div className="proposals-section">
          {invProposals.map((proposal) => {
            const pStatus = proposalStatusLabel(proposal.status)
            const receipt = receipts[proposal.id]
            return <div key={proposal.id} className="proposal-item">
              <div className="proposal-header">
                <span className="action-flag-small" title="Action proposal">⚡</span>
                <strong>{proposal.action}</strong>
                <code className="proposal-target">{proposal.target}</code>
                <Badge className={pStatus.className}>{pStatus.label}</Badge>
              </div>
              {proposal.rationaleClaimIds.length > 0 && <small className="proposal-rationale">Evidence: {proposal.rationaleClaimIds.length} claims</small>}
              {proposal.denialReason && <small className="proposal-denial">Denied: {proposal.denialReason}</small>}
              {receipt && <div className="proposal-receipt">
                <Badge className="status-good">Receipt</Badge>
                <small>{receipt.result} — {receipt.message}</small>
              </div>}
              {proposal.status === 'proposed' && canApprove && (onApprove || onDeny) && (
                <div className="proposal-actions">
                  {onApprove && <Button className="primary" disabled={pendingId === proposal.id} onClick={() => onApprove(proposal.id)}>
                    {pendingId === proposal.id ? 'Approving…' : 'Approve'}
                  </Button>}
                  {onDeny && <Button variant="ghost" disabled={pendingId === proposal.id} onClick={() => onDeny(proposal.id)}>
                    Deny
                  </Button>}
                </div>
              )}
              {proposal.status === 'proposed' && !canApprove && (
                <small className="approval-hint">Requires Papyrus.Action.Approve role</small>
              )}
            </div>
          })}
        </div>}
        {invProposals.length === 0 && inv.status !== 'resolved' && <p className="no-proposals">No action proposals yet. Starlings is analyzing evidence.</p>}
      </Card>
    })}
  </div>
}

export function InvestigationsView({ me, investigations, proposals, onChanged }: InvestigationsViewProps) {
  const [receipts, setReceipts] = useState<ReceiptsMap>({})
  const [actionLoading, setActionLoading] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()

  const refreshReceipts = useCallback(async () => {
    try {
      const list = await listReceipts()
      const map: ReceiptsMap = {}
      for (const receipt of list) map[receipt.proposalId] = receipt
      setReceipts(map)
    } catch {
      // Receipts are optional enrichment
    }
  }, [])

  useEffect(() => { void refreshReceipts() }, [refreshReceipts])

  const handleApprove = async (id: string) => {
    setActionLoading(id)
    setError(undefined)
    try {
      await approveProposal(id)
      onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to approve proposal')
    } finally {
      setActionLoading(undefined)
    }
  }

  const handleDeny = async (id: string) => {
    setActionLoading(id)
    setError(undefined)
    try {
      await denyProposal(id)
      onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to deny proposal')
    } finally {
      setActionLoading(undefined)
    }
  }

  return <>
    {error && <Alert className="error">{error}</Alert>}
    <InvestigationsList
      me={me}
      investigations={investigations}
      proposals={proposals}
      receipts={receipts}
      {...(actionLoading ? { pendingId: actionLoading } : {})}
      onApprove={(id) => void handleApprove(id)}
      onDeny={(id) => void handleDeny(id)}
    />
  </>
}
