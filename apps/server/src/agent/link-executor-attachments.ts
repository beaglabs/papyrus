import { randomUUID } from 'node:crypto'
import type { AgentDatabase } from './database.js'

type Row = Record<string, unknown>

export const WEBHOOK_EXECUTOR_INVOCATION_MODES = ['agent_decides', 'always', 'conditional'] as const
export type WebhookExecutorInvocationMode = (typeof WEBHOOK_EXECUTOR_INVOCATION_MODES)[number]
export type WebhookExecutorApprovalPolicy = 'inherit' | 'required'

export interface WebhookExecutorCondition {
  path: string
  exists?: boolean
  equals?: string | number | boolean | null
}

export interface WebhookExecutorAttachment {
  id: string
  linkId: string
  executorIntegrationId: string
  executorName: string
  action: string
  target: string
  enabled: boolean
  invocationMode: WebhookExecutorInvocationMode
  condition?: WebhookExecutorCondition
  inputMapping: Record<string, string>
  approvalPolicy: WebhookExecutorApprovalPolicy
  timeoutMs?: number
  maxRetries?: number
  createdByOid: string
  createdAt: string
  updatedAt: string
}

export interface AttachWebhookExecutorInput {
  linkId: string
  executorIntegrationId: string
  action: string
  target?: string
  invocationMode?: WebhookExecutorInvocationMode
  condition?: WebhookExecutorCondition
  inputMapping?: Record<string, string>
  approvalPolicy?: WebhookExecutorApprovalPolicy
  timeoutMs?: number
  maxRetries?: number
}

export interface WebhookExecutionContext {
  body: Record<string, unknown>
  link: { id: string; slug: string; name: string }
  inbound: { id: string; blobPath: string; method: string; receivedAt: string }
}

/**
 * Durable configuration for the relationship between a public Webhook Link and a governed
 * Action Executor. This table stores configuration only. Every automatic invocation still
 * becomes an AgentActionProposal and crosses the normal Papyrus approval/action-ledger path.
 */
export class LinkExecutorAttachmentStore {
  constructor(readonly db: AgentDatabase) { this.migrate() }

  list(linkId: string): WebhookExecutorAttachment[] {
    this.requireWebhookLink(linkId)
    return (this.db.sqlite.prepare(
      'SELECT * FROM agent_link_executor_attachments WHERE link_id=? ORDER BY created_at,id',
    ).all(linkId) as Row[]).map((row) => this.attachment(row))
  }

  get(id: string): WebhookExecutorAttachment | undefined {
    const row = this.db.sqlite.prepare('SELECT * FROM agent_link_executor_attachments WHERE id=?').get(id) as Row | undefined
    return row ? this.attachment(row) : undefined
  }

