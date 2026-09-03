import { readFileSync } from 'node:fs'
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { extname, join, normalize } from 'node:path'
import { MODEL_AUTH_SCHEMES, MODEL_GATEWAY_KINDS, type EntraAppRole, type ModelAuthScheme, type ModelGatewayKind, type PortalPrincipal, type SignedLicense } from '@papyrus/contracts'
import type { AgentConfig } from './config.js'
import { EntraAuthError, EntraAuthService, hasAppRole } from './entra-auth.js'
import { AgentService, AgentServiceError } from './service.js'
import { MastraRuntime, MastraRuntimeError } from './mastra/runtime.js'
import { ModelProfileError } from './model-store.js'

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

function securityHeaders(response: ServerResponse): void {
  response.setHeader('cache-control', 'no-store')
  response.setHeader('content-security-policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'self' https://*.teams.microsoft.com https://*.cloud.microsoft")
  response.setHeader('cross-origin-opener-policy', 'same-origin-allow-popups')
  response.setHeader('referrer-policy', 'no-referrer')
  response.setHeader('x-content-type-options', 'nosniff')
  response.setHeader('x-frame-options', 'SAMEORIGIN')
}

function json(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  securityHeaders(response)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
  response.end(JSON.stringify(value))
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 1_048_576) throw new HttpError(413, 'BODY_TOO_LARGE', 'Request body exceeds one MiB')
    chunks.push(buffer)
  }
  if (!chunks.length) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object required')
    return parsed as Record<string, unknown>
  } catch { throw new HttpError(400, 'INVALID_JSON', 'Request body must be a JSON object') }
}

function requiredString(value: unknown, name: string, maximum = 4096): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new HttpError(400, 'INVALID_INPUT', `${name} is required`)
  return value.trim()
}

function requireRole(principal: PortalPrincipal, role: EntraAppRole): void {
  if (!hasAppRole(principal, role)) throw new HttpError(403, 'ENTRA_ROLE_REQUIRED', `${role} is required`)
}

async function principal(request: IncomingMessage, auth: EntraAuthService, service: AgentService): Promise<PortalPrincipal> {
  const value = await auth.authenticate(request)
  if (!value) throw new HttpError(401, 'ENTRA_AUTHENTICATION_REQUIRED', 'Microsoft Entra authentication is required')
  service.requirePortalAccess(value)
  return value
}

