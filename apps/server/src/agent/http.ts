import { createReadStream, readFileSync, statSync } from 'node:fs'
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { extname, join, normalize } from 'node:path'
import { MODEL_AUTH_SCHEMES, MODEL_GATEWAY_KINDS, OBSERVABILITY_APP_ROLES, type EntraAppRole, type ModelAuthScheme, type ModelGatewayKind, type PortalPrincipal, type SignedLicense } from '@papyrus/contracts'
import { deriveOrigin, type AgentConfig } from './config.js'
import { EntraAuthError, EntraAuthService, hasAppRole } from './entra-auth.js'
import { AgentService, AgentServiceError } from './service.js'
import { MastraRuntime, MastraRuntimeError } from './mastra/runtime.js'
import { fetchUrlPreviewImage, UnsafeFetchTargetError } from './mastra/fetch-preview.js'
import { ModelProfileError } from './model-store.js'
import { handlePublicLink } from './link-http.js'

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

function boundedInteger(value: string | null, minimum: number, maximum: number, fallback: number): number {
  if (value === null || value.trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new HttpError(400, 'INVALID_INTEGER', `Expected an integer between ${minimum} and ${maximum}`)
  return parsed
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

/**
 * Read and parse a JSON request body under a byte ceiling.
 *
 * `remedy` is appended to the refusal so a 413 tells the operator what to do about
 * it. "Request body exceeds 1 MiB" is accurate and useless: the usual cause is a
 * large paste or a growing conversation, and neither is obvious from the number.
 */
async function body(request: IncomingMessage, maximumBytes = 1_048_576, remedy = ''): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maximumBytes) {
      const limit = `${Math.ceil(maximumBytes / 1_048_576)} MiB`
      throw new HttpError(413, 'BODY_TOO_LARGE', `Request body exceeds ${limit}${remedy ? `. ${remedy}` : ''}`)
    }
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

function requireAnyRole(principal: PortalPrincipal, roles: readonly EntraAppRole[]): void {
  if (roles.some((role) => hasAppRole(principal, role))) return
  throw new HttpError(
    403,
    'ENTRA_OBSERVABILITY_ROLE_REQUIRED',
    'System Owner, Audit Viewer, or Security Manager is required to view observability data',
  )
}

async function principal(request: IncomingMessage, auth: EntraAuthService, service: AgentService): Promise<PortalPrincipal> {
  const value = await auth.authenticate(request)
  if (!value) throw new HttpError(401, 'ENTRA_AUTHENTICATION_REQUIRED', 'Microsoft Entra authentication is required')
  service.requirePortalAccess(value)
  return value
}

interface HostedScheduleLink {
  id: string
  name: string
  cron: string
  prompt: string
  threadId: string
  timezone?: string
  status?: string
  nextFireAt?: number | null
}

/**
 * Schedules are presented in the portal as Link-like hosted resources, but their authority
 * remains Mastra's scheduler rather than LinkStore. Keep the browser contract deliberately
 * small and never leak scheduler-internal metadata that the editor does not need.
 */
function hostedScheduleLink(value: unknown): HostedScheduleLink | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const id = typeof record['id'] === 'string' ? record['id'] : undefined
  const name = typeof record['name'] === 'string' ? record['name'] : undefined
  const cron = typeof record['cron'] === 'string' ? record['cron'] : undefined
  const prompt = typeof record['prompt'] === 'string' ? record['prompt'] : undefined
  const threadId = typeof record['threadId'] === 'string' ? record['threadId'] : undefined
  if (!id || !name || !cron || !prompt || !threadId) return undefined
  const timezone = typeof record['timezone'] === 'string' && record['timezone'].trim() ? record['timezone'] : undefined
  const status = typeof record['status'] === 'string' ? record['status'] : undefined
  const nextFireAt = typeof record['nextFireAt'] === 'number' && Number.isFinite(record['nextFireAt']) ? record['nextFireAt'] : null
  return {
    id, name, cron, prompt, threadId,
    ...(timezone ? { timezone } : {}),
    ...(status ? { status } : {}),
    nextFireAt,
  }
}

