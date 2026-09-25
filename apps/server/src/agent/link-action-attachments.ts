import { randomUUID } from 'node:crypto'
import type { AgentActionProposal, AgentLink, LinkInbound } from '@papyrus/contracts'
import type { ActionStore } from './action-store.js'
import type { AgentDatabase } from './database.js'

type Row = Record<string, unknown>

export type LinkExecutorInvocationMode = 'agent_decides' | 'always' | 'conditional'
export type LinkExecutorApprovalMode = 'inherit' | 'required'

export interface LinkExecutorCondition {
  path: string
  equals: string | number | boolean | null
}

export interface LinkExecutorAttachment {
  id: string
  linkId: string
  executorIntegrationId: string
  action: string
  target: string
  enabled: boolean
  invocationMode: LinkExecutorInvocationMode
  condition?: LinkExecutorCondition
  inputMapping: Record<string, string>
  approvalMode: LinkExecutorApprovalMode
  maxRetries: number
  createdByOid: string
  createdAt: string
  updatedAt: string
}

export interface AttachLinkExecutorInput {
  executorIntegrationId: string
  action: string
  target: string
  invocationMode?: LinkExecutorInvocationMode
  condition?: LinkExecutorCondition
  inputMapping?: Record<string, string>
  approvalMode?: LinkExecutorApprovalMode
  maxRetries?: number
}

export interface WebhookAttachmentDispatch {
  attachment: LinkExecutorAttachment
  proposal?: AgentActionProposal
  skipped?: 'agent_decides' | 'condition_not_met'
}

const STORES = new WeakMap<AgentDatabase, LinkActionAttachmentStore>()

export function linkActionAttachments(db: AgentDatabase): LinkActionAttachmentStore {
  const existing = STORES.get(db)
  if (existing) return existing
  const created = new LinkActionAttachmentStore(db)
  STORES.set(db, created)
  return created
}

export class LinkActionAttachmentStore {
  constructor(readonly db: AgentDatabase) { this.migrate() }

  list(linkId: string): LinkExecutorAttachment[] {
    return (this.db.sqlite.prepare(
      'SELECT * FROM agent_link_executor_attachments WHERE link_id=? ORDER BY created_at',
    ).all(linkId) as Row[]).map((row) => this.attachment(row))
  }

  get(id: string): LinkExecutorAttachment | undefined {
    const row = this.db.sqlite.prepare('SELECT * FROM agent_link_executor_attachments WHERE id=?').get(id) as Row | undefined
    return row ? this.attachment(row) : undefined
  }

  attach(link: AgentLink, actorOid: string, input: AttachLinkExecutorInput): LinkExecutorAttachment {
    if (link.type !== 'webhook') throw new Error('Action Executors can only be attached to Webhook Links')
    const executor = this.db.getIntegration(input.executorIntegrationId)
    if (!executor) throw new Error('Executor integration not found')
    if (executor.state !== 'active') throw new Error('Executor integration must be active')
    if (executor.integrationClass !== 'action_executor' && executor.authority !== 'controlled_actions') {
      throw new Error('Integration is not an Action Executor')
    }
    const action = input.action.trim()
    const target = input.target.trim()
    if (!action || action.length > 256) throw new Error('action must be between 1 and 256 characters')
    if (!target || target.length > 1024) throw new Error('target must be between 1 and 1024 characters')
    const invocationMode = input.invocationMode ?? 'always'
    if (!['agent_decides', 'always', 'conditional'].includes(invocationMode)) throw new Error('Invalid invocation mode')
    if (invocationMode === 'conditional' && !input.condition) throw new Error('Conditional attachments require a condition')
    const approvalMode = input.approvalMode ?? 'inherit'
    if (!['inherit', 'required'].includes(approvalMode)) throw new Error('Invalid approval mode')
    const inputMapping = cleanStringMap(input.inputMapping ?? {})
    const maxRetries = Math.max(1, Math.min(10, Math.floor(input.maxRetries ?? 3)))
    const now = new Date().toISOString()
    const id = randomUUID()
    this.db.sqlite.prepare(`INSERT INTO agent_link_executor_attachments(
      id,link_id,executor_integration_id,action,target,enabled,invocation_mode,condition_json,input_mapping_json,
      approval_mode,max_retries,created_by_oid,created_at,updated_at
    ) VALUES(?,?,?,?,?,1,?,?,?,?,?,?,?,?)`).run(
      id, link.id, input.executorIntegrationId, action, target, invocationMode,
      input.condition ? JSON.stringify(cleanCondition(input.condition)) : null,
      JSON.stringify(inputMapping), approvalMode, maxRetries, actorOid, now, now,
    )
    this.db.recordActionEvent(input.executorIntegrationId, actorOid, 'WebhookExecutorAttached', {
      linkId: link.id, attachmentId: id, action, target, invocationMode, approvalMode,
    })
    return this.get(id) as LinkExecutorAttachment
  }