  attach(input: AttachWebhookExecutorInput, actorOid: string): WebhookExecutorAttachment {
    const link = this.requireWebhookLink(input.linkId)
    const executor = this.db.getIntegration(input.executorIntegrationId)
    if (!executor) throw new Error('Action Executor integration not found')
    if (executor.id === 'papyrus-links-system') throw new Error('The Papyrus Link publisher cannot be attached as a Webhook action executor')
    if (executor.state !== 'active') throw new Error('Action Executor integration must be active')
    if (executor.catalogId !== 'exchange-email' && executor.integrationClass !== 'action_executor' && executor.authority !== 'controlled_actions') {
      throw new Error('The selected integration is not an Action Executor')
    }

    const action = clean(input.action, 'Action', 256)
    const target = (input.target?.trim() || link.slug).slice(0, 1024)
    const invocationMode = input.invocationMode ?? 'agent_decides'
    if (!WEBHOOK_EXECUTOR_INVOCATION_MODES.includes(invocationMode)) throw new Error('Invalid Webhook executor invocation mode')
    const approvalPolicy = input.approvalPolicy ?? 'inherit'
    if (!['inherit', 'required'].includes(approvalPolicy)) throw new Error('Invalid Webhook executor approval policy')
    const inputMapping = validateInputMapping(input.inputMapping ?? {})
    const condition = input.condition ? validateCondition(input.condition) : undefined
    if (invocationMode === 'conditional' && !condition) throw new Error('Conditional Webhook executor attachments require a condition')
    const timeoutMs = boundedInteger(input.timeoutMs, 1_000, 120_000, 'timeoutMs')
    // The action worker has a deployment-level three-attempt ceiling today. Per-attachment
    // retries may tighten that boundary, never silently expand it.
    const maxRetries = boundedInteger(input.maxRetries, 0, 2, 'maxRetries')

    const now = new Date().toISOString()
    const id = randomUUID()
    // Approved configuration changes are retried by the normal leased action worker. Use the
    // attachment's natural identity as an upsert key so a worker retry after a successful DB
    // write cannot turn an already-applied approval into a false terminal failure. A second,
    // separately approved attach request for the same identity intentionally updates policy.
    this.db.sqlite.prepare(`INSERT INTO agent_link_executor_attachments(
      id,link_id,executor_integration_id,action,target,enabled,invocation_mode,condition_json,input_mapping_json,
      approval_policy,timeout_ms,max_retries,created_by_oid,created_at,updated_at
    ) VALUES(?,?,?,?,?,1,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(link_id,executor_integration_id,action,target) DO UPDATE SET
      enabled=1,
      invocation_mode=excluded.invocation_mode,
      condition_json=excluded.condition_json,
      input_mapping_json=excluded.input_mapping_json,
      approval_policy=excluded.approval_policy,
      timeout_ms=excluded.timeout_ms,
      max_retries=excluded.max_retries,
      updated_at=excluded.updated_at`).run(
      id,
      input.linkId,
      executor.id,
      action,
      target,
      invocationMode,
      condition ? JSON.stringify(condition) : null,
      JSON.stringify(inputMapping),
      approvalPolicy,
      timeoutMs ?? null,
      maxRetries ?? null,
      actorOid,
      now,
      now,
    )
    const row = this.db.sqlite.prepare(`SELECT * FROM agent_link_executor_attachments
      WHERE link_id=? AND executor_integration_id=? AND action=? AND target=?`).get(
      input.linkId,
      executor.id,
      action,
      target,
    ) as Row | undefined
    if (!row) throw new Error('Webhook Action Executor attachment could not be persisted')
    return this.attachment(row)
  }

  detach(linkId: string, attachmentId: string): void {
    this.requireWebhookLink(linkId)
    const result = this.db.sqlite.prepare('DELETE FROM agent_link_executor_attachments WHERE id=? AND link_id=?').run(attachmentId, linkId)
    if (result.changes !== 1) throw new Error('Webhook Action Executor attachment not found')
  }

  setEnabled(linkId: string, attachmentId: string, enabled: boolean): WebhookExecutorAttachment {
    this.requireWebhookLink(linkId)
    const now = new Date().toISOString()
    const result = this.db.sqlite.prepare('UPDATE agent_link_executor_attachments SET enabled=?,updated_at=? WHERE id=? AND link_id=?')
      .run(enabled ? 1 : 0, now, attachmentId, linkId)
    if (result.changes !== 1) throw new Error('Webhook Action Executor attachment not found')
    return this.get(attachmentId) as WebhookExecutorAttachment
  }

  private requireWebhookLink(linkId: string): { id: string; slug: string } {
    const row = this.db.sqlite.prepare("SELECT id,slug,type FROM agent_links WHERE id=? AND deleted_at IS NULL").get(linkId) as Row | undefined
    if (!row) throw new Error('Link not found')
    if (row.type !== 'webhook') throw new Error('Action Executors can only be attached to Webhook Links')
    return { id: String(row.id), slug: String(row.slug) }
  }