export function createAgentServer(config: AgentConfig, service: AgentService, auth: EntraAuthService, mastra: MastraRuntime): Server {
  const handler = async (request: IncomingMessage, response: ServerResponse) => {
    const requestId = crypto.randomUUID()
    response.setHeader('x-request-id', requestId)
    const url = new URL(request.url ?? '/', deriveOrigin(request.headers, config.publicOrigin))
    try {
      if (await handlePublicLink(request, response, url, mastra)) return
      if (url.pathname === '/api/health' && request.method === 'GET') {
        return json(response, 200, {
          status: 'ok', product: 'Papyrus Agent Twin', topology: 'customer-hosted', profile: config.profile,
          identityAuthority: 'Microsoft Entra ID', organizationName: config.organizationName,
        })
      }
      if (url.pathname === '/api/config/public' && request.method === 'GET') {
        return json(response, 200, {
          bootstrap: false,
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
        const location = await auth.startLogin(url.searchParams.get('returnTo') ?? '/portal', url.origin)
        securityHeaders(response); response.writeHead(302, { location }); return response.end()
      }
      if (url.pathname === '/api/auth/entra/callback' && request.method === 'GET') {
        if (url.searchParams.has('error')) throw new HttpError(401, 'ENTRA_LOGIN_DENIED', 'Microsoft Entra denied portal authentication')
        const result = await auth.completeLogin(requiredString(url.searchParams.get('code'), 'code'), requiredString(url.searchParams.get('state'), 'state'), url.origin)
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
      if (url.pathname === '/api/auth/logout' && request.method === 'POST') return json(response, 200, { signedOut: true }, { 'set-cookie': auth.clearCookie(url.origin) })

      if (url.pathname === '/api/me' && request.method === 'GET') return json(response, 200, await principal(request, auth, service))
      if (url.pathname === '/api/portal/overview' && request.method === 'GET') return json(response, 200, service.overview(await principal(request, auth, service)))
      if (url.pathname === '/api/agent/status' && request.method === 'GET') {
        await principal(request, auth, service)
        const sessionId = url.searchParams.get('session')?.trim()
        if (!sessionId) return json(response, 200, mastra.status)
        if (sessionId.length > 256) throw new HttpError(400, 'INVALID_SESSION', 'session must be 256 characters or fewer')
        return json(response, 200, { ...mastra.status, jobs: await mastra.jobsForSession(sessionId) })
      }
      if (url.pathname === '/api/observability/traces' && request.method === 'GET') {
        const actor = await principal(request, auth, service)
        requireAnyRole(actor, OBSERVABILITY_APP_ROLES)
        const page = boundedInteger(url.searchParams.get('page'), 0, 100_000, 0)
        const perPage = boundedInteger(url.searchParams.get('perPage'), 1, 100, 50)
        const rawStatus = url.searchParams.get('status')
        const status = rawStatus && ['success', 'error', 'running'].includes(rawStatus) ? rawStatus as 'success' | 'error' | 'running' : undefined
        if (rawStatus && !status) throw new HttpError(400, 'INVALID_TRACE_STATUS', 'status must be success, error, or running')
        const rawTraceId = url.searchParams.get('traceId')
        const traceId = rawTraceId ? requiredString(rawTraceId, 'traceId', 256) : undefined
        return json(response, 200, await mastra.listObservabilityTraces({
          page,
          perPage,
          ...(status ? { status } : {}),
          ...(traceId ? { traceId } : {}),
        }))
      }
      const observabilityTrace = url.pathname.match(/^\/api\/observability\/traces\/([^/]+)$/)
      if (observabilityTrace && request.method === 'GET') {
        const actor = await principal(request, auth, service)
        requireAnyRole(actor, OBSERVABILITY_APP_ROLES)
        const traceId = requiredString(decodeURIComponent(observabilityTrace[1] as string), 'traceId', 256)
        return json(response, 200, await mastra.getObservabilityTrace(traceId))
      }
      if (url.pathname === '/api/observability/logs' && request.method === 'GET') {
        const actor = await principal(request, auth, service)
        requireAnyRole(actor, OBSERVABILITY_APP_ROLES)
        const page = boundedInteger(url.searchParams.get('page'), 0, 100_000, 0)
        const perPage = boundedInteger(url.searchParams.get('perPage'), 1, 100, 50)
        const rawLevel = url.searchParams.get('level')
        const level = rawLevel && ['debug', 'info', 'warn', 'error', 'fatal'].includes(rawLevel) ? rawLevel as 'debug' | 'info' | 'warn' | 'error' | 'fatal' : undefined
        if (rawLevel && !level) throw new HttpError(400, 'INVALID_LOG_LEVEL', 'level must be debug, info, warn, error, or fatal')
        const rawTraceId = url.searchParams.get('traceId')
        const traceId = rawTraceId ? requiredString(rawTraceId, 'traceId', 256) : undefined
        return json(response, 200, await mastra.listObservabilityLogs({
          page,
          perPage,
          ...(level ? { level } : {}),
          ...(traceId ? { traceId } : {}),
        }))
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
      if (url.pathname === '/api/url-preview/image' && request.method === 'GET') {
        await principal(request, auth, service)
        const target = requiredString(url.searchParams.get('url'), 'url', 4096)
        const image = await fetchUrlPreviewImage(target)
        securityHeaders(response)
        const bytes = Buffer.from(image.bytes)
        response.writeHead(200, {
          'content-type': image.contentType,
          'content-length': String(bytes.byteLength),
          'content-disposition': 'inline',
        })
        response.end(bytes)
        return
      }
      if (url.pathname === '/api/links' && request.method === 'GET') {
        await principal(request, auth, service)
        return json(response, 200, { links: mastra.links.list() })
      }

      // Schedules are first-class entries on the Links surface. They remain authenticated
      // portal resources (not public /l/* endpoints) because editing a recurring prompt is an
      // execution-authority change. Listing is available to portal readers; mutation requires
      // Integration.Manage (System Owner satisfies it through hasAppRole()).
      if (url.pathname === '/api/links/schedules' && request.method === 'GET') {
        await principal(request, auth, service)
        const schedules = (await mastra.listSchedules())
          .map(hostedScheduleLink)
          .filter((value): value is HostedScheduleLink => Boolean(value))
        return json(response, 200, { schedules })
      }
      const scheduleLinkResource = url.pathname.match(/^\/api\/links\/schedules\/([^/]+)$/)
      if (scheduleLinkResource && (request.method === 'GET' || request.method === 'PATCH' || request.method === 'PUT')) {
        const actor = await principal(request, auth, service)
        const id = decodeURIComponent(scheduleLinkResource[1] as string)
        const current = (await mastra.listSchedules())
          .map(hostedScheduleLink)
          .find((schedule): schedule is HostedScheduleLink => Boolean(schedule && schedule.id === id))
        if (!current) throw new HttpError(404, 'SCHEDULE_NOT_FOUND', 'Schedule not found in this Papyrus deployment')
        if (request.method === 'GET') return json(response, 200, { schedule: current })

        requireRole(actor, 'Papyrus.Integration.Manage')
        const input = await body(request)
        const name = input.name === undefined ? current.name : requiredString(input.name, 'name', 120)
        const cron = input.cron === undefined ? current.cron : requiredString(input.cron, 'cron', 256)
        const prompt = input.prompt === undefined ? current.prompt : requiredString(input.prompt, 'prompt', 32_768)
        const timezone = input.timezone === undefined
          ? current.timezone
          : typeof input.timezone === 'string' && input.timezone.trim()
            ? input.timezone.trim().slice(0, 128)
            : undefined

        // Mastra's schedule API intentionally exposes create/delete rather than an in-place
        // parameter update. Create the validated replacement first; only after that succeeds do
        // we remove the old schedule. If removal fails, roll the replacement back so editing
        // cannot silently leave two recurring prompts running.
        const created = await mastra.createSchedule({ name, cron, prompt, ...(timezone ? { timezone } : {}), threadId: current.threadId })
        const replacement = hostedScheduleLink(created)
        if (!replacement) throw new HttpError(500, 'SCHEDULE_REPLACEMENT_INVALID', 'Mastra created a schedule that could not be represented in the Links surface')
        try {
          await mastra.deleteSchedule(id, current.threadId)
        } catch (cause) {
          await mastra.deleteSchedule(replacement.id, current.threadId).catch(() => undefined)
          throw cause
        }
        return json(response, 200, { schedule: replacement, replacedId: id })
      }

      const linkInbounds = url.pathname.match(/^\/api\/links\/([^/]+)\/inbounds$/)
      if (linkInbounds && request.method === 'GET') {
        await principal(request, auth, service)
        const id = decodeURIComponent(linkInbounds[1] as string)
        if (!mastra.links.get(id)) throw new HttpError(404, 'LINK_NOT_FOUND', 'Link not found')
        return json(response, 200, { inbounds: mastra.links.listInbounds(id) })
      }
      // One stored inbound, addressed by its own id. The linkId is part of the lookup rather than
      // a check beside it, so holding one Link's inbound id cannot read another Link's traffic.
      const linkInboundRecord = url.pathname.match(/^\/api\/links\/([^/]+)\/inbounds\/([^/]+)$/)
      if (linkInboundRecord && request.method === 'GET') {
        await principal(request, auth, service)
        const linkId = decodeURIComponent(linkInboundRecord[1] as string)
        // Checked here as well as inside the store lookup so an unknown Link answers 404 rather
        // than surfacing the store's own "Link not found" error as a 500.
        if (!mastra.links.get(linkId)) throw new HttpError(404, 'LINK_NOT_FOUND', 'Link not found')
        const inbound = mastra.links.getInbound(linkId, decodeURIComponent(linkInboundRecord[2] as string))
        if (!inbound) throw new HttpError(404, 'INBOUND_NOT_FOUND', 'No such inbound record for this Link')
        const stored = await mastra.workspaceFilesystem.readFile(inbound.blobPath)
        return serveBytes(response, stored, {
          mediaType: inbound.contentType ?? 'application/json',
          name: `inbound-${inbound.id}.json`,
          download: url.searchParams.get('download') === '1',
        })
      }
      // The pinned snapshot itself. A workflow-bound API Link answers GET by running the workflow,
      // so without this the reviewed snapshot could never be read back through the Link.
      const linkContent = url.pathname.match(/^\/api\/links\/([^/]+)\/content$/)
      if (linkContent && request.method === 'GET') {
        await principal(request, auth, service)
        const link = mastra.links.get(decodeURIComponent(linkContent[1] as string))
        if (!link) throw new HttpError(404, 'LINK_NOT_FOUND', 'Link not found')
        const stored = await mastra.workspaceFilesystem.readFile(link.blobPath)
        return serveBytes(response, stored, {
          mediaType: link.mediaType,
          name: `${link.slug}-${link.type}.json`,
          download: url.searchParams.get('download') === '1',
        })
      }
      const linkResource = url.pathname.match(/^\/api\/links\/([^/]+)$/)
      if (linkResource && request.method === 'GET') {
        await principal(request, auth, service)
        const link = mastra.links.get(decodeURIComponent(linkResource[1] as string))
        if (!link) throw new HttpError(404, 'LINK_NOT_FOUND', 'Link not found')
        return json(response, 200, { link })
      }
      if (url.pathname === '/api/workspace/files' && request.method === 'GET') {
        await principal(request, auth, service)
        const query = (url.searchParams.get('q') ?? '').slice(0, 256)
        const offset = boundedInteger(url.searchParams.get('offset'), 0, 4_000, 0)
        const limit = boundedInteger(url.searchParams.get('limit'), 1, 500, 100)
        return json(response, 200, await mastra.workspaceFilesystem.listLibraryPage(query, { offset, limit }))
      }
      if (url.pathname === '/api/workspace/attachments' && request.method === 'POST') {
        await principal(request, auth, service)
        const input = await body(request, 12 * 1024 * 1024)
        const file = await mastra.workspaceFilesystem.saveUpload({
          name: requiredString(input.name, 'name', 255),
          dataBase64: requiredString(input.dataBase64, 'dataBase64', 11 * 1024 * 1024),
          ...(typeof input.mediaType === 'string' && input.mediaType.trim() ? { mediaType: input.mediaType.trim().slice(0, 255) } : {}),
        })
        return json(response, 201, { file })
      }
      if (url.pathname === '/api/workspace/files/content' && request.method === 'GET') {
        await principal(request, auth, service)
        const path = requiredString(url.searchParams.get('path'), 'path', 2048)
        const file = await mastra.workspaceFilesystem.describeLibraryFile(path)
        const value = await mastra.workspaceFilesystem.readFile(file.path)
        const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
        return serveBytes(response, bytes, { mediaType: file.mediaType, name: file.name, download: url.searchParams.get('download') === '1' })
      }
      if (url.pathname === '/api/agent/chat' && request.method === 'POST') {
        await principal(request, auth, service)
        // One message per turn. The daemon takes conversation history from the
        // durable thread, so a client that sends the whole transcript is sending
        // what this handler discards — and a long document session eventually
        // exceeds this ceiling and fails every subsequent turn.
        const input = await body(request, 1_048_576, 'Send one message per turn; history comes from the thread. Attach large content as a file instead, which is uploaded separately and has its own limit.')
        const streamed = await mastra.chat(requiredString(input.threadId, 'threadId', 256), input)
        await pipeWebResponse(response, streamed)
        return
      }
      if (url.pathname === '/api/artifacts' && request.method === 'GET') {
        await principal(request, auth, service)
        return json(response, 200, { artifacts: mastra.artifacts.list() })
      }
      const artifactContent = url.pathname.match(/^\/api\/artifacts\/([^/]+)\/content$/)
      if (artifactContent && request.method === 'GET') {
        await principal(request, auth, service)
        const id = decodeURIComponent(artifactContent[1] as string)
        const artifact = mastra.artifacts.get(id)
        if (!artifact) throw new HttpError(404, 'ARTIFACT_NOT_FOUND', 'Artifact not found')
        const path = mastra.artifacts.contentPath(id)
        const stats = statSync(path)
        securityHeaders(response)
        const activeContent = artifact.mediaType.startsWith('text/html') || artifact.mediaType === 'image/svg+xml'
        if (activeContent) response.setHeader('content-security-policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:")
        const disposition = url.searchParams.get('download') === '1' || activeContent ? 'attachment' : 'inline'
        const fileName = artifact.name.replace(/[\r\n"]/g, '_')
        response.writeHead(200, {
          'content-type': activeContent ? 'application/octet-stream' : artifact.mediaType,
          'content-length': String(stats.size),
          'content-disposition': `${disposition}; filename="${fileName}"`,
        })
        createReadStream(path).pipe(response)
        return
      }
      if (url.pathname === '/api/skills' && request.method === 'GET') {
        await principal(request, auth, service)
        return json(response, 200, { skills: mastra.skills.list() })
      }
      const approveSkill = url.pathname.match(/^\/api\/skills\/([^/]+)\/approve$/)
      if (approveSkill && request.method === 'POST') {
        const actor = await principal(request, auth, service)
        requireRole(actor, 'Papyrus.System.Owner')
        return json(response, 200, { skill: mastra.skills.approveAndEnable(decodeURIComponent(approveSkill[1] as string), actor.oid) })
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
      if (url.pathname === '/api/terrain' && request.method === 'GET') return json(response, 200, service.terrainSnapshot(await principal(request, auth, service)))
      if (url.pathname === '/api/license/activate' && request.method === 'POST') {
        const actor = await principal(request, auth, service)
        requireRole(actor, 'Papyrus.System.Owner')
        return json(response, 200, service.license.activate(await body(request) as unknown as SignedLicense))
      }

      // ─── Integrations ─────────────────────────────────────────────
      //
      // The daemon owns the integration domain; this is the portal adapter over
      // AgentService, which enforces authority itself. Keeping the role checks in
      // the service means the portal, the agent, and any future machine client
      // cannot disagree about who may activate an action-capable connector.
      //
      // `/catalog` is matched before the `:id` pattern so "catalog" is never read
      // as an integration identifier.
      if (url.pathname === '/api/integrations/catalog' && request.method === 'GET') {
        return json(response, 200, { catalog: service.catalog(await principal(request, auth, service)) })
      }
      if (url.pathname === '/api/integrations' && request.method === 'GET') {
        return json(response, 200, { integrations: service.integrations(await principal(request, auth, service)) })
      }
      if (url.pathname === '/api/integrations' && request.method === 'POST') {
        const actor = await principal(request, auth, service)
        const input = await body(request)
        return json(response, 201, service.createIntegration(actor, input.catalogId, input))
      }

      const integrationResource = url.pathname.match(/^\/api\/integrations\/([^/]+)$/)
      if (integrationResource) {
        const id = decodeURIComponent(integrationResource[1] as string)
        const actor = await principal(request, auth, service)
        if (request.method === 'GET') return json(response, 200, service.getIntegration(actor, id))
        if (request.method === 'DELETE') {
          service.deleteIntegration(actor, id)
          securityHeaders(response); response.writeHead(204); return response.end()
        }
      }

      const integrationAction = url.pathname.match(/^\/api\/integrations\/([^/]+)\/([a-z][a-z-]*)$/)
      if (integrationAction) {
        const id = decodeURIComponent(integrationAction[1] as string)
        const action = integrationAction[2] as string

        // Observation ingest accepts either an operator session holding
        // Papyrus.Integration.Manage, or a one-hour token scoped to this exact
        // integration, so a customer producer never carries a user token. Sending
        // an Authorization header selects the token path, and an invalid token is
        // refused rather than falling back to the session.
        if (action === 'observations' && request.method === 'POST') {
          const input = await body(request)
          if (request.headers.authorization) {
            if (!auth.verifyIngestionRequest(request, id)) {
              throw new HttpError(401, 'INVALID_INGESTION_TOKEN', 'Ingestion token is missing or not valid for this source')
            }
            return json(response, 202, service.ingestObservationWithScopedCredential(id, input))
          }
          return json(response, 202, service.ingestObservation(await principal(request, auth, service), id, input))
        }

        const actor = await principal(request, auth, service)
        if (action === 'test' && request.method === 'POST') return json(response, 200, await service.testIntegration(actor, id))
        if (action === 'submit' && request.method === 'POST') return json(response, 200, service.submitIntegration(actor, id))
        if (action === 'activate' && request.method === 'POST') return json(response, 200, service.activateIntegration(actor, id))
        if (action === 'disable' && request.method === 'POST') {
          const input = await body(request)
          return json(response, 200, service.disableIntegration(actor, id, input.reason))
        }
        if (action === 'sync' && request.method === 'POST') return json(response, 202, service.requestSync(actor, id))
        if (action === 'sync-jobs' && request.method === 'GET') return json(response, 200, { jobs: service.syncJobs(actor, id) })
        if (action === 'events' && request.method === 'GET') return json(response, 200, { events: service.events(actor, id) })
        if (action === 'ingestion-token' && request.method === 'POST') {
          service.authorizeIngestionToken(actor, id)
          const issued = auth.issueIngestionToken(id, actor.oid)
          service.recordIngestionTokenIssued(actor, id, issued.expiresAt)
          return json(response, 201, issued)
        }
      }

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
        : cause instanceof UnsafeFetchTargetError
          ? new HttpError(400, 'UNSAFE_FETCH_TARGET', cause.message)
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

/**
 * Types a browser may render in place. Everything else is sent as an attachment, so a stored
 * file cannot be interpreted as active content by the browser that opens it. JSON is included
 * because a browser displays it as text; HTML and SVG deliberately are not.
 */
const INLINE_MEDIA_TYPES = new Set([
  'application/pdf',
  'application/json',
  'text/plain',
  'text/markdown',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/webm',
])

/**
 * Serve stored bytes as either a view or a download. One helper so the workspace file route and
 * the Link routes cannot disagree about what is safe to render inline.
 */
function serveBytes(response: ServerResponse, bytes: Buffer | string, options: { mediaType?: string | undefined; name: string; download?: boolean | undefined }): void {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  const mediaType = options.mediaType ?? 'application/octet-stream'
  const inlineSafe = INLINE_MEDIA_TYPES.has(mediaType)
  const download = options.download === true || !inlineSafe
  securityHeaders(response)
  response.writeHead(200, {
    'content-type': inlineSafe ? mediaType : 'application/octet-stream',
    'content-length': String(buffer.byteLength),
    'content-disposition': `${download ? 'attachment' : 'inline'}; filename="${options.name.replace(/[\r\n"]/g, '_')}"`,
  })
  response.end(buffer)
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
