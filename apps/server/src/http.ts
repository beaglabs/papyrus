import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { readFileSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { ROLES, type ApprovedSourceKind, type Role, type SignedLicense } from '@papyrus/contracts'
import { AuthService } from './auth.js'
import type { ServerConfig } from './config.js'
import { ApprovalLifecycleError, AuthorizationDenied, PapyrusService, SessionLifecycleError } from './service.js'
import { mcpClientMetadata } from './mcp-oauth.js'

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

function unauthorized(response: ServerResponse, auth: AuthService): void {
  response.setHeader('www-authenticate', 'Bearer realm="Papyrus"')
  json(response, 401, auth.challenge())
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'",
  })
  response.end(body)
}

function oauthComplete(response: ServerResponse, result: { ok: boolean; serverId?: string; message: string }): void {
  const payload = result.ok
    ? { type: 'papyrus:mcp-connected', serverId: result.serverId, message: result.message }
    : { type: 'papyrus:mcp-oauth-error', serverId: result.serverId, message: result.message }
  const title = result.ok ? 'MCP connected' : 'MCP authorization failed'
  const serializedPayload = JSON.stringify(payload).replace(/</g, '\\u003c')
  const body = `<!doctype html><meta charset="utf-8"><title>${title}</title><p>${result.ok ? 'MCP authorization complete.' : 'MCP authorization did not complete.'} You may close this window.</p><script>window.opener?.postMessage(${serializedPayload}, window.location.origin);setTimeout(()=>window.close(),100)</script>`
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'" })
  response.end(body)
}

function artifactDownload(response: ServerResponse, artifact: ReturnType<PapyrusService['sessionArtifacts']>[number], inline = false): void {
  const content = artifact.encoding === 'base64' ? Buffer.from(artifact.content, 'base64') : Buffer.from(artifact.content, 'utf8')
  const filename = artifact.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180) || 'artifact'
  response.writeHead(200, {
    'content-type': artifact.mediaType,
    'content-length': content.length,
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${filename}"`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(content)
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    size += buffer.length
    if (size > 1_000_000) throw new HttpError(413, 'BODY_TOO_LARGE', 'Request body exceeds 1 MB')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> }
  catch { throw new HttpError(400, 'INVALID_JSON', 'Request body must be JSON') }
}

async function binaryBody(request: IncomingMessage, maximum = 10 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    size += buffer.length
    if (size > maximum) throw new HttpError(413, 'ATTACHMENT_TOO_LARGE', 'Attachment exceeds 10 MB')
    chunks.push(buffer)
  }
  if (size === 0) throw new HttpError(400, 'EMPTY_ATTACHMENT', 'Attachment is empty')
  return Buffer.concat(chunks)
}

function attachmentDownload(response: ServerResponse, attachment: ReturnType<PapyrusService['attachmentContent']>): void {
  const filename = attachment.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180) || 'attachment'
  response.writeHead(200, {
    'content-type': attachment.mediaType, 'content-length': attachment.content.length,
    'content-disposition': `attachment; filename="${filename}"`, 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'",
  })
  response.end(attachment.content)
}

function text(value: unknown, name: string, maximum = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new HttpError(400, 'INVALID_INPUT', `${name} is required and must not exceed ${maximum} characters`)
  return value.trim()
}

function identifier(value: unknown, name: string): string {
  const result = text(value, name, 128)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)) {
    throw new HttpError(400, 'INVALID_INPUT', `${name} must identify an existing resource`)
  }
  return result
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new HttpError(400, 'INVALID_INPUT', `${name} must be a boolean`)
  return value
}

function naturalNumber(value: string | null, fallback: number, maximum: number, minimum = 0): number {
  if (value === null) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new HttpError(400, 'INVALID_INPUT', `Value must be an integer between ${minimum} and ${maximum}`)
  }
  return parsed
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset)).toString('base64url')
}

function decodeCursor(value: string | null): number {
  if (!value) return 0
  const parsed = Number(Buffer.from(value, 'base64url').toString('utf8'))
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new HttpError(400, 'INVALID_CURSOR', 'Cursor is invalid')
  return parsed
}