  private attachment(row: Row): WebhookExecutorAttachment {
    const executor = this.db.getIntegration(String(row.executor_integration_id))
    return {
      id: String(row.id),
      linkId: String(row.link_id),
      executorIntegrationId: String(row.executor_integration_id),
      executorName: executor?.name ?? String(row.executor_integration_id),
      action: String(row.action),
      target: String(row.target),
      enabled: Number(row.enabled) === 1,
      invocationMode: row.invocation_mode as WebhookExecutorInvocationMode,
      ...(row.condition_json ? { condition: JSON.parse(String(row.condition_json)) as WebhookExecutorCondition } : {}),
      inputMapping: JSON.parse(String(row.input_mapping_json || '{}')) as Record<string, string>,
      approvalPolicy: row.approval_policy as WebhookExecutorApprovalPolicy,
      ...(row.timeout_ms === null || row.timeout_ms === undefined ? {} : { timeoutMs: Number(row.timeout_ms) }),
      ...(row.max_retries === null || row.max_retries === undefined ? {} : { maxRetries: Number(row.max_retries) }),
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
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
        invocation_mode TEXT NOT NULL CHECK(invocation_mode IN ('agent_decides','always','conditional')),
        condition_json TEXT,
        input_mapping_json TEXT NOT NULL DEFAULT '{}',
        approval_policy TEXT NOT NULL CHECK(approval_policy IN ('inherit','required')),
        timeout_ms INTEGER,
        max_retries INTEGER,
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

export function attachmentMatches(attachment: WebhookExecutorAttachment, context: WebhookExecutionContext): boolean {
  if (!attachment.enabled) return false
  if (attachment.invocationMode === 'always') return true
  if (attachment.invocationMode !== 'conditional' || !attachment.condition) return false
  const value = valueAtPath(context, attachment.condition.path)
  if (attachment.condition.exists !== undefined && attachment.condition.exists !== (value !== undefined)) return false
  if ('equals' in attachment.condition && value !== attachment.condition.equals) return false
  return true
}

export function attachmentParameters(attachment: WebhookExecutorAttachment, context: WebhookExecutionContext): Record<string, unknown> {
  const mapped: Record<string, unknown> = {}
  for (const [parameter, sourcePath] of Object.entries(attachment.inputMapping)) {
    const value = valueAtPath(context, sourcePath)
    if (value !== undefined) mapped[parameter] = value
  }
  return {
    ...mapped,
    __papyrusWebhook: {
      linkId: context.link.id,
      inboundId: context.inbound.id,
      blobPath: context.inbound.blobPath,
      method: context.inbound.method,
      receivedAt: context.inbound.receivedAt,
    },
    __papyrusExecutionPolicy: {
      approval: attachment.approvalPolicy,
      ...(attachment.timeoutMs === undefined ? {} : { timeoutMs: attachment.timeoutMs }),
      ...(attachment.maxRetries === undefined ? {} : { maxRetries: attachment.maxRetries }),
    },
  }
}

export function attachmentTarget(attachment: WebhookExecutorAttachment, context: WebhookExecutionContext): string {
  return attachment.target.replace(/\{([^{}]+)\}/g, (_match, path: string) => {
    const value = valueAtPath(context, path.trim())
    return value === undefined || value === null ? '' : String(value)
  })
}

function valueAtPath(root: WebhookExecutionContext, path: string): unknown {
  const segments = path.trim().replace(/^\$\.?/, '').split('.').filter(Boolean)
  let value: unknown = root
  for (const segment of segments) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    value = (value as Record<string, unknown>)[segment]
  }
  return value
}

function validateInputMapping(value: Record<string, string>): Record<string, string> {
  const entries = Object.entries(value)
  if (entries.length > 64) throw new Error('Webhook executor input mapping cannot contain more than 64 fields')
  return Object.fromEntries(entries.map(([key, path]) => [clean(key, 'Input parameter', 128), clean(path, 'Input mapping path', 256)]))
}

function validateCondition(value: WebhookExecutorCondition): WebhookExecutorCondition {
  const path = clean(value.path, 'Condition path', 256)
  if (value.exists === undefined && !Object.prototype.hasOwnProperty.call(value, 'equals')) {
    throw new Error('Webhook executor condition must specify exists or equals')
  }
  if (value.equals !== undefined && !['string', 'number', 'boolean'].includes(typeof value.equals) && value.equals !== null) {
    throw new Error('Webhook executor condition equals must be a scalar value')
  }
  return {
    path,
    ...(value.exists === undefined ? {} : { exists: Boolean(value.exists) }),
    ...(Object.prototype.hasOwnProperty.call(value, 'equals') ? { equals: value.equals ?? null } : {}),
  }
}

function boundedInteger(value: number | undefined, minimum: number, maximum: number, name: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
  return value
}

function clean(value: string, name: string, maximum: number): string {
  const cleaned = value.trim()
  if (!cleaned || cleaned.length > maximum) throw new Error(`${name} is required and must not exceed ${maximum} characters`)
  return cleaned
}