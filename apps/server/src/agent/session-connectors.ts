import type { IntegrationCatalogEntry, IntegrationConfiguration, PortalPrincipal } from '@papyrus/contracts'
import type { AgentDatabase } from './database.js'
import { AgentService, AgentServiceError } from './service.js'

export type SessionConnectorStatus = 'connected' | 'degraded' | 'available' | 'needs_setup' | 'pending'

export interface SessionConnectorSummary {
  catalogId: string
  name: string
  vendor: string
  description: string
  initials: string
  accent: string
  authority: IntegrationCatalogEntry['authority']
  integrationClass: IntegrationCatalogEntry['integrationClass']
  capabilities: string[]
  authSchemes: IntegrationCatalogEntry['authSchemes']
  syncMode: IntegrationCatalogEntry['syncMode']
  status: SessionConnectorStatus
  integrationId?: string
  integrationState?: IntegrationConfiguration['state']
  health?: IntegrationConfiguration['health']
  requiresCredentialReference: boolean
  requiresEndpoint: boolean
  setupMessage?: string
}

type BindingRow = {
  session_id: string
  catalog_id: string
  integration_id: string
  actor_oid: string
  setup_message: string | null
  created_at: string
  updated_at: string
}

/**
 * A connector configuration is deployment-owned, but its authority is attached to a
 * conversation explicitly. This store is the durable join between a Mastra thread and an
 * integration. It intentionally stores only ids and status text: credentials remain in the
 * customer vault / integration configuration and never enter session memory.
 */
export class SessionConnectorStore {
  constructor(private readonly db: AgentDatabase) {
    this.migrate()
  }

  list(service: AgentService, actor: PortalPrincipal, sessionId: string, query = ''): SessionConnectorSummary[] {
    const catalog = service.catalog(actor)
    const integrations = service.integrations(actor)
    const bindings = this.bindings(sessionId, actor.oid)
    const normalizedQuery = query.trim().toLowerCase()

    return catalog
      .map((entry) => this.summary(entry, integrations, bindings.get(entry.id)))
      .filter((item) => !normalizedQuery || [
        item.name,
        item.vendor,
        item.description,
        item.catalogId,
        ...item.capabilities,
      ].some((value) => value.toLowerCase().includes(normalizedQuery)))
      .sort((left, right) => {
        const rank: Record<SessionConnectorStatus, number> = { connected: 0, degraded: 1, available: 2, pending: 3, needs_setup: 4 }
        return rank[left.status] - rank[right.status] || left.name.localeCompare(right.name)
      })
  }

  connect(service: AgentService, actor: PortalPrincipal, sessionId: string, catalogId: string, integrationId?: string): SessionConnectorSummary {
    const entry = this.entry(service, actor, catalogId)
    const integrations = service.integrations(actor)
    const integration = integrationId
      ? integrations.find((candidate) => candidate.id === integrationId && candidate.catalogId === catalogId)
      : integrations.find((candidate) => candidate.catalogId === catalogId && candidate.state === 'active')

    if (!integration || integration.state !== 'active') {
      throw new SessionConnectorError(409, 'SESSION_CONNECTOR_SETUP_REQUIRED', `${entry.name} needs setup before it can be connected to this session`)
    }

    this.bind(sessionId, actor.oid, entry.id, integration.id)
    return this.summary(entry, service.integrations(actor), this.binding(sessionId, actor.oid, entry.id))
  }