function streamSessionEvents(
  request: IncomingMessage,
  response: ServerResponse,
  service: PapyrusService,
  principal: ReturnType<AuthService['authenticate']> & {},
  sessionId: string,
  initialAfter: number,
): void {
  // Authorize before committing streaming headers.
  service.getSession(principal, sessionId)
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'x-content-type-options': 'nosniff',
  })

  let after = initialAfter
  const flush = () => {
    for (;;) {
      const events = service.sessionEvents(principal, sessionId, after, 200)
      for (const event of events) {
        response.write(`id: ${event.sequence}\nevent: session_event\ndata: ${JSON.stringify(event)}\n\n`)
        after = event.sequence
      }
      if (events.length < 200) break
    }
  }

  flush()
  response.write(': connected\n\n')
  const poll = setInterval(flush, 250)
  const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000)
  request.once('close', () => {
    clearInterval(poll)
    clearInterval(heartbeat)
    if (!response.writableEnded) response.end()
  })
}

async function streamBrowser(
  request: IncomingMessage,
  response: ServerResponse,
  service: PapyrusService,
  principal: ReturnType<AuthService['authenticate']> & {},
  sessionId: string,
): Promise<void> {
  // browserStream authorizes before headers are committed.
  const stream = await service.browserStream(principal, sessionId)
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store',
    connection: 'keep-alive', 'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff',
  })
  const send = (event: string, data: unknown) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  const onFrame = (frame: unknown) => send('frame', frame)
  const onUrl = (value: unknown) => send('url', value)
  const onError = (error: unknown) => send('browser_error', { error: error instanceof Error ? error.message : String(error) })
  stream.on('frame', onFrame)
  stream.on('url', onUrl)
  stream.on('error', onError)
  response.write(': connected\n\n')
  const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000)
  request.once('close', () => {
    clearInterval(heartbeat)
    void stream.stop()
    if (!response.writableEnded) response.end()
  })
}

