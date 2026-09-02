import { readFileSync } from 'node:fs'
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { extname, join, normalize } from 'node:path'
import type { EntraAppRole, PortalPrincipal, SignedLicense } from '@papyrus/contracts'
import type { CyberConfig } from './config.js'
import { EntraAuthError, EntraAuthService, hasAppRole } from './entra-auth.js'
import { CyberService, CyberServiceError } from './service.js'

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

async function principal(request: IncomingMessage, auth: EntraAuthService, service: CyberService): Promise<PortalPrincipal> {
  const value = await auth.authenticate(request)
  if (!value) throw new HttpError(401, 'ENTRA_AUTHENTICATION_REQUIRED', 'Microsoft Entra authentication is required')
  service.requirePortalAccess(value)
  return value
}

export function createCyberServer(config: CyberConfig, service: CyberService, auth: EntraAuthService): Server {
  const handler = async (request: IncomingMessage, response: ServerResponse) => {
    const requestId = crypto.randomUUID()
    response.setHeader('x-request-id', requestId)
    const url = new URL(request.url ?? '/', config.publicOrigin)
    try {
      if (url.pathname === '/api/health' && request.method === 'GET') {
        return json(response, 200, {
          status: 'ok', product: 'Papyrus Cyber Twin', topology: 'customer-hosted', profile: config.profile,
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
      if (url.pathname === '/api/integrations/catalog' && request.method === 'GET') return json(response, 200, { integrations: service.catalog(await principal(request, auth, service)) })
      if (url.pathname === '/api/integrations' && request.method === 'GET') return json(response, 200, { integrations: service.integrations(await principal(request, auth, service)) })
      if (url.pathname === '/api/terrain' && request.method === 'GET') return json(response, 200, service.terrainSnapshot(await principal(request, auth, service)))
      if (url.pathname === '/api/integrations' && request.method === 'POST') {
        const input = await body(request)
        return json(response, 201, service.createIntegration(await principal(request, auth, service), input.catalogId, input))
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
      const observations = url.pathname.match(/^\/api\/integrations\/([^/]+)\/observations$/)
      if (observations && request.method === 'POST') {
        const result = service.ingestObservation(
          await principal(request, auth, service), decodeURIComponent(observations[1] as string), await body(request),
        )
        return json(response, result.created ? 201 : 200, result)
      }
      const sync = url.pathname.match(/^\/api\/integrations\/([^/]+)\/sync$/)
      if (sync && request.method === 'POST') return json(response, 202, service.requestSync(
        await principal(request, auth, service), decodeURIComponent(sync[1] as string),
      ))
      const jobs = url.pathname.match(/^\/api\/integrations\/([^/]+)\/sync-jobs$/)
      if (jobs && request.method === 'GET') return json(response, 200, { jobs: service.syncJobs(
        await principal(request, auth, service), decodeURIComponent(jobs[1] as string),
      ) })

      if (url.pathname.startsWith('/api/')) throw new HttpError(404, 'NOT_FOUND', 'API route not found')
      return servePortal(response, url.pathname)
    } catch (cause) {
      const failure = cause instanceof HttpError || cause instanceof CyberServiceError
        ? cause
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
