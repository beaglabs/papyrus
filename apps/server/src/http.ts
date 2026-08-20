import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { readFileSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { ROLES, type Role, type SignedLicense } from '@papyrus/contracts'
import { AuthService } from './auth.js'
import type { ServerConfig } from './config.js'
import { AuthorizationDenied, PapyrusService } from './service.js'

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
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

function text(value: unknown, name: string, maximum = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new HttpError(400, 'INVALID_INPUT', `${name} is required and must not exceed ${maximum} characters`)
  return value.trim()
}

export function createPapyrusServer(config: ServerConfig, service: PapyrusService, auth: AuthService): Server {
  const handler = async (request: IncomingMessage, response: ServerResponse) => {
    const requestId = crypto.randomUUID()
    response.setHeader('x-request-id', requestId)
    try {
      const url = new URL(request.url ?? '/', config.publicOrigin)
      if (url.pathname === '/api/health' && request.method === 'GET') {
        return json(response, 200, { status: 'ok', mode: config.mode, profile: config.profile, cedar: service.policy.cedarVersion, bootstrapRequired: service.db.getSetting('bootstrapComplete') !== 'true' })
      }
      if (url.pathname === '/api/license/request' && request.method === 'GET') return json(response, 200, service.license.activationRequest())
      if (url.pathname === '/api/license/status' && request.method === 'GET') return json(response, 200, service.license.status())
      if (url.pathname === '/api/auth/oidc/start' && request.method === 'GET') {
        const location = await auth.startOidc()
        response.writeHead(302, { location, 'cache-control': 'no-store' }); return response.end()
      }
      if (url.pathname === '/api/auth/oidc/callback' && request.method === 'GET') {
        const principal = await auth.completeOidc(text(url.searchParams.get('code'), 'code', 4096), text(url.searchParams.get('state'), 'state', 4096))
        response.writeHead(302, {
          location: '/', 'set-cookie': `papyrus_session=${encodeURIComponent(auth.issueSession(principal.id))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${config.publicOrigin.startsWith('https:') ? '; Secure' : ''}`,
          'cache-control': 'no-store',
        }); return response.end()
      }
      const runtimeMcp = url.pathname.match(/^\/api\/runtime\/mcp\/([^/]+)\/([^/]+)$/)
      if (runtimeMcp && request.method === 'POST') {
        const authorization = request.headers.authorization
        const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : ''
        return json(response, 200, await service.proxyMcp(token, decodeURIComponent(runtimeMcp[1] as string), decodeURIComponent(runtimeMcp[2] as string), await body(request)))
      }

      const principal = auth.authenticate(request)
      if (!principal) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required')
      if (url.pathname === '/api/me' && request.method === 'GET') return json(response, 200, principal)
      if (url.pathname === '/api/bootstrap' && request.method === 'POST') {
        const input = await body(request)
        return json(response, 200, service.bootstrap(principal, text(input.secret, 'secret', 4096)))
      }
      if (url.pathname === '/api/users' && request.method === 'GET') {
        return json(response, 200, service.listUsers(principal))
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
      if (url.pathname === '/api/workspaces' && request.method === 'GET') return json(response, 200, service.listWorkspaces(principal))
      if (url.pathname === '/api/workspaces' && request.method === 'POST') {
        const input = await body(request)
        return json(response, 201, service.createWorkspace(principal, { name: text(input.name, 'name'), description: typeof input.description === 'string' ? input.description.slice(0, 2000) : '' }))
      }
      if (url.pathname === '/api/assignments' && request.method === 'POST') {
        const input = await body(request)
        service.assign(principal, text(input.principalId, 'principalId'), text(input.resourceId, 'resourceId'))
        return json(response, 204, null)
      }
      if (url.pathname === '/api/sessions' && request.method === 'GET') return json(response, 200, service.listSessions(principal))
      if (url.pathname === '/api/sessions' && request.method === 'POST') {
        const input = await body(request)
        return json(response, 201, service.createSession(principal, text(input.workspaceId, 'workspaceId'), text(input.agent, 'agent'), text(input.title, 'title')))
      }
      const prompt = url.pathname.match(/^\/api\/sessions\/([^/]+)\/prompt$/)
      if (prompt && request.method === 'POST') {
        const input = await body(request)
        return json(response, 200, await service.prompt(principal, decodeURIComponent(prompt[1] as string), text(input.prompt, 'prompt', 100_000)))
      }
      if (url.pathname === '/api/mcp/servers' && request.method === 'POST') {
        const input = await body(request)
        return json(response, 201, service.addMcpServer(principal, { name: text(input.name, 'name'), endpoint: text(input.endpoint, 'endpoint', 2048) }))
      }
      if (url.pathname === '/api/mcp/servers' && request.method === 'GET') return json(response, 200, service.listMcpServers(principal))
      if (url.pathname === '/api/mcp/grants' && request.method === 'POST') {
        const input = await body(request)
        service.grantTool(principal, text(input.workspaceId, 'workspaceId'), text(input.mcpServerId, 'mcpServerId'), text(input.toolName, 'toolName'))
        return json(response, 204, null)
      }
      if (url.pathname === '/api/mcp/invoke' && request.method === 'POST') {
        const input = await body(request)
        return json(response, 200, await service.invokeTool(principal, text(input.sessionId, 'sessionId'), text(input.mcpServerId, 'mcpServerId'), text(input.toolName, 'toolName'), input.arguments ?? {}))
      }
      if (url.pathname === '/api/activity' && request.method === 'GET') return json(response, 200, service.activity(principal))
      if (url.pathname === '/api/audit' && request.method === 'GET') return json(response, 200, service.auditEvents(principal))
      if (url.pathname === '/api/audit/checkpoint' && request.method === 'GET') return json(response, 200, service.exportAuditCheckpoint(principal))
      if (url.pathname === '/api/license/activate' && request.method === 'POST') return json(response, 200, service.activateLicense(principal, await body(request) as unknown as SignedLicense))
      if (url.pathname.startsWith('/api/')) throw new HttpError(404, 'NOT_FOUND', 'Endpoint not found')
      return serveWeb(url.pathname, response)
    } catch (error) {
      const status = error instanceof HttpError ? error.status : error instanceof AuthorizationDenied ? 403 : 500
      const code = error instanceof HttpError ? error.code : error instanceof AuthorizationDenied ? 'FORBIDDEN' : 'INTERNAL_ERROR'
      const message = status === 500 ? 'Internal server error' : error instanceof Error ? error.message : 'Request failed'
      if (status === 500) console.error(`[${requestId}]`, error)
      return json(response, status, { error: message, code, requestId })
    }
  }

  if (config.tls) {
    const requireClientCertificate = config.profile.startsWith('government')
    return createHttpsServer({
      cert: readFileSync(config.tls.certPath), key: readFileSync(config.tls.keyPath), ca: readFileSync(config.tls.caPath),
      ...(config.tls.crlPath ? { crl: readFileSync(config.tls.crlPath) } : {}),
      requestCert: requireClientCertificate, rejectUnauthorized: requireClientCertificate, minVersion: 'TLSv1.2',
    }, (request, response) => { void handler(request, response) })
  }
  return createHttpServer((request, response) => { void handler(request, response) })
}

function serveWeb(pathname: string, response: ServerResponse): void {
  const webRoot = join(import.meta.dirname, '../../web/dist')
  const requested = pathname === '/' ? 'index.html' : normalize(pathname).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]/, '')
  const file = join(webRoot, requested)
  try {
    const content = readFileSync(file)
    const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' }
    response.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff' })
    response.end(content)
  } catch {
    try {
      const content = readFileSync(join(webRoot, 'index.html'))
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff' }); response.end(content)
    } catch { throw new HttpError(404, 'NOT_FOUND', 'Web UI has not been built') }
  }
}