  setEnabled(linkId: string, id: string, enabled: boolean, actorOid: string): LinkExecutorAttachment {
    const attachment = this.get(id)
    if (!attachment || attachment.linkId !== linkId) throw new Error('Executor attachment not found')
    const now = new Date().toISOString()
    this.db.sqlite.prepare('UPDATE agent_link_executor_attachments SET enabled=?,updated_at=? WHERE id=? AND link_id=?')
      .run(enabled ? 1 : 0, now, id, linkId)
    this.db.recordActionEvent(attachment.executorIntegrationId, actorOid, enabled ? 'WebhookExecutorEnabled' : 'WebhookExecutorDisabled', {
      linkId, attachmentId: id,
    })
    return this.get(id) as LinkExecutorAttachment
  }

  remove(linkId: string, id: string, actorOid: string): void {
    const attachment = this.get(id)
    if (!attachment || attachment.linkId !== linkId) throw new Error('Executor attachment not found')
    this.db.sqlite.prepare('DELETE FROM agent_link_executor_attachments WHERE id=? AND link_id=?').run(id, linkId)
    this.db.recordActionEvent(attachment.executorIntegrationId, actorOid, 'WebhookExecutorDetached', {
      linkId, attachmentId: id,
    })
  }

  /**
   * Turn a webhook delivery into durable action proposals. The webhook itself never
   * executes an integration. Every generated proposal remains in the shared action
   * ledger until an Entra principal with Papyrus.Action.Approve releases it.
   */
  dispatchWebhook(
    actionStore: ActionStore,
    link: AgentLink,
    inbound: LinkInbound,
    body: Record<string, unknown>,
  ): WebhookAttachmentDispatch[] {
    const attachments = this.list(link.id).filter((attachment) => attachment.enabled)
    if (!attachments.length) return []

    const actionable = attachments.filter((attachment) => {
      if (attachment.invocationMode === 'agent_decides') return false
      if (attachment.invocationMode === 'conditional') return conditionMatches(body, attachment.condition)
      return true
    })
    const investigation = actionable.length
      ? actionStore.createInvestigation({
          title: `Webhook: ${link.name}`,
          trigger: 'signal',
          triggerMessageId: inbound.id,
          ...(link.threadId ? { mastraThreadId: link.threadId } : {}),
        })
      : undefined

    const results: WebhookAttachmentDispatch[] = []
    for (const attachment of attachments) {
      if (attachment.invocationMode === 'agent_decides') {
        results.push({ attachment, skipped: 'agent_decides' })
        continue
      }
      if (attachment.invocationMode === 'conditional' && !conditionMatches(body, attachment.condition)) {
        results.push({ attachment, skipped: 'condition_not_met' })
        continue
      }
      if (!investigation) continue
      const proposal = actionStore.createProposal({
        investigationId: investigation.id,
        proposedByOperatorId: `webhook:${link.id}`,
        executorIntegrationId: attachment.executorIntegrationId,
        action: attachment.action,
        target: templateTarget(attachment.target, body),
        parameters: mapPayload(body, attachment.inputMapping),
        rationaleClaimIds: [],
      })
      this.db.recordActionEvent(attachment.executorIntegrationId, `webhook:${link.id}`, 'WebhookActionProposed', {
        linkId: link.id,
        inboundId: inbound.id,
        attachmentId: attachment.id,
        proposalId: proposal.id,
        investigationId: investigation.id,
        approvalMode: attachment.approvalMode,
      })
      results.push({ attachment, proposal })
    }
    if (investigation && results.some((result) => result.proposal)) {
      actionStore.updateInvestigationStatus(investigation.id, 'awaiting_approval')
    }
    return results
  }