export function createPapyrusServer(config: ServerConfig, service: PapyrusService, auth: AuthService): Server {
  const handler = async (request: IncomingMessage, response: ServerResponse) => {
    const requestId = crypto.randomUUID()
    response.setHeader('x-request-id', requestId)
    const url = new URL(request.url ?? '/', config.publicOrigin)
    try {
      if (url.pathname === '/.well-known/mcp-client.json' && request.method === 'GET') {
        return json(response, 200, mcpClientMetadata(config.publicOrigin))
      }
      if (url.pathname === '/api/health' && request.method === 'GET') {
        const logoUrl = config.branding.organizationDomain && config.branding.logoDevPublishableKey
          ? `https://img.logo.dev/${config.branding.organizationDomain}?token=${encodeURIComponent(config.branding.logoDevPublishableKey)}&size=128&format=png`
          : undefined
        return json(response, 200, {
          status: 'ok', topology: 'on-premises', profile: config.profile, cedar: service.policy.cedarVersion,
          bootstrapRequired: service.db.getSetting('bootstrapComplete') !== 'true',
          branding: {
            organizationName: config.branding.organizationName,
            ...(config.branding.organizationDomain ? { organizationDomain: config.branding.organizationDomain } : {}),
            ...(logoUrl ? { logoUrl } : {}),
          },
        })
      }
      if (url.pathname === '/api/license/request' && request.method === 'GET') return json(response, 200, service.license.activationRequest())
      if (url.pathname === '/api/auth/challenge' && request.method === 'GET') {
        const principal = auth.authenticate(request)
        if (!principal) return unauthorized(response, auth)
        return json(response, 200, { authenticated: true, principal })
      }
      if (url.pathname === '/api/license/status' && request.method === 'GET') return json(response, 200, service.license.status())
      if (url.pathname === '/api/auth/oidc/start' && request.method === 'GET') {
        const location = await auth.startOidc()
        response.writeHead(302, { location, 'cache-control': 'no-store' }); return response.end()
      }
      if (url.pathname === '/api/auth/oidc/native/start' && request.method === 'POST') {
        return json(response, 201, await auth.startNativeOidc())
      }
      if (url.pathname === '/api/auth/oidc/native/token' && request.method === 'POST') {
        const input = await body(request)
        const result = auth.exchangeNativeOidc(
          text(input.transaction_id, 'transaction_id', 256),
          text(input.exchange_token, 'exchange_token', 256),
        )
        if (!result) throw new HttpError(401, 'INVALID_AUTH_TRANSACTION', 'Authentication transaction is invalid or expired')
        return json(response, result.status === 'pending' ? 202 : 200, result)
      }
      if (url.pathname === '/api/auth/oidc/callback' && request.method === 'GET') {
        if (url.searchParams.has('error')) throw new HttpError(400, 'OIDC_CALLBACK_ERROR', 'Identity provider denied authentication')
        const principal = await auth.completeOidc(text(url.searchParams.get('code'), 'code', 4096), text(url.searchParams.get('state'), 'state', 4096))
        response.writeHead(302, {
          location: '/', 'set-cookie': auth.sessionCookie(auth.issueSession(principal.id)),
          'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
        }); return response.end()
      }
      const runtimeMcp = url.pathname.match(/^\/api\/runtime\/mcp\/([^/]+)\/([^/]+)$/)
      if (runtimeMcp && request.method === 'POST') {
        const authorization = request.headers.authorization
        const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : ''
        return json(response, 200, await service.proxyMcp(token, decodeURIComponent(runtimeMcp[1] as string), decodeURIComponent(runtimeMcp[2] as string), await body(request)))
      }

      // The web shell must load before authentication so it can render the
      // appropriate login experience. Only API routes use structured 401s.
      if (!url.pathname.startsWith('/api/')) {
        if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(404, 'NOT_FOUND', 'Endpoint not found')
        return serveWeb(url.pathname, response, request.method === 'HEAD')
      }

      const principal = auth.authenticate(request)
      if (!principal) return unauthorized(response, auth)
      if (url.pathname === '/api/me' && request.method === 'GET') return json(response, 200, principal)
      if (url.pathname === '/api/admin/overview' && request.method === 'GET') return json(response, 200, service.adminOverview(principal))
      if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
        auth.logout(principal.id)
        response.writeHead(204, { 'set-cookie': auth.clearSessionCookie(), 'cache-control': 'no-store' })
        return response.end()
      }
      if (url.pathname === '/api/bootstrap' && request.method === 'POST') {
        const input = await body(request)
        return json(response, 200, service.bootstrap(principal, text(input.secret, 'secret', 4096)))
      }
      if (url.pathname === '/api/users' && request.method === 'GET') {
        return json(response, 200, service.listUsers(principal))
      }
      if (url.pathname === '/api/invitations' && request.method === 'POST') {
        const input = await body(request)
        const role = text(input.role, 'role') as Role
        if (!ROLES.includes(role)) throw new HttpError(400, 'INVALID_INPUT', 'Unknown fixed role')
        return json(response, 201, service.createInvitation(principal, {
          identityValue: text(input.identityValue, 'identityValue', 1024),
          displayName: text(input.displayName, 'displayName'),
          ...(typeof input.email === 'string' && input.email.trim() ? { email: input.email.trim() } : {}),
          role,
        }))
      }
      const cancelInvitation = url.pathname.match(/^\/api\/invitations\/([^/]+)$/)
      if (cancelInvitation && request.method === 'DELETE') {
        return json(response, 200, service.cancelInvitation(principal, identifier(decodeURIComponent(cancelInvitation[1] as string), 'invitationId')))
      }
      const userRole = url.pathname.match(/^\/api\/users\/([^/]+)\/roles$/)
      if (userRole && request.method === 'POST') {
        const input = await body(request)
        const role = text(input.role, 'role') as Role
        if (!ROLES.includes(role)) throw new HttpError(400, 'INVALID_INPUT', 'Unknown fixed role')
        return json(response, 200, service.assignRole(principal, decodeURIComponent(userRole[1] as string), role))
      }
      const revokeSessions = url.pathname.match(/^\/api\/users\/([^/]+)\/revoke-sessions$/)
      if (revokeSessions && request.method === 'POST') {
        service.revokeSessions(principal, decodeURIComponent(revokeSessions[1] as string))
        return json(response, 204, null)
      }
      if ((url.pathname === '/api/environments' || url.pathname === '/api/workspaces') && request.method === 'GET') return json(response, 200, service.listEnvironments(principal))
      if ((url.pathname === '/api/environments' || url.pathname === '/api/workspaces') && request.method === 'POST') {
        const input = await body(request)
        return json(response, 201, service.createEnvironment(principal, { name: text(input.name, 'name'), description: typeof input.description === 'string' ? input.description.slice(0, 2000) : '' }))
      }
      if (url.pathname === '/api/assignments' && request.method === 'POST') {
        const input = await body(request)
        try { service.assign(principal, identifier(input.principalId, 'principalId'), identifier(input.environmentId ?? input.resourceId, 'environmentId')) }
        catch (error) { if (error instanceof Error && /not found/i.test(error.message)) throw new HttpError(400, 'INVALID_ASSIGNMENT', error.message); throw error }
        return json(response, 204, null)
      }
      if (url.pathname === '/api/sessions' && request.method === 'GET') {
        const sessions = service.listSessions(principal)
        const offset = decodeCursor(url.searchParams.get('cursor'))
        const limit = naturalNumber(url.searchParams.get('limit'), 50, 200, 1)
        const page = sessions.slice(offset, offset + limit)
        const next = offset + page.length
        return json(response, 200, {
          sessions: page,
          ...(next < sessions.length ? { nextCursor: encodeCursor(next) } : {}),
        })
      }
      if (url.pathname === '/api/sessions' && request.method === 'POST') {
        const input = await body(request)
        const cwd = typeof input.cwd === 'string' ? text(input.cwd, 'cwd', 4096) : '/'
        const agent = typeof input.agent === 'string' ? text(input.agent, 'agent') : service.defaultGatewayAgent()
        const requestedTarget = input.executionTargetId ?? input.environmentId ?? input.workspaceId
        const executionTargetId = requestedTarget === undefined ? undefined : identifier(requestedTarget, 'executionTargetId')
        return json(response, 201, service.createSession(principal, executionTargetId, agent, text(input.title, 'title'), cwd, 'general'))
      }
      const sessionDetail = url.pathname.match(/^\/api\/sessions\/([^/]+)$/)
      if (sessionDetail && request.method === 'GET') {
        return json(response, 200, service.getSession(principal, decodeURIComponent(sessionDetail[1] as string)))
      }
      const sessionEvents = url.pathname.match(/^\/api\/sessions\/([^/]+)\/events$/)
      if (sessionEvents && request.method === 'GET') {
        return json(response, 200, {
          events: service.sessionEvents(
            principal,
            decodeURIComponent(sessionEvents[1] as string),
            naturalNumber(url.searchParams.get('after'), 0, Number.MAX_SAFE_INTEGER),
            naturalNumber(url.searchParams.get('limit'), 200, 1_000, 1),
          ),
        })
      }
      const sessionEventStream = url.pathname.match(/^\/api\/sessions\/([^/]+)\/events\/stream$/)
      if (sessionEventStream && request.method === 'GET') {
        const lastEventId = request.headers['last-event-id']
        const after = naturalNumber(
          (typeof lastEventId === 'string' ? lastEventId : null) ?? url.searchParams.get('after'),
          0,
          Number.MAX_SAFE_INTEGER,
        )
        return streamSessionEvents(request, response, service, principal, decodeURIComponent(sessionEventStream[1] as string), after)
      }
      const sessionRuns = url.pathname.match(/^\/api\/sessions\/([^/]+)\/runs$/)
      if (sessionRuns && request.method === 'GET') {
        return json(response, 200, { runs: service.sessionRuns(principal, decodeURIComponent(sessionRuns[1] as string)) })
      }
      const sessionGoal = url.pathname.match(/^\/api\/sessions\/([^/]+)\/goal$/)
      if (sessionGoal && request.method === 'GET') return json(response, 200, { goal: await service.sessionGoal(principal, decodeURIComponent(sessionGoal[1] as string)) })
      if (sessionGoal && request.method === 'PUT') {
        const input = await body(request)
        return json(response, 200, { goal: await service.setSessionGoal(principal, decodeURIComponent(sessionGoal[1] as string), text(input.objective, 'objective', 4_000)) })
      }
      if (sessionGoal && request.method === 'DELETE') {
        await service.clearSessionGoal(principal, decodeURIComponent(sessionGoal[1] as string))
        return json(response, 204, null)
      }
      const sessionBrowserStream = url.pathname.match(/^\/api\/sessions\/([^/]+)\/browser\/stream$/)
      if (sessionBrowserStream && request.method === 'GET') return await streamBrowser(request, response, service, principal, decodeURIComponent(sessionBrowserStream[1] as string))
      const sessionBrowserInput = url.pathname.match(/^\/api\/sessions\/([^/]+)\/browser\/input$/)
      if (sessionBrowserInput && request.method === 'POST') {
        await service.browserInput(principal, decodeURIComponent(sessionBrowserInput[1] as string), await body(request))
        return json(response, 204, null)
      }
      const sessionArtifacts = url.pathname.match(/^\/api\/sessions\/([^/]+)\/artifacts$/)
      if (sessionArtifacts && request.method === 'GET') {
        const artifacts = service.sessionArtifacts(principal, decodeURIComponent(sessionArtifacts[1] as string))
        return json(response, 200, { artifacts: artifacts.map(({ content: _content, encoding: _encoding, ...artifact }) => artifact) })
      }
      const sessionAttachments = url.pathname.match(/^\/api\/sessions\/([^/]+)\/attachments$/)
      if (sessionAttachments && request.method === 'GET') {
        return json(response, 200, { attachments: service.sessionAttachments(principal, decodeURIComponent(sessionAttachments[1] as string)) })
      }
      if (sessionAttachments && request.method === 'POST') {
        const rawName = request.headers['x-papyrus-file-name']
        if (typeof rawName !== 'string') throw new HttpError(400, 'INVALID_INPUT', 'x-papyrus-file-name is required')
        let name: string
        try { name = decodeURIComponent(rawName) } catch { throw new HttpError(400, 'INVALID_INPUT', 'Attachment filename is invalid') }
        const mediaType = String(request.headers['content-type'] ?? 'application/octet-stream').split(';')[0]!.trim().toLowerCase()
        try {
          return json(response, 201, service.addAttachment(principal, decodeURIComponent(sessionAttachments[1] as string), name, mediaType, await binaryBody(request)))
        } catch (error) {
          if (error instanceof Error && /Attachment (?:type|must)/.test(error.message)) throw new HttpError(415, 'ATTACHMENT_REJECTED', error.message)
          throw error
        }
      }
      const attachmentFile = url.pathname.match(/^\/api\/sessions\/([^/]+)\/attachments\/([^/]+)\/download$/)
      if (attachmentFile && request.method === 'GET') {
        try {
          return attachmentDownload(response, service.attachmentContent(principal, decodeURIComponent(attachmentFile[1] as string), decodeURIComponent(attachmentFile[2] as string)))
        } catch (error) {
          if (error instanceof Error && error.message === 'Attachment not found') throw new HttpError(404, 'ATTACHMENT_NOT_FOUND', error.message)
          throw error
        }
      }
      const sessionApprovals = url.pathname.match(/^\/api\/sessions\/([^/]+)\/approvals$/)
      if (sessionApprovals && request.method === 'GET') {
        return json(response, 200, { approvals: service.sessionApprovals(principal, decodeURIComponent(sessionApprovals[1] as string)) })
      }
      const sessionElicitations = url.pathname.match(/^\/api\/sessions\/([^/]+)\/elicitations$/)
      if (sessionElicitations && request.method === 'GET') return json(response, 200, { elicitations: service.sessionElicitations(principal, decodeURIComponent(sessionElicitations[1] as string)) })
      const elicitationResponse = url.pathname.match(/^\/api\/sessions\/([^/]+)\/elicitations\/([^/]+)\/response$/)
      if (elicitationResponse && request.method === 'POST') {
        const input = await body(request)
        if (!['accept', 'decline', 'cancel'].includes(String(input.action))) throw new HttpError(400, 'INVALID_INPUT', 'Invalid elicitation action')
        return json(response, 200, service.respondElicitation(principal, decodeURIComponent(elicitationResponse[1] as string), decodeURIComponent(elicitationResponse[2] as string), input))
      }
      const sessionSources = url.pathname.match(/^\/api\/sessions\/([^/]+)\/sources$/)
      if (sessionSources && request.method === 'GET') {
        return json(response, 200, { sources: service.sessionSources(principal, decodeURIComponent(sessionSources[1] as string)) })
      }
      const approvalDecision = url.pathname.match(/^\/api\/sessions\/([^/]+)\/approvals\/([^/]+)\/decision$/)
      if (approvalDecision && request.method === 'POST') {
        const input = await body(request)
        const decision = text(input.decision, 'decision')
        if (decision !== 'approved' && decision !== 'denied') throw new HttpError(400, 'INVALID_INPUT', 'decision must be approved or denied')
        const reason = typeof input.reason === 'string' && input.reason.trim() ? text(input.reason, 'reason', 2_000) : undefined
        return json(response, 200, service.decideApproval(
          principal,
          decodeURIComponent(approvalDecision[1] as string),
          decodeURIComponent(approvalDecision[2] as string),
          decision,
          reason,
        ))
      }
      const artifactFile = url.pathname.match(/^\/api\/sessions\/([^/]+)\/artifacts\/([^/]+)\/download$/)
      if (artifactFile && request.method === 'GET') {
        const artifacts = service.sessionArtifacts(principal, decodeURIComponent(artifactFile[1] as string))
        const artifact = artifacts.find((candidate) => candidate.id === decodeURIComponent(artifactFile[2] as string))
        if (!artifact) throw new HttpError(404, 'ARTIFACT_NOT_FOUND', 'Artifact not found')
        return artifactDownload(response, artifact, url.searchParams.get('preview') === '1')
      }
      const cancelSession = url.pathname.match(/^\/api\/sessions\/([^/]+)\/cancel$/)
      if (cancelSession && request.method === 'POST') {
        return json(response, 200, { cancelled: service.cancelSession(principal, decodeURIComponent(cancelSession[1] as string)) })
      }
      const closeSession = url.pathname.match(/^\/api\/sessions\/([^/]+)\/close$/)
      if (closeSession && request.method === 'POST') {
        return json(response, 200, service.closeSession(principal, decodeURIComponent(closeSession[1] as string)))
      }
      const deleteSession = url.pathname.match(/^\/api\/sessions\/([^/]+)$/)
      if (deleteSession && request.method === 'DELETE') {
        service.deleteSession(principal, decodeURIComponent(deleteSession[1] as string))
        return json(response, 204, null)
      }
      const resumeSession = url.pathname.match(/^\/api\/sessions\/([^/]+)\/resume$/)
      if (resumeSession && request.method === 'POST') {
        return json(response, 200, service.resumeSession(principal, decodeURIComponent(resumeSession[1] as string)))
      }
      const prompt = url.pathname.match(/^\/api\/sessions\/([^/]+)\/(?:prompt|prompts)$/)
      if (prompt && request.method === 'POST') {
        const input = await body(request)
        const attachmentIds = Array.isArray(input.attachmentIds) && input.attachmentIds.every((id) => typeof id === 'string' && id.length <= 128)
          ? input.attachmentIds as string[] : []
        const promptText = typeof input.prompt === 'string' ? input.prompt.trim().slice(0, 100_000) : ''
        if (!promptText && attachmentIds.length === 0) throw new HttpError(400, 'INVALID_INPUT', 'prompt or attachmentIds is required')
        const run = await service.startPrompt(
          principal,
          decodeURIComponent(prompt[1] as string),
          promptText,
          attachmentIds,
        )
        return json(response, 202, { run })
      }
      if (url.pathname === '/api/mcp/oauth/clients' && request.method === 'PUT') {
        const input = await body(request)
        const clientSecret = typeof input.clientSecret === 'string' && input.clientSecret.trim()
          ? text(input.clientSecret, 'clientSecret', 4096)
          : undefined
        const scopes = typeof input.scopes === 'string' && input.scopes.trim()
          ? text(input.scopes, 'scopes', 4096)
          : undefined
        return json(response, 200, service.upsertMcpOauthClient(principal, {
          issuer: text(input.issuer, 'issuer', 2048),
          clientId: text(input.clientId, 'clientId', 2048),
          ...(clientSecret ? { clientSecret } : {}),
          ...(scopes ? { scopes } : {}),
        }))
      }
      const deleteOauthClient = url.pathname.match(/^\/api\/mcp\/oauth\/clients\/([^/]+)$/)
      if (deleteOauthClient && request.method === 'DELETE') {
        service.deleteMcpOauthClient(principal, decodeURIComponent(deleteOauthClient[1] as string))
        return json(response, 204, null)
      }
      if (url.pathname === '/api/mcp/servers' && request.method === 'POST') {
        const input = await body(request)
        return json(response, 201, await service.addMcpServer(principal, { name: text(input.name, 'name'), endpoint: text(input.endpoint, 'endpoint', 2048) }))
      }
      if (url.pathname === '/api/mcp/oauth/callback' && request.method === 'GET') {
        const state = text(url.searchParams.get('state'), 'state', 256)
        const issuer = url.searchParams.get('iss')?.trim() || undefined
        const oauthError = url.searchParams.get('error')?.trim()
        if (oauthError) {
          const description = url.searchParams.get('error_description')?.trim() || undefined
          const server = service.failMcpOauth(principal, state, oauthError, description, issuer)
          return oauthComplete(response, { ok: false, serverId: server.id, message: description ? `${oauthError}: ${description}` : oauthError })
        }
        const code = text(url.searchParams.get('code'), 'code', 4096)
        const server = await service.completeMcpOauth(principal, state, code, issuer)
        return oauthComplete(response, { ok: true, serverId: server.id, message: 'MCP authorization complete' })
      }
      if (url.pathname === '/api/mcp/servers' && request.method === 'GET') return json(response, 200, service.listMcpServers(principal))
      const retryMcpServer = url.pathname.match(/^\/api\/mcp\/servers\/([^/]+)\/retry$/)
      if (retryMcpServer && request.method === 'POST') return json(response, 200, await service.retryMcpOauth(principal, decodeURIComponent(retryMcpServer[1] as string)))
      const deleteMcpServer = url.pathname.match(/^\/api\/mcp\/servers\/([^/]+)$/)
      if (deleteMcpServer && request.method === 'DELETE') {
        service.deleteMcpServer(principal, decodeURIComponent(deleteMcpServer[1] as string))
        return json(response, 204, null)
      }
      const mcpServerState = url.pathname.match(/^\/api\/mcp\/servers\/([^/]+)\/state$/)
      if (mcpServerState && request.method === 'POST') {
        const input = await body(request)
        return json(response, 200, service.setMcpServerEnabled(principal, decodeURIComponent(mcpServerState[1] as string), boolean(input.enabled, 'enabled')))
      }
      if ((url.pathname === '/api/mcp/environment-grants' || url.pathname === '/api/mcp/grants') && request.method === 'POST') {
        const input = await body(request)
        try { service.grantMcpServer(principal, identifier(input.environmentId ?? input.workspaceId, 'environmentId'), identifier(input.mcpServerId, 'mcpServerId')) }
        catch (error) { if (error instanceof Error && /not found/i.test(error.message)) throw new HttpError(400, 'INVALID_GRANT', error.message); throw error }
        return json(response, 204, null)
      }
      const revokeGrant = url.pathname.match(/^\/api\/mcp\/grants\/([^/]+)$/)
      if (revokeGrant && request.method === 'DELETE') {
        service.revokeToolGrant(principal, decodeURIComponent(revokeGrant[1] as string))
        return json(response, 204, null)
      }
      if (url.pathname === '/api/mcp/invoke' && request.method === 'POST') {
        const input = await body(request)
        return json(response, 200, await service.invokeTool(principal, text(input.sessionId, 'sessionId'), text(input.mcpServerId, 'mcpServerId'), text(input.toolName, 'toolName'), input.arguments ?? {}))
      }
      if (url.pathname === '/api/activity' && request.method === 'GET') return json(response, 200, service.activity(principal))
      if (url.pathname === '/api/sources' && request.method === 'GET') return json(response, 200, { sources: service.listApprovedSources(principal) })
      if (url.pathname === '/api/sources/search' && request.method === 'GET') return json(response, 200, { results: service.searchApprovedSources(principal, text(url.searchParams.get('q'), 'q', 512), naturalNumber(url.searchParams.get('limit'), 10, 50, 1)) })
      const sourceChunk = url.pathname.match(/^\/api\/sources\/chunks\/([^/]+)$/)
      if (sourceChunk && request.method === 'GET') return json(response, 200, service.readApprovedSource(principal, decodeURIComponent(sourceChunk[1] as string)))
      if (url.pathname === '/api/admin/sources' && request.method === 'POST') {
        const input = await body(request)
        const kind = text(input.kind,'kind') as ApprovedSourceKind
        if (!(['upload', 'domain', 'mcp', 'api'] as ApprovedSourceKind[]).includes(kind)) throw new HttpError(400,'INVALID_INPUT','Unknown source kind')
        const mode = text(input.mode ?? 'snapshot','mode') as 'snapshot'|'live'
        if (!['snapshot','live'].includes(mode)) throw new HttpError(400,'INVALID_INPUT','Unknown source mode')
        return json(response,201,service.createApprovedSource(principal,{name:text(input.name,'name'),kind,locator:text(input.locator,'locator',4096),mode}))
      }
      const sourceAssignment = url.pathname.match(/^\/api\/admin\/sources\/([^/]+)\/assignments\/([^/]+)$/)
      if (sourceAssignment && request.method === 'PUT') {
        const input = await body(request)
        service.assignApprovedSource(principal,identifier(sourceAssignment[1],'sourceId'),identifier(sourceAssignment[2],'userId'),boolean(input.assigned,'assigned'))
        return json(response,204,null)
      }
      const sourceIngest = url.pathname.match(/^\/api\/admin\/sources\/([^/]+)\/documents$/)
      if (sourceIngest && request.method === 'POST') {
        const input = await body(request)
        service.ingestApprovedSource(principal,identifier(sourceIngest[1],'sourceId'),{uri:text(input.uri,'uri',4096),title:text(input.title,'title',512),mediaType:text(input.mediaType ?? 'text/plain','mediaType',128),content:text(input.content,'content',900000)})
        return json(response,204,null)
      }
      if (url.pathname === '/api/audit' && request.method === 'GET') return json(response, 200, service.auditEvents(principal))
      if (url.pathname === '/api/audit/checkpoint' && request.method === 'GET') return json(response, 200, service.exportAuditCheckpoint(principal))
      if (url.pathname === '/api/license/activate' && request.method === 'POST') return json(response, 200, service.activateLicense(principal, await body(request) as unknown as SignedLicense))
      throw new HttpError(404, 'NOT_FOUND', 'Endpoint not found')
    } catch (error) {
      if (url.pathname === '/api/auth/oidc/callback') {
        auth.recordAuthenticationFailure('oidc', error instanceof Error ? error.message : 'authentication_failed', requestId)
      }
      const invitationRequired = error instanceof Error && error.message === 'INVITATION_REQUIRED'
      const status = error instanceof HttpError
        ? error.status
        : invitationRequired
          ? 403
        : error instanceof AuthorizationDenied
          ? 403
          : error instanceof SessionLifecycleError
            ? error.code === 'SESSION_NOT_FOUND' ? 404 : 409
            : error instanceof ApprovalLifecycleError
              ? error.code === 'APPROVAL_NOT_FOUND' ? 404 : 409
            : 500
      const code = error instanceof HttpError
        ? error.code
        : invitationRequired
          ? 'INVITATION_REQUIRED'
        : error instanceof AuthorizationDenied
          ? 'FORBIDDEN'
          : error instanceof SessionLifecycleError
            ? error.code
            : error instanceof ApprovalLifecycleError
              ? error.code
            : 'INTERNAL_ERROR'
      const message = invitationRequired ? 'No active invitation matches this organizational identity' : status === 500 ? 'Internal server error' : error instanceof Error ? error.message : 'Request failed'
      if (status === 500) console.error(`[${requestId}]`, error)
      return json(response, status, { error: message, code, requestId })
    }
  }

  if (config.tls) {
    const requireClientCertificate = config.profile.startsWith('government')
    const requestClientCertificate = requireClientCertificate || Boolean(config.identityProxy)
    return createHttpsServer({
      cert: readFileSync(config.tls.certPath), key: readFileSync(config.tls.keyPath), ca: readFileSync(config.tls.caPath),
      ...(config.tls.crlPath ? { crl: readFileSync(config.tls.crlPath) } : {}),
      requestCert: requestClientCertificate, rejectUnauthorized: requireClientCertificate, minVersion: 'TLSv1.2',
    }, (request, response) => { void handler(request, response) })
  }
  return createHttpServer((request, response) => { void handler(request, response) })
}

function serveWeb(pathname: string, response: ServerResponse, head = false): void {
  const webRoot = join(import.meta.dirname, '../../web/dist')
  const requested = pathname === '/' ? 'index.html' : normalize(pathname).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]/, '')
  const file = join(webRoot, requested)
  try {
    const content = readFileSync(file)
    const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' }
    response.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; connect-src 'self'" })
    response.end(head ? undefined : content)
  } catch {
    try {
      const content = readFileSync(join(webRoot, 'index.html'))
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; connect-src 'self'" }); response.end(head ? undefined : content)
    } catch { throw new HttpError(404, 'NOT_FOUND', 'Web UI has not been built') }
  }
}
