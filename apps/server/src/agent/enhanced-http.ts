import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'
import type { EntraAppRole, PortalPrincipal } from '@papyrus/contracts'
import type { EntraAuthService } from './entra-auth.js'
import type { AgentService } from './service.js'
import { AcpPlaneError, isAcpHarnessId } from './acp-plane.js'
import { linkActionAttachments, type AttachLinkExecutorInput } from './link-action-attachments.js'
import { EnhancedMastraRuntime } from './mastra/enhanced-runtime.js'
import { MastraRuntimeError } from './mastra/runtime.js'

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
 * routes terminate here because they belong to the enhanced plane.
 */
export function installEnhancedAgentPlane(
  server: RequestServer,
  service: AgentService,
  auth: EntraAuthService,
  runtime: EnhancedMastraRuntime,
): void {
  const original = server.listeners('request')[0] as RequestListener | undefined
  if (!original) throw new Error('Papyrus HTTP server has no request listener to wrap')
  server.removeAllListeners('request')
  server.on('request', (request, response) => {
    void route(request, response, service, auth, runtime, original)
  })
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  service: AgentService,
  auth: EntraAuthService,
  runtime: EnhancedMastraRuntime,
  original: RequestListener,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'https://papyrus.local')
  try {
    const attachmentRoute = matchLinkExecutorAttachment(url.pathname)
    if (attachmentRoute) {
      const actor = await principal(request, auth, service)
      const link = runtime.links.get(attachmentRoute.linkId)
      if (!link) throw new EnhancedHttpError(404, 'LINK_NOT_FOUND', 'Link not found')
      if (link.type !== 'webhook') throw new EnhancedHttpError(409, 'LINK_NOT_WEBHOOK', 'Action Executors can only be attached to Webhook Links')
      const attachments = linkActionAttachments(runtime.actionStore.db)

      if (attachmentRoute.kind === 'collection' && request.method === 'GET') {
        const executors = runtime.actionStore.db.listIntegrations()
          .filter((integration) => integration.state === 'active' && (integration.integrationClass === 'action_executor' || integration.authority === 'controlled_actions'))
          .map((integration) => ({
            id: integration.id,
            name: integration.name,
            catalogId: integration.catalogId,
            authority: integration.authority,
            risk: integration.risk,
            state: integration.state,
            health: integration.health,
          }))
        return json(response, 200, { link, attachments: attachments.list(link.id), executors })
      }

      requireAnyRole(actor, ['Papyrus.System.Owner', 'Papyrus.Integration.Manage'])
      if (attachmentRoute.kind === 'collection' && request.method === 'POST') {
        const body = await jsonRequest(request)
        try {
          const attachment = attachments.attach(link, actor.oid, attachmentInput(body))
          return json(response, 201, { attachment })
        } catch (cause) {
          throw new EnhancedHttpError(400, 'INVALID_EXECUTOR_ATTACHMENT', cause instanceof Error ? cause.message : 'Invalid executor attachment')
        }
      }

      if (attachmentRoute.kind === 'resource' && attachmentRoute.attachmentId && request.method === 'PATCH') {
        const body = await jsonRequest(request)
        if (typeof body.enabled !== 'boolean') throw new EnhancedHttpError(400, 'INVALID_INPUT', 'enabled must be a boolean')
        try {
          const attachment = attachments.setEnabled(link.id, attachmentRoute.attachmentId, body.enabled, actor.oid)
          return json(response, 200, { attachment })
        } catch (cause) {
          throw new EnhancedHttpError(404, 'EXECUTOR_ATTACHMENT_NOT_FOUND', cause instanceof Error ? cause.message : 'Executor attachment not found')
        }
      }

      if (attachmentRoute.kind === 'resource' && attachmentRoute.attachmentId && request.method === 'DELETE') {
        try {
          attachments.remove(link.id, attachmentRoute.attachmentId, actor.oid)
          response.writeHead(204)
          response.end()
          return
        } catch (cause) {
          throw new EnhancedHttpError(404, 'EXECUTOR_ATTACHMENT_NOT_FOUND', cause instanceof Error ? cause.message : 'Executor attachment not found')
        }
      }

      return json(response, 405, { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' })
    }

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
  kind: 'acp-list' | 'acp-connect' | 'acp-disconnect' | 'work' | 'facts' | 'events'
  sessionId: string
  harnessId?: 'codex' | 'claude' | 'opencode'
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
  const work = pathname.match(/^\/api\/sessions\/([^/]+)\/(work|facts|events)$/)
  if (work) return { kind: work[2] as 'work' | 'facts' | 'events', sessionId: decodeURIComponent(work[1] as string) }
  return undefined
}

function matchLinkExecutorAttachment(pathname: string): {
  kind: 'collection' | 'resource'
  linkId: string
  attachmentId?: string
} | undefined {
  const collection = pathname.match(/^\/api\/links\/([^/]+)\/executors$/)
  if (collection) return { kind: 'collection', linkId: decodeURIComponent(collection[1] as string) }
  const resource = pathname.match(/^\/api\/links\/([^/]+)\/executors\/([^/]+)$/)
  if (resource) return {
    kind: 'resource',
    linkId: decodeURIComponent(resource[1] as string),
    attachmentId: decodeURIComponent(resource[2] as string),
  }
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

function requireAnyRole(principalValue: PortalPrincipal, roles: EntraAppRole[]): void {
  if (roles.some((role) => principalValue.roles.includes(role))) return
  throw new EnhancedHttpError(403, 'ROLE_REQUIRED', `Requires one of: ${roles.join(', ')}`)
}

function attachmentInput(body: Record<string, unknown>): AttachLinkExecutorInput {
  const executorIntegrationId = text(body.executorIntegrationId, 'executorIntegrationId', 128)
  const action = text(body.action, 'action', 256)
  const target = text(body.target, 'target', 1024)
  const invocationMode = body.invocationMode === undefined ? undefined : text(body.invocationMode, 'invocationMode', 32) as AttachLinkExecutorInput['invocationMode']
  const approvalMode = body.approvalMode === undefined ? undefined : text(body.approvalMode, 'approvalMode', 32) as AttachLinkExecutorInput['approvalMode']
  const maxRetries = body.maxRetries === undefined ? undefined : Number(body.maxRetries)
  const inputMapping = body.inputMapping === undefined ? undefined : stringMap(body.inputMapping, 'inputMapping')
  const conditionRecord = body.condition === undefined ? undefined : record(body.condition, 'condition')
  const condition = conditionRecord ? {
    path: text(conditionRecord.path, 'condition.path', 512),
    equals: scalar(conditionRecord.equals, 'condition.equals'),
  } : undefined
  return {
    executorIntegrationId, action, target,
    ...(invocationMode ? { invocationMode } : {}),
    ...(approvalMode ? { approvalMode } : {}),
    ...(Number.isFinite(maxRetries) ? { maxRetries } : {}),
    ...(inputMapping ? { inputMapping } : {}),
    ...(condition ? { condition } : {}),
  }
}

async function jsonRequest(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > 64 * 1024) throw new EnhancedHttpError(413, 'REQUEST_TOO_LARGE', 'Request body exceeds 64 KiB')
    chunks.push(bytes)
  }
  if (!chunks.length) return {}
  let value: unknown
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new EnhancedHttpError(400, 'INVALID_JSON', 'Request body must be valid JSON') }
  return record(value, 'body')
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EnhancedHttpError(400, 'INVALID_INPUT', `${name} must be an object`)
  return value as Record<string, unknown>
}

function stringMap(value: unknown, name: string): Record<string, string> {
  const source = record(value, name)
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(source)) {
    if (typeof item !== 'string') throw new EnhancedHttpError(400, 'INVALID_INPUT', `${name}.${key} must be a string`)
    result[key] = item
  }
  return result
}

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new EnhancedHttpError(400, 'INVALID_INPUT', `${name} is required and must be at most ${max} characters`)
  return value.trim()
}

function scalar(value: unknown, name: string): string | number | boolean | null {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  throw new EnhancedHttpError(400, 'INVALID_INPUT', `${name} must be a string, number, boolean, or null`)
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
  if (cause instanceof EnhancedHttpError || cause instanceof MastraRuntimeError) {
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
