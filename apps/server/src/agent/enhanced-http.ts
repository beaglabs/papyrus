import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'
import type { PortalPrincipal } from '@papyrus/contracts'
import type { EntraAuthService } from './entra-auth.js'
import type { AgentService } from './service.js'
import { AcpPlaneError, isAcpHarnessId } from './acp-plane.js'
import { EnhancedMastraRuntime } from './mastra/enhanced-runtime.js'
import { MastraRuntimeError } from './mastra/runtime.js'
import { SessionConnectorError, SessionConnectorStore, type SessionConnectorSummary } from './session-connectors.js'

interface RequestServer {
  listeners(event: 'request'): Function[]
  removeAllListeners(event: 'request'): unknown
  on(event: 'request', listener: RequestListener): unknown
}

/**
 * Wrap the existing portal server without duplicating its large route table.
 *
 * The wrapper does two things before handing ordinary session routes back to
 * the original handler: authenticate the Entra principal and bind it to an
 * AsyncLocalStorage scope consumed by EnhancedMastraRuntime. ACP/work/fact/event
 * routes and the session connector plane terminate here because they belong to
 * the enhanced, user/session-scoped runtime.
 */
export function installEnhancedAgentPlane(
  server: RequestServer,
  service: AgentService,
  auth: EntraAuthService,
  runtime: EnhancedMastraRuntime,
): void {
  const original = server.listeners('request')[0] as RequestListener | undefined
  if (!original) throw new Error('Papyrus HTTP server has no request listener to wrap')
  const connectors = new SessionConnectorStore(service.db)
  server.removeAllListeners('request')
  server.on('request', (request, response) => {
    void route(request, response, service, auth, runtime, connectors, original)
  })
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  service: AgentService,
  auth: EntraAuthService,
  runtime: EnhancedMastraRuntime,
  connectors: SessionConnectorStore,
  original: RequestListener,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'https://papyrus.local')
  try {
    const enhanced = matchEnhanced(url.pathname)
    if (enhanced) {
      const actor = await principal(request, auth, service)
      await runtime.runAs(actor, async () => {
        await runtime.assertActorSession(enhanced.sessionId, actor)

        if (enhanced.kind === 'acp-list' && request.method === 'GET') {
          return json(response, 200, { sessionId: enhanced.sessionId, harnesses: runtime.acpStatus(enhanced.sessionId) })
        }
        if (enhanced.kind === 'acp-connect' && request.method === 'POST' && enhanced.harnessId) {
          const harness = await runtime.connectAcp(enhanced.sessionId, enhanced.harnessId)
          return json(response, 200, { sessionId: enhanced.sessionId, harness })
        }
        if (enhanced.kind === 'acp-disconnect' && request.method === 'DELETE' && enhanced.harnessId) {
          await runtime.disconnectAcp(enhanced.sessionId, enhanced.harnessId)
          return json(response, 200, { sessionId: enhanced.sessionId, harnessId: enhanced.harnessId, disconnected: true })
        }
        if (enhanced.kind === 'work' && request.method === 'GET') {
          return json(response, 200, { sessionId: enhanced.sessionId, work: runtime.sessionWork(enhanced.sessionId) })
        }
        if (enhanced.kind === 'facts' && request.method === 'GET') {
          return json(response, 200, { sessionId: enhanced.sessionId, facts: runtime.sessionFacts(enhanced.sessionId) })
        }
        if (enhanced.kind === 'events' && request.method === 'GET') {
          const after = numberQuery(url.searchParams.get('after'), 0, 0, Number.MAX_SAFE_INTEGER)
          const limit = numberQuery(url.searchParams.get('limit'), 200, 1, 500)
          return json(response, 200, { sessionId: enhanced.sessionId, events: runtime.sessionEvents(enhanced.sessionId, after, limit) })
        }
        if (enhanced.kind === 'connector-list' && request.method === 'GET') {
          const query = (url.searchParams.get('q') ?? '').slice(0, 256)
          return json(response, 200, {
            sessionId: enhanced.sessionId,
            connectors: connectors.list(service, actor, enhanced.sessionId, query),
          })
        }
        if (enhanced.kind === 'connector-connect' && request.method === 'POST' && enhanced.catalogId) {
          const input = await body(request)
          const connector = connectors.connect(
            service,
            actor,
            enhanced.sessionId,
            enhanced.catalogId,
            typeof input.integrationId === 'string' ? input.integrationId : undefined,
          )
          recordConnectorState(runtime, actor, enhanced.sessionId, connector)
          return json(response, 200, { sessionId: enhanced.sessionId, connector })
        }
        if (enhanced.kind === 'connector-setup' && request.method === 'POST' && enhanced.catalogId) {
          const connector = await connectors.setup(service, actor, enhanced.sessionId, enhanced.catalogId, await body(request))
          recordConnectorState(runtime, actor, enhanced.sessionId, connector)
          return json(response, connector.status === 'connected' || connector.status === 'degraded' ? 200 : 202, {
            sessionId: enhanced.sessionId,
            connector,
          })
        }
        if (enhanced.kind === 'connector-disconnect' && request.method === 'DELETE' && enhanced.catalogId) {
          connectors.disconnect(actor, enhanced.sessionId, enhanced.catalogId)
          runtime.workGraph.rememberFact(
            enhanced.sessionId,
            actor.oid,
            `connector.${enhanced.catalogId}`,
            'disconnected from this session',
            'operator',
          )
          runtime.workGraph.appendEvent(enhanced.sessionId, actor.oid, 'connector.disconnected', { catalogId: enhanced.catalogId })
          return json(response, 200, { sessionId: enhanced.sessionId, catalogId: enhanced.catalogId, disconnected: true })
        }
        return json(response, 405, { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' })
      })
      return
    }

    // These original routes operate on a Mastra thread. Bind the authenticated
    // principal before the existing implementation runs so the runtime can
    // enforce ownership without teaching every legacy handler a new signature.
    if (isSessionScopedOriginalRoute(url.pathname)) {
      const actor = await principal(request, auth, service)
      await runtime.runAs(actor, () => invoke(original, request, response))
      return
    }

    await invoke(original, request, response)
  } catch (cause) {
    if (response.headersSent || response.writableEnded) {
      response.destroy(cause instanceof Error ? cause : new Error(String(cause)))
      return
    }
    const failure = httpFailure(cause)
    json(response, failure.status, { error: failure.message, code: failure.code })
  }
}

function matchEnhanced(pathname: string): {
  kind:
    | 'acp-list'
    | 'acp-connect'
    | 'acp-disconnect'
    | 'work'
    | 'facts'
    | 'events'
    | 'connector-list'
    | 'connector-connect'
    | 'connector-setup'
    | 'connector-disconnect'
  sessionId: string
  harnessId?: 'codex' | 'claude' | 'opencode'
  catalogId?: string
} | undefined {
  const acpList = pathname.match(/^\/api\/sessions\/([^/]+)\/acp$/)
  if (acpList) return { kind: 'acp-list', sessionId: decodeURIComponent(acpList[1] as string) }
  const acp = pathname.match(/^\/api\/sessions\/([^/]+)\/acp\/([^/]+)\/(connect|disconnect)$/)
  if (acp) {
    const harness = decodeURIComponent(acp[2] as string)
    if (!isAcpHarnessId(harness)) throw new EnhancedHttpError(404, 'ACP_HARNESS_NOT_FOUND', 'Unknown ACP harness')
    return {
      kind: acp[3] === 'connect' ? 'acp-connect' : 'acp-disconnect',
      sessionId: decodeURIComponent(acp[1] as string),
      harnessId: harness,
    }
  }
  const connectorList = pathname.match(/^\/api\/sessions\/([^/]+)\/connectors$/)
  if (connectorList) return { kind: 'connector-list', sessionId: decodeURIComponent(connectorList[1] as string) }
  const connectorAction = pathname.match(/^\/api\/sessions\/([^/]+)\/connectors\/([^/]+)\/(connect|setup)$/)
  if (connectorAction) return {
    kind: connectorAction[3] === 'connect' ? 'connector-connect' : 'connector-setup',
    sessionId: decodeURIComponent(connectorAction[1] as string),
    catalogId: decodeURIComponent(connectorAction[2] as string),
  }
  const connectorResource = pathname.match(/^\/api\/sessions\/([^/]+)\/connectors\/([^/]+)$/)
  if (connectorResource) return {
    kind: 'connector-disconnect',
    sessionId: decodeURIComponent(connectorResource[1] as string),
    catalogId: decodeURIComponent(connectorResource[2] as string),
  }
  const work = pathname.match(/^\/api\/sessions\/([^/]+)\/(work|facts|events)$/)
  if (work) return { kind: work[2] as 'work' | 'facts' | 'events', sessionId: decodeURIComponent(work[1] as string) }
  return undefined
}

function isSessionScopedOriginalRoute(pathname: string): boolean {
  return pathname === '/api/sessions' || pathname.startsWith('/api/sessions/') || pathname === '/api/agent/chat' || pathname === '/api/agent/status'
}

async function principal(request: IncomingMessage, auth: EntraAuthService, service: AgentService): Promise<PortalPrincipal> {
  const value = await auth.authenticate(request)
  if (!value) throw new EnhancedHttpError(401, 'ENTRA_AUTHENTICATION_REQUIRED', 'Microsoft Entra authentication is required')
  service.requirePortalAccess(value)
  return value
}

async function body(request: IncomingMessage, maximumBytes = 1_048_576): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maximumBytes) throw new EnhancedHttpError(413, 'BODY_TOO_LARGE', 'Request body exceeds 1 MiB')
    chunks.push(buffer)
  }
  if (!chunks.length) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object required')
    return parsed as Record<string, unknown>
  } catch {
    throw new EnhancedHttpError(400, 'INVALID_JSON', 'Request body must be a JSON object')
  }
}