  private attachment(row: Row): LinkExecutorAttachment {
    return {
      id: String(row.id),
      linkId: String(row.link_id),
      executorIntegrationId: String(row.executor_integration_id),
      action: String(row.action),
      target: String(row.target),
      enabled: Number(row.enabled) === 1,
      invocationMode: row.invocation_mode as LinkExecutorInvocationMode,
      ...(row.condition_json ? { condition: JSON.parse(String(row.condition_json)) as LinkExecutorCondition } : {}),
      inputMapping: JSON.parse(String(row.input_mapping_json || '{}')) as Record<string, string>,
      approvalMode: row.approval_mode as LinkExecutorApprovalMode,
      maxRetries: Number(row.max_retries),
      createdByOid: String(row.created_by_oid),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }
  }

  private migrate(): void {
    this.db.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS agent_link_executor_attachments (
        id TEXT PRIMARY KEY,
        link_id TEXT NOT NULL REFERENCES agent_links(id) ON DELETE CASCADE,
        executor_integration_id TEXT NOT NULL REFERENCES agent_integrations(id),
        action TEXT NOT NULL,
        target TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        invocation_mode TEXT NOT NULL CHECK(invocation_mode IN ('agent_decides','always','conditional')),
        condition_json TEXT,
        input_mapping_json TEXT NOT NULL DEFAULT '{}',
        approval_mode TEXT NOT NULL CHECK(approval_mode IN ('inherit','required')),
        max_retries INTEGER NOT NULL DEFAULT 3,
        created_by_oid TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(link_id,executor_integration_id,action,target)
      );
      CREATE INDEX IF NOT EXISTS agent_link_executor_attachments_link
        ON agent_link_executor_attachments(link_id,enabled,created_at);
    `)
  }
}

function cleanStringMap(value: Record<string, string>): Record<string, string> {
  const entries = Object.entries(value)
  if (entries.length > 64) throw new Error('inputMapping supports at most 64 fields')
  return Object.fromEntries(entries.map(([key, path]) => {
    const cleanKey = key.trim()
    const cleanPath = path.trim()
    if (!cleanKey || cleanKey.length > 128 || !cleanPath || cleanPath.length > 512) throw new Error('Invalid input mapping')
    return [cleanKey, cleanPath]
  }))
}

function cleanCondition(value: LinkExecutorCondition): LinkExecutorCondition {
  const path = value.path.trim()
  if (!path || path.length > 512) throw new Error('Invalid condition path')
  return { path, equals: value.equals }
}

function conditionMatches(body: Record<string, unknown>, condition?: LinkExecutorCondition): boolean {
  if (!condition) return false
  return Object.is(readPath(body, condition.path), condition.equals)
}

function mapPayload(body: Record<string, unknown>, mapping: Record<string, string>): Record<string, unknown> {
  const entries = Object.entries(mapping)
  if (!entries.length) return { webhook: body }
  return Object.fromEntries(entries.map(([key, path]) => [key, readPath(body, path)]))
}

function templateTarget(template: string, body: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_match, path: string) => {
    const value = readPath(body, path)
    return value === undefined || value === null ? '' : String(value)
  })
}

function readPath(value: Record<string, unknown>, path: string): unknown {
  const clean = path.replace(/^\$\.?/, '')
  if (!clean) return value
  let cursor: unknown = value
  for (const segment of clean.split('.').filter(Boolean)) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return cursor
}