  async setup(
    service: AgentService,
    actor: PortalPrincipal,
    sessionId: string,
    catalogId: string,
    input: Record<string, unknown>,
  ): Promise<SessionConnectorSummary> {
    const entry = this.entry(service, actor, catalogId)
    const requiresCredentialReference = credentialReferenceRequired(entry)
    const requiresEndpoint = endpointRequired(entry)
    const credentialRef = text(input.credentialRef)
    const endpoint = text(input.endpoint)

    if (requiresCredentialReference && !credentialRef) {
      throw new SessionConnectorError(400, 'SESSION_CONNECTOR_CREDENTIAL_REQUIRED', `${entry.name} requires a customer-vault, certificate, or managed-identity reference`)
    }
    if (requiresEndpoint && !endpoint) {
      throw new SessionConnectorError(400, 'SESSION_CONNECTOR_ENDPOINT_REQUIRED', `${entry.name} requires an HTTPS endpoint`)
    }

    const existing = this.binding(sessionId, actor.oid, entry.id)
    if (existing) {
      const integration = service.integrations(actor).find((candidate) => candidate.id === existing.integration_id)
      if (integration && integration.state !== 'disabled') {
        const lifecycle = await this.advance(service, actor, integration)
        this.updateSetupMessage(sessionId, actor.oid, entry.id, lifecycle.message)
        return this.summary(entry, service.integrations(actor), this.binding(sessionId, actor.oid, entry.id))
      }
    }

    const integration = service.createIntegration(actor, entry.id, {
      name: text(input.name) || entry.name,
      scope: text(input.scope) || `session:${sessionId}`,
      ...(endpoint ? { endpoint } : {}),
      ...(credentialRef ? { credentialRef } : {}),
      settings: record(input.settings),
    })
    this.bind(sessionId, actor.oid, entry.id, integration.id)

    const lifecycle = await this.advance(service, actor, integration)
    this.updateSetupMessage(sessionId, actor.oid, entry.id, lifecycle.message)
    return this.summary(entry, service.integrations(actor), this.binding(sessionId, actor.oid, entry.id))
  }

  disconnect(actor: PortalPrincipal, sessionId: string, catalogId: string): void {
    this.db.sqlite.prepare('DELETE FROM agent_session_connectors WHERE session_id=? AND actor_oid=? AND catalog_id=?')
      .run(sessionId, actor.oid, catalogId)
  }

  isIntegrationConnected(actor: PortalPrincipal, sessionId: string, integrationId: string): boolean {
    return Boolean(this.db.sqlite.prepare(`
      SELECT 1 FROM agent_session_connectors
      WHERE session_id=? AND actor_oid=? AND integration_id=? LIMIT 1
    `).get(sessionId, actor.oid, integrationId))
  }

  private async advance(service: AgentService, actor: PortalPrincipal, original: IntegrationConfiguration): Promise<{ integration: IntegrationConfiguration; message?: string }> {
    let integration = original
    try {
      if (integration.state === 'draft') integration = await service.testIntegration(actor, integration.id)
      if (integration.state === 'tested') integration = service.submitIntegration(actor, integration.id)
      if (integration.state === 'awaiting_approval') integration = service.activateIntegration(actor, integration.id)
      return { integration }
    } catch (cause) {
      if (cause instanceof AgentServiceError && [403, 409].includes(cause.status)) {
        return { integration: service.getIntegration(actor, integration.id), message: cause.message }
      }
      throw cause
    }
  }

  private summary(entry: IntegrationCatalogEntry, integrations: IntegrationConfiguration[], binding?: BindingRow): SessionConnectorSummary {
    const bound = binding ? integrations.find((candidate) => candidate.id === binding.integration_id) : undefined
    const reusable = integrations.find((candidate) => candidate.catalogId === entry.id && candidate.state === 'active')
    const integration = bound ?? reusable
    const status: SessionConnectorStatus = bound
      ? bound.state === 'active'
        ? bound.health === 'degraded' || bound.health === 'unreachable' ? 'degraded' : 'connected'
        : 'pending'
      : reusable
        ? 'available'
        : 'needs_setup'

    return {
      catalogId: entry.id,
      name: entry.name,
      vendor: entry.vendor,
      description: entry.description,
      initials: entry.initials,
      accent: entry.accent,
      authority: entry.authority,
      integrationClass: entry.integrationClass,
      capabilities: entry.capabilities,
      authSchemes: entry.authSchemes,
      syncMode: entry.syncMode,
      status,
      ...(integration ? { integrationId: integration.id, integrationState: integration.state, health: integration.health } : {}),
      requiresCredentialReference: credentialReferenceRequired(entry),
      requiresEndpoint: endpointRequired(entry),
      ...(binding?.setup_message ? { setupMessage: binding.setup_message } : {}),
    }
  }

