import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'
import type { PortalPrincipal } from '@papyrus/contracts'
import type { EntraAuthService } from './entra-auth.js'
import type { AgentService } from './service.js'
import { AcpPlaneError, isAcpHarnessId } from './acp-plane.js'
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

function isSessionScopedOriginalRoute(pathname: string): boolean {
  return pathname === '/api/sessions' || pathname.startsWith('/api/sessions/') || pathname === '/api/agent/chat' || pathname === '/api/agent/status'
}

async function principal(request: IncomingMessage, auth: EntraAuthService, service: AgentService): Promise<PortalPrincipal> {
  const value = await auth.authenticate(request)
  if (!value) throw new EnhancedHttpError(401, 'ENTRA_AUTHENTICATION_REQUIRED', 'Microsoft Entra authentication is required')
  service.requirePortalAccess(value)
  return value
}

function invoke(listener: RequestListener, request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const result = listener(request, response)
    return result && typeof (result as Promise<void>).then === 'function' ? result as Promise<void> : Promise.resolve()
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