function recordConnectorState(runtime: EnhancedMastraRuntime, actor: PortalPrincipal, sessionId: string, connector: SessionConnectorSummary): void {
  const details = [
    connector.status,
    connector.integrationId ? `integration=${connector.integrationId}` : '',
    connector.integrationState ? `state=${connector.integrationState}` : '',
    connector.health ? `health=${connector.health}` : '',
    connector.capabilities.length ? `capabilities=${connector.capabilities.join(', ')}` : '',
  ].filter(Boolean).join('; ')
  runtime.workGraph.rememberFact(sessionId, actor.oid, `connector.${connector.catalogId}`, details, 'operator')
  runtime.workGraph.appendEvent(sessionId, actor.oid, 'connector.connection_changed', {
    catalogId: connector.catalogId,
    integrationId: connector.integrationId ?? null,
    status: connector.status,
    integrationState: connector.integrationState ?? null,
  })
}

function invoke(listener: RequestListener, request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    listener(request, response)
    return Promise.resolve()
  } catch (cause) {
    return Promise.reject(cause)
  }
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  const value = Buffer.from(JSON.stringify(payload))
  response.setHeader('cache-control', 'no-store')
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('content-length', String(value.byteLength))
  response.setHeader('x-content-type-options', 'nosniff')
  response.writeHead(status)
  response.end(value)
}

function numberQuery(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null || value.trim() === '') return fallback
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.floor(number))) : fallback
}

function httpFailure(cause: unknown): { status: number; code: string; message: string } {
  if (cause instanceof EnhancedHttpError || cause instanceof MastraRuntimeError || cause instanceof SessionConnectorError) {
    return { status: cause.status, code: cause.code, message: cause.message }
  }
  if (cause instanceof AcpPlaneError) {
    const status = cause.code === 'ACP_HARNESS_UNAVAILABLE' ? 409 : cause.code === 'ACP_CONNECT_FAILED' ? 502 : 500
    return { status, code: cause.code, message: cause.message }
  }
  const value = cause as { status?: unknown; code?: unknown; message?: unknown }
  if (typeof value?.status === 'number' && typeof value?.code === 'string') {
    return { status: value.status, code: value.code, message: typeof value.message === 'string' ? value.message : value.code }
  }
  return { status: 500, code: 'INTERNAL_ERROR', message: cause instanceof Error ? cause.message : 'Unexpected server failure' }
}

class EnhancedHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}