  private entry(service: AgentService, actor: PortalPrincipal, catalogId: string): IntegrationCatalogEntry {
    const entry = service.catalog(actor).find((candidate) => candidate.id === catalogId)
    if (!entry) throw new SessionConnectorError(404, 'SESSION_CONNECTOR_NOT_FOUND', 'Connector is not available in this deployment profile')
    return entry
  }

  private binding(sessionId: string, actorOid: string, catalogId: string): BindingRow | undefined {
    return this.db.sqlite.prepare(`
      SELECT session_id,catalog_id,integration_id,actor_oid,setup_message,created_at,updated_at
      FROM agent_session_connectors WHERE session_id=? AND actor_oid=? AND catalog_id=?
    `).get(sessionId, actorOid, catalogId) as BindingRow | undefined
  }

  private bindings(sessionId: string, actorOid: string): Map<string, BindingRow> {
    const rows = this.db.sqlite.prepare(`
      SELECT session_id,catalog_id,integration_id,actor_oid,setup_message,created_at,updated_at
      FROM agent_session_connectors WHERE session_id=? AND actor_oid=?
    `).all(sessionId, actorOid) as BindingRow[]
    return new Map(rows.map((row) => [row.catalog_id, row]))
  }

  private bind(sessionId: string, actorOid: string, catalogId: string, integrationId: string): void {
    const now = new Date().toISOString()
    this.db.sqlite.prepare(`
      INSERT INTO agent_session_connectors(session_id,catalog_id,integration_id,actor_oid,setup_message,created_at,updated_at)
      VALUES(?,?,?,?,NULL,?,?)
      ON CONFLICT(session_id,catalog_id) DO UPDATE SET
        integration_id=excluded.integration_id,
        actor_oid=excluded.actor_oid,
        setup_message=NULL,
        updated_at=excluded.updated_at
    `).run(sessionId, catalogId, integrationId, actorOid, now, now)
  }

  private updateSetupMessage(sessionId: string, actorOid: string, catalogId: string, message?: string): void {
    this.db.sqlite.prepare(`
      UPDATE agent_session_connectors SET setup_message=?,updated_at=?
      WHERE session_id=? AND actor_oid=? AND catalog_id=?
    `).run(message ?? null, new Date().toISOString(), sessionId, actorOid, catalogId)
  }

  private migrate(): void {
    this.db.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS agent_session_connectors (
        session_id TEXT NOT NULL,
        catalog_id TEXT NOT NULL,
        integration_id TEXT NOT NULL,
        actor_oid TEXT NOT NULL,
        setup_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(session_id,catalog_id)
      );
      CREATE INDEX IF NOT EXISTS agent_session_connectors_actor_session
        ON agent_session_connectors(actor_oid,session_id,updated_at DESC);
      CREATE INDEX IF NOT EXISTS agent_session_connectors_integration
        ON agent_session_connectors(integration_id);
    `)
  }
}

export class SessionConnectorError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

function credentialReferenceRequired(entry: IntegrationCatalogEntry): boolean {
  return !entry.authSchemes.includes('none') && !entry.authSchemes.includes('entra')
}

function endpointRequired(entry: IntegrationCatalogEntry): boolean {
  return ['a2a-peer', 'acp-client', 'firewall-executor'].includes(entry.id)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function record(value: unknown): Record<string, string | number | boolean> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SessionConnectorError(400, 'SESSION_CONNECTOR_INVALID_SETTINGS', 'settings must be an object')
  const output: Record<string, string | number | boolean> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!['string', 'number', 'boolean'].includes(typeof item)) throw new SessionConnectorError(400, 'SESSION_CONNECTOR_INVALID_SETTINGS', `settings.${key} must be a string, number, or boolean`)
    output[key] = item as string | number | boolean
  }
  return output
}