export function createAgentServer(config: AgentConfig, service: AgentService, auth: EntraAuthService, mastra: MastraRuntime): Server {
  const handler = async (request: IncomingMessage, response: ServerResponse) => {
    const requestId = crypto.randomUUID()
    response.setHeader('x-request-id', requestId)
    const url = new URL(request.url ?? '/', config.publicOrigin)
    try {
      if (url.pathname === '/api/health' && request.method === 'GET') {
        return json(response, 200, {
          status: 'ok', product: 'Papyrus Agent Twin', topology: 'customer-hosted', profile: config.profile,
          identityAuthority: 'Microsoft Entra ID', organizationName: config.organizationName,
        })
      }
      if (url.pathname === '/api/config/public' && request.method === 'GET') {
        return json(response, 200, {
          organizationName: config.organizationName,
          profile: config.profile,
          cloud: config.cloud,
          entraConfigured: Boolean(config.entra),
          developmentIdentity: Boolean(config.developmentPrincipal),
          loginUrl: '/api/auth/entra/login?returnTo=/portal',
        })
      }
      if (url.pathname === '/api/license/request' && request.method === 'GET') return json(response, 200, service.license.activationRequest())
      if (url.pathname === '/api/license/status' && request.method === 'GET') return json(response, 200, service.license.status())
      if (url.pathname === '/api/auth/entra/login' && request.method === 'GET') {
        const location = await auth.startLogin(url.searchParams.get('returnTo') ?? '/portal')
        securityHeaders(response); response.writeHead(302, { location }); return response.end()
      }
      if (url.pathname === '/api/auth/entra/callback' && request.method === 'GET') {
        if (url.searchParams.has('error')) throw new HttpError(401, 'ENTRA_LOGIN_DENIED', 'Microsoft Entra denied portal authentication')
        const result = await auth.completeLogin(requiredString(url.searchParams.get('code'), 'code'), requiredString(url.searchParams.get('state'), 'state'))
        securityHeaders(response)
        response.writeHead(302, { location: result.returnTo, 'set-cookie': result.cookie })
        return response.end()
      }
      if (url.pathname === '/api/auth/teams' && request.method === 'POST') {
        const input = await body(request)
        const teamsPrincipal = await auth.verifyTeamsToken(requiredString(input.token, 'token', 16_384))
        service.requirePortalAccess(teamsPrincipal)
        return json(response, 200, teamsPrincipal, { 'set-cookie': auth.portalCookie(teamsPrincipal) })
      }
      if (url.pathname === '/api/auth/logout' && request.method === 'POST') return json(response, 200, { signedOut: true }, { 'set-cookie': auth.clearCookie() })

      if (url.pathname === '/api/me' && request.method === 'GET') return json(response, 200, await principal(request, auth, service))
      if (url.pathname === '/api/portal/overview' && request.method === 'GET') return json(response, 200, service.overview(await principal(request, auth, service)))
      if (url.pathname === '/api/agent/status' && request.method === 'GET') {
        await principal(request, auth, service)
        return json(response, 200, mastra.status)
      }
      if (url.pathname === '/api/sessions' && request.method === 'GET') {
        await principal(request, auth, service)
        return json(response, 200, { sessions: await mastra.listSessions() })
      }
      if (url.pathname === '/api/sessions' && request.method === 'POST') {
        await principal(request, auth, service)
        const input = await body(request)
        return json(response, 201, await mastra.createSession(typeof input.title === 'string' ? input.title : 'New session'))
      }
      const sessionMessages = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/)
      if (sessionMessages && request.method === 'GET') {
        await principal(request, auth, service)
        return json(response, 200, { messages: await mastra.sessionMessages(decodeURIComponent(sessionMessages[1] as string)) })
      }
      const sessionAttention = url.pathname.match(/^\/api\/sessions\/([^/]+)\/attention$/)
      if (sessionAttention && request.method === 'POST') {
        await principal(request, auth, service)
        const input = await body(request)
        await mastra.setSessionAttention(decodeURIComponent(sessionAttention[1] as string), input.attention !== false)
        return json(response, 200, { updated: true })
      }
      const sessionProposals = url.pathname.match(/^\/api\/sessions\/([^/]+)\/proposals$/)
      if (sessionProposals && request.method === 'POST') {
        const actor = await principal(request, auth, service)
        const threadId = decodeURIComponent(sessionProposals[1] as string)
        await mastra.setSessionAttention(threadId, true)
        const investigation = mastra.investigationForSession(threadId)
        const input = await body(request)
        return json(response, 201, service.createProposal(
          actor, investigation.id, requiredString(input.executorIntegrationId, 'executorIntegrationId', 128),
          requiredString(input.action, 'action', 256), requiredString(input.target, 'target', 1024),
          Array.isArray(input.rationaleClaimIds) ? input.rationaleClaimIds.filter((value): value is string => typeof value === 'string') : [],
          input.parameters && typeof input.parameters === 'object' && !Array.isArray(input.parameters) ? input.parameters as Record<string, unknown> : undefined,
        ))
      }
      const sessionResource = url.pathname.match(/^\/api\/sessions\/([^/]+)$/)
      if (sessionResource && request.method === 'DELETE') {
        await principal(request, auth, service)
        await mastra.deleteSession(decodeURIComponent(sessionResource[1] as string))
        securityHeaders(response); response.writeHead(204); return response.end()
      }
      if (url.pathname === '/api/agent/chat' && request.method === 'POST') {
        await principal(request, auth, service)
        const input = await body(request)
        const streamed = await mastra.chat(requiredString(input.threadId, 'threadId', 256), input)
        await pipeWebResponse(response, streamed)
        return
      }
      if (url.pathname === '/api/plugins' && request.method === 'GET') {
        const actor = await principal(request, auth, service)
        return json(response, 200, { catalog: service.catalog(actor), configured: service.integrations(actor) })
      }
      if (url.pathname === '/api/plugins/connect' && request.method === 'POST') {
        const actor = await principal(request, auth, service)
        const input = await body(request)
        const rawSettings = input.settings && typeof input.settings === 'object' && !Array.isArray(input.settings)
          ? input.settings as Record<string, unknown> : {}
        let plugin = service.createIntegration(actor, input.catalogId, {
          name: input.name, scope: input.scope, endpoint: input.endpoint, credentialRef: input.credentialRef,
          settings: rawSettings,
        })
        if (plugin.state === 'draft') {
          try {
            plugin = await service.testIntegration(actor, plugin.id)
            plugin = service.submitIntegration(actor, plugin.id)
          } catch (cause) {
            service.deleteIntegration(actor, plugin.id)
            throw cause
          }
          try {
            plugin = service.activateIntegration(actor, plugin.id)
          } catch (cause) {
            service.deleteIntegration(actor, plugin.id)
            throw cause
          }
        }
        return json(response, 201, { plugin })
      }
      if (url.pathname === '/api/model-profiles' && request.method === 'GET') {
        await principal(request, auth, service)
        return json(response, 200, { profiles: mastra.listModelProfiles() })
      }
      if (url.pathname === '/api/model-profiles' && request.method === 'POST') {
        const actor = await principal(request, auth, service)
        requireRole(actor, 'Papyrus.Integration.Manage')
        const input = await body(request)
        const gatewayKind = requiredString(input.gatewayKind, 'gatewayKind', 64) as ModelGatewayKind
        const authScheme = requiredString(input.authScheme, 'authScheme', 64) as ModelAuthScheme
        if (!MODEL_GATEWAY_KINDS.includes(gatewayKind) || !MODEL_AUTH_SCHEMES.includes(authScheme)) throw new HttpError(400, 'INVALID_MODEL_PROFILE', 'Unsupported gateway or authentication type')
        const profile = mastra.createModelProfile({
          name: requiredString(input.name, 'name', 120), gatewayKind,
          provider: requiredString(input.provider, 'provider', 120), model: requiredString(input.model, 'model', 256),
          baseUrl: requiredString(input.baseUrl, 'baseUrl', 2048), authScheme,
          ...(typeof input.credentialRef === 'string' && input.credentialRef.trim() ? { credentialRef: input.credentialRef } : {}),
          ...(typeof input.scope === 'string' && input.scope.trim() ? { scope: input.scope.trim() } : {}),
          ...(Array.isArray(input.capabilities) ? { capabilities: input.capabilities.filter((value): value is string => typeof value === 'string').slice(0, 32) } : {}),
        }, actor.oid)
        return json(response, 201, { profile })
      }
      const modelResource = url.pathname.match(/^\/api\/model-profiles\/([^/]+)$/)
      if (modelResource && request.method === 'POST') {
        const actor = await principal(request, auth, service)
        requireRole(actor, 'Papyrus.Integration.Manage')
        const id = decodeURIComponent(modelResource[1] as string)
        if (url.searchParams.get('action') === 'test') return json(response, 200, { profile: await mastra.testModelProfile(id, actor.oid) })
        if (url.searchParams.get('action') === 'default') return json(response, 200, { profile: await mastra.setDefaultModelProfile(id) })
        if (url.searchParams.get('action') === 'disable') return json(response, 200, { profile: await mastra.disableModelProfile(id) })
        throw new HttpError(400, 'INVALID_MODEL_ACTION', 'Model profile action must be test, default, or disable')
      }
      if (modelResource && request.method === 'DELETE') {
        const actor = await principal(request, auth, service)
        requireRole(actor, 'Papyrus.Integration.Manage')
        await mastra.deleteModelProfile(decodeURIComponent(modelResource[1] as string), actor.oid)
        securityHeaders(response); response.writeHead(204); return response.end()
      }
      if (url.pathname === '/api/schedules' && request.method === 'GET') {
        await principal(request, auth, service)
        return json(response, 200, { schedules: await mastra.listSchedules() })
      }
      if (url.pathname === '/api/schedules' && request.method === 'POST') {
        const actor = await principal(request, auth, service)
        requireRole(actor, 'Papyrus.Integration.Manage')
        const input = await body(request)
        return json(response, 201, await mastra.createSchedule({
          name: requiredString(input.name, 'name', 120), cron: requiredString(input.cron, 'cron', 120),
          prompt: requiredString(input.prompt, 'prompt', 10_000),
          ...(typeof input.timezone === 'string' && input.timezone ? { timezone: input.timezone } : {}),
          ...(typeof input.threadId === 'string' && input.threadId ? { threadId: input.threadId } : {}),
        }))
      }
      const scheduleResource = url.pathname.match(/^\/api\/schedules\/([^/]+)$/)
      if (scheduleResource && request.method === 'DELETE') {
        const actor = await principal(request, auth, service)
        requireRole(actor, 'Papyrus.Integration.Manage')
        await mastra.deleteSchedule(decodeURIComponent(scheduleResource[1] as string))
        securityHeaders(response); response.writeHead(204); return response.end()
      }
      if (url.pathname === '/api/workflows' && request.method === 'GET') {
        await principal(request, auth, service)
        return json(response, 200, { workflows: mastra.listWorkflows() })
      }
      const workflowRun = url.pathname.match(/^\/api\/workflows\/([^/]+)\/runs$/)
      if (workflowRun && request.method === 'POST') {
        const actor = await principal(request, auth, service)
        requireRole(actor, 'Papyrus.Integration.Manage')
        return json(response, 202, await mastra.runWorkflow(decodeURIComponent(workflowRun[1] as string), await body(request)))
      }
      if (url.pathname === '/api/integrations/catalog' && request.method === 'GET') return json(response, 200, { integrations: service.catalog(await principal(request, auth, service)) })
      if (url.pathname === '/api/integrations' && request.method === 'GET') return json(response, 200, { integrations: service.integrations(await principal(request, auth, service)) })
      if (url.pathname === '/api/terrain' && request.method === 'GET') return json(response, 200, service.terrainSnapshot(await principal(request, auth, service)))
      if (url.pathname === '/api/integrations' && request.method === 'POST') {
        const input = await body(request)
        return json(response, 201, service.createIntegration(await principal(request, auth, service), input.catalogId, input))
      }
      const integrationResource = url.pathname.match(/^\/api\/integrations\/([^/]+)$/)
      if (integrationResource && request.method === 'DELETE') {
        service.deleteIntegration(await principal(request, auth, service), decodeURIComponent(integrationResource[1] as string))
        securityHeaders(response); response.writeHead(204); return response.end()
      }
      if (url.pathname === '/api/license/activate' && request.method === 'POST') {
        const actor = await principal(request, auth, service)
        requireRole(actor, 'Papyrus.System.Owner')
        return json(response, 200, service.license.activate(await body(request) as unknown as SignedLicense))
      }

      const action = url.pathname.match(/^\/api\/integrations\/([^/]+)\/(test|submit|activate|disable)$/)
      if (action && request.method === 'POST') {
        const actor = await principal(request, auth, service)
        const id = decodeURIComponent(action[1] as string)
        if (action[2] === 'test') return json(response, 200, await service.testIntegration(actor, id))
        if (action[2] === 'submit') return json(response, 200, service.submitIntegration(actor, id))
        if (action[2] === 'activate') return json(response, 200, service.activateIntegration(actor, id))
        const input = await body(request)
        return json(response, 200, service.disableIntegration(actor, id, input.reason))
      }
      const events = url.pathname.match(/^\/api\/integrations\/([^/]+)\/events$/)
      if (events && request.method === 'GET') return json(response, 200, { events: service.events(await principal(request, auth, service), decodeURIComponent(events[1] as string)) })
      const ingestionToken = url.pathname.match(/^\/api\/integrations\/([^/]+)\/ingestion-token$/)
      if (ingestionToken && request.method === 'POST') {
        const actor = await principal(request, auth, service)
        const id = decodeURIComponent(ingestionToken[1] as string)
        service.authorizeIngestionToken(actor, id)
        const issued = auth.issueIngestionToken(id, actor.oid)
        service.recordIngestionTokenIssued(actor, id, issued.expiresAt)
        return json(response, 201, issued)
      }
      const observations = url.pathname.match(/^\/api\/integrations\/([^/]+)\/observations$/)
      if (observations && request.method === 'POST') {
        const id = decodeURIComponent(observations[1] as string)
        const input = await body(request)
        const result = auth.verifyIngestionRequest(request, id)
          ? service.ingestObservationWithScopedCredential(id, input)
          : service.ingestObservation(await principal(request, auth, service), id, input)
        return json(response, result.created ? 201 : 200, result)
      }
      const signalWebhook = url.pathname.match(/^\/api\/signals\/([^/]+)\/webhook$/)
      if (signalWebhook && request.method === 'POST') {
        const id = decodeURIComponent(signalWebhook[1] as string)
        if (!auth.verifyIngestionRequest(request, id)) throw new HttpError(401, 'SIGNAL_AUTHENTICATION_REQUIRED', 'A source-scoped bearer token is required')
        const headers = Object.fromEntries(Object.entries(request.headers).flatMap(([name, value]) => typeof value === 'string' ? [[name, value]] : []))
        return json(response, 202, await mastra.acceptWebhook(id, await body(request), headers))
      }
      const sync = url.pathname.match(/^\/api\/integrations\/([^/]+)\/sync$/)
      if (sync && request.method === 'POST') return json(response, 202, service.requestSync(
        await principal(request, auth, service), decodeURIComponent(sync[1] as string),
      ))
      const jobs = url.pathname.match(/^\/api\/integrations\/([^/]+)\/sync-jobs$/)
      if (jobs && request.method === 'GET') return json(response, 200, { jobs: service.syncJobs(
        await principal(request, auth, service), decodeURIComponent(jobs[1] as string),
      ) })

      // ─── Investigations ────────────────────────────────────────────
      if (url.pathname === '/api/investigations' && request.method === 'GET') {
        return json(response, 200, { investigations: service.listInvestigations(await principal(request, auth, service)) })
      }
      if (url.pathname === '/api/investigations' && request.method === 'POST') {
        const input = await body(request)
        return json(response, 201, service.createInvestigation(
          await principal(request, auth, service),
          typeof input.title === 'string' ? input.title : '',
          (typeof input.trigger === 'string' ? input.trigger : 'manual') as 'email' | 'teams' | 'manual' | 'signal' | 'schedule',
          typeof input.triggerIntegrationId === 'string' ? input.triggerIntegrationId : undefined,
          typeof input.triggerMessageId === 'string' ? input.triggerMessageId : undefined,
          typeof input.mastraThreadId === 'string' ? input.mastraThreadId : undefined,
        ))
      }
      const investigationMatch = url.pathname.match(/^\/api\/investigations\/([^/]+)$/)
      if (investigationMatch && request.method === 'GET') {
        return json(response, 200, service.getInvestigation(await principal(request, auth, service), decodeURIComponent(investigationMatch[1] as string)))
      }
      const proposalsMatch = url.pathname.match(/^\/api\/investigations\/([^/]+)\/proposals$/)
      if (proposalsMatch && request.method === 'GET') {
        return json(response, 200, { proposals: service.listProposals(await principal(request, auth, service), decodeURIComponent(proposalsMatch[1] as string)) })
      }

      // ─── Action Proposals ─────────────────────────────────────────
      if (url.pathname === '/api/proposals' && request.method === 'GET') {
        return json(response, 200, { proposals: service.listProposals(await principal(request, auth, service)) })
      }
      if (url.pathname === '/api/proposals' && request.method === 'POST') {
        const input = await body(request)
        return json(response, 201, service.createProposal(
          await principal(request, auth, service),
          typeof input.investigationId === 'string' ? input.investigationId : '',
          typeof input.executorIntegrationId === 'string' ? input.executorIntegrationId : '',
          typeof input.action === 'string' ? input.action : '',
          typeof input.target === 'string' ? input.target : '',
          Array.isArray(input.rationaleClaimIds) ? input.rationaleClaimIds as string[] : [],
          input.parameters && typeof input.parameters === 'object' && !Array.isArray(input.parameters) ? input.parameters as Record<string, unknown> : undefined,
          typeof input.expiresAt === 'string' ? input.expiresAt : undefined,
        ))
      }
      const proposalAction = url.pathname.match(/^\/api\/proposals\/([^/]+)\/(approve|deny)$/)
      if (proposalAction && request.method === 'POST') {
        const actor = await principal(request, auth, service)
        const id = decodeURIComponent(proposalAction[1] as string)
        if (proposalAction[2] === 'approve') return json(response, 200, service.approveProposal(actor, id))
        const input = await body(request)
        return json(response, 200, service.denyProposal(actor, id, typeof input.reason === 'string' ? input.reason : undefined))
      }

      // ─── Action Receipts ──────────────────────────────────────────
      if (url.pathname === '/api/receipts' && request.method === 'GET') {
        return json(response, 200, { receipts: service.listReceipts(await principal(request, auth, service)) })
      }

      if (url.pathname.startsWith('/api/')) throw new HttpError(404, 'NOT_FOUND', 'API route not found')
      return servePortal(response, url.pathname)
    } catch (cause) {
      const failure = cause instanceof HttpError || cause instanceof AgentServiceError || cause instanceof MastraRuntimeError
        ? cause
        : cause instanceof ModelProfileError
          ? new HttpError(400, cause.code, cause.message)
        : cause instanceof EntraAuthError
          ? new HttpError(401, cause.code, cause.message)
          : new HttpError(500, 'INTERNAL_ERROR', cause instanceof Error ? cause.message : 'Unexpected server failure')
      return json(response, failure.status, { error: failure.message, code: failure.code, requestId })
    }
  }

  if (!config.tls) return createHttpServer(handler)
  return createHttpsServer({
    cert: readFileSync(config.tls.certPath), key: readFileSync(config.tls.keyPath),
    ...(config.tls.caPath ? { ca: readFileSync(config.tls.caPath) } : {}),
    minVersion: 'TLSv1.2',
  }, handler)
}

async function pipeWebResponse(response: ServerResponse, source: Response): Promise<void> {
  securityHeaders(response)
  const headers: Record<string, string> = {}
  source.headers.forEach((value, key) => { headers[key] = value })
  response.writeHead(source.status, headers)
  if (!source.body) { response.end(); return }
  const reader = source.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!response.write(Buffer.from(value))) await new Promise<void>((resolve) => response.once('drain', resolve))
    }
    response.end()
  } finally {
    reader.releaseLock()
  }
}

function servePortal(response: ServerResponse, pathname: string): void {
  const webRoot = join(import.meta.dirname, '../../../web/dist')
  const requested = pathname === '/' || pathname.startsWith('/portal') ? 'index.html' : normalize(pathname).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]/, '')
  const file = join(webRoot, requested)
  try {
    const content = readFileSync(file)
    const media = ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' } as Record<string, string>)[extname(file)] ?? 'application/octet-stream'
    securityHeaders(response)
    response.writeHead(200, { 'content-type': media, 'cache-control': requested === 'index.html' ? 'no-store' : 'public, max-age=31536000, immutable' })
    response.end(content)
  } catch {
    json(response, 404, { error: 'Portal asset not found', code: 'NOT_FOUND' })
  }
}
