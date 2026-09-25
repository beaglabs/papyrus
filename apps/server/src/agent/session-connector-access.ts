import type { IntegrationConfiguration } from '@papyrus/contracts'
import { LINK_PUBLISHER_CATALOG_ID } from './catalog.js'
import type { AgentDatabase } from './database.js'

/**
 * Low-level authorization for using a deployment integration from an Agent session.
 *
 * Integrations are deployment configuration. A session binding is the capability
 * grant that lets one Agent thread use that integration. Callers must not treat an
 * active integration as implicitly available to every session.
 *
 * Papyrus Links is deliberately exempt: it is an internal, approval-backed system
 * executor created by the runtime rather than a connector an operator attaches.
 */
export class SessionConnectorAccessError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'SessionConnectorAccessError'
  }
}

export interface SessionConnectorScope {
  sessionId: string
  actorOid?: string
}

export function requireSessionConnectorBinding(
  db: AgentDatabase,
  integrationId: string,
  scope: SessionConnectorScope,
): IntegrationConfiguration {
  ensureSessionConnectorSchema(db)
  const integration = db.getIntegration(integrationId)
  if (!integration) {
    throw new SessionConnectorAccessError(404, 'INTEGRATION_NOT_FOUND', 'Integration not found')
  }
  if (integration.state !== 'active') {
    throw new SessionConnectorAccessError(409, 'INTEGRATION_NOT_ACTIVE', `${integration.name} is not active`)
  }
  if (integration.catalogId === LINK_PUBLISHER_CATALOG_ID) return integration

  const sessionId = scope.sessionId.trim()
  if (!sessionId) {
    throw new SessionConnectorAccessError(409, 'SESSION_CONNECTOR_SCOPE_REQUIRED', 'Connector dispatch requires an Agent session')
  }

  const row = scope.actorOid
    ? db.sqlite.prepare(`SELECT integration_id,catalog_id FROM agent_session_connectors
        WHERE session_id=? AND actor_oid=? AND integration_id=? LIMIT 1`)
      .get(sessionId, scope.actorOid, integrationId) as { integration_id?: string; catalog_id?: string } | undefined
    : db.sqlite.prepare(`SELECT integration_id,catalog_id FROM agent_session_connectors
        WHERE session_id=? AND integration_id=? LIMIT 1`)
      .get(sessionId, integrationId) as { integration_id?: string; catalog_id?: string } | undefined

  if (!row || row.integration_id !== integrationId || row.catalog_id !== integration.catalogId) {
    throw new SessionConnectorAccessError(
      403,
      'SESSION_CONNECTOR_NOT_BOUND',
      `${integration.name} is not connected to this Agent session`,
    )
  }
  return integration
}

export function sessionIntegrationForCatalog(
  db: AgentDatabase,
  catalogId: string,
  scope: SessionConnectorScope,
): IntegrationConfiguration {
  ensureSessionConnectorSchema(db)
  const row = scope.actorOid
    ? db.sqlite.prepare(`SELECT integration_id FROM agent_session_connectors
        WHERE session_id=? AND actor_oid=? AND catalog_id=? LIMIT 1`)
      .get(scope.sessionId, scope.actorOid, catalogId) as { integration_id?: string } | undefined
    : db.sqlite.prepare(`SELECT integration_id FROM agent_session_connectors
        WHERE session_id=? AND catalog_id=? LIMIT 1`)
      .get(scope.sessionId, catalogId) as { integration_id?: string } | undefined
  if (!row?.integration_id) {
    throw new SessionConnectorAccessError(403, 'SESSION_CONNECTOR_NOT_BOUND', `${catalogId} is not connected to this Agent session`)
  }
  const integration = requireSessionConnectorBinding(db, row.integration_id, scope)
  if (integration.catalogId !== catalogId) {
    throw new SessionConnectorAccessError(403, 'SESSION_CONNECTOR_NOT_BOUND', `${catalogId} is not connected to this Agent session`)
  }
  return integration
}

export function isSessionConnectorBound(
  db: AgentDatabase,
  integrationId: string,
  scope: SessionConnectorScope,
): boolean {
  try {
    requireSessionConnectorBinding(db, integrationId, scope)
    return true
  } catch (cause) {
    if (cause instanceof SessionConnectorAccessError) return false
    throw cause
  }
}

/** Kept here so the low-level worker can enforce the boundary after a restart. */
export function ensureSessionConnectorSchema(db: AgentDatabase): void {
  db.sqlite.exec(`
    CREATE TABLE IF NOT EXISTS agent_session_connectors (
      session_id TEXT NOT NULL,
      catalog_id TEXT NOT NULL,
      integration_id TEXT,
      actor_oid TEXT NOT NULL,
      setup_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(session_id,catalog_id)
    );
    CREATE INDEX IF NOT EXISTS agent_session_connectors_integration
      ON agent_session_connectors(integration_id,session_id);
    CREATE INDEX IF NOT EXISTS agent_session_connectors_actor
      ON agent_session_connectors(actor_oid,session_id);
  `)
}
