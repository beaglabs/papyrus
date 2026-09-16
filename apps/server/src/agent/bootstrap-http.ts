import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, join, normalize } from 'node:path'
import type { SignedLicense } from '@papyrus/contracts'
import type { LicenseService } from '../license.js'
import type { BootstrapConfig, BootstrapContext } from './bootstrap.js'
import { writeBootstrapConfig } from './bootstrap.js'

/**
 * The first-run server. It serves only the onboarding API and the static portal,
 * and nothing else — no agent data, no integrations, no model gateway — until the
 * operator completes onboarding. Completing persists the secret and Entra config
 * and hands control to the full server through `onComplete`.
 */

class BootstrapHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

function securityHeaders(response: ServerResponse): void {
  response.setHeader('cache-control', 'no-store')
  response.setHeader('content-security-policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'self'")
  response.setHeader('cross-origin-opener-policy', 'same-origin')
  response.setHeader('referrer-policy', 'no-referrer')
  response.setHeader('x-content-type-options', 'nosniff')
  response.setHeader('x-frame-options', 'SAMEORIGIN')
}

function json(response: ServerResponse, status: number, value: unknown): void {
  securityHeaders(response)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}

async function body(request: IncomingMessage, maximumBytes = 1_048_576): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maximumBytes) throw new BootstrapHttpError(413, 'BODY_TOO_LARGE', 'Request body exceeds 1 MiB')
    chunks.push(buffer)
  }
  if (!chunks.length) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object required')
    return parsed as Record<string, unknown>
  } catch { throw new BootstrapHttpError(400, 'INVALID_JSON', 'Request body must be a JSON object') }
}

function requiredString(value: unknown, name: string, maximum = 4096): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new BootstrapHttpError(400, 'INVALID_INPUT', `${name} is required`)
  return value.trim()
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

export function createBootstrapServer(
  context: BootstrapContext,
  licenseService: LicenseService,
  onComplete: (config: BootstrapConfig) => void,
  setupToken: string,
): Server {
  let saved: BootstrapConfig | undefined

  const requireToken = (request: IncomingMessage): void => {
    if (request.headers['x-bootstrap-token'] !== setupToken) {
      throw new BootstrapHttpError(401, 'BOOTSTRAP_TOKEN_REQUIRED', 'Setup token is required')
    }
  }

  const status = () => {
    const license = licenseService.status()
    return {
      bootstrap: true,
      organizationName: context.organizationName,
      profile: context.profile,
      cloud: context.cloud,
      deploymentId: licenseService.deploymentId,
      license,
      portalSecretSet: Boolean(saved),
      entraSet: Boolean(saved),
    }
  }

  const handler = async (request: IncomingMessage, response: ServerResponse) => {
    const requestId = crypto.randomUUID()
    response.setHeader('x-request-id', requestId)
    const url = new URL(request.url ?? '/', `http://${context.host}:${context.port}`)
    try {
      if (url.pathname === '/api/config/public' && request.method === 'GET') return json(response, 200, status())
      if (url.pathname === '/api/bootstrap/status' && request.method === 'GET') return json(response, 200, status())
      if (url.pathname === '/api/license/request' && request.method === 'GET') return json(response, 200, licenseService.activationRequest())
      if (url.pathname === '/api/license/status' && request.method === 'GET') return json(response, 200, licenseService.status())
      if (url.pathname === '/api/bootstrap/token' && request.method === 'POST') {
        const input = await body(request)
        if (typeof input.token !== 'string' || input.token !== setupToken) {
          throw new BootstrapHttpError(401, 'BOOTSTRAP_TOKEN_REQUIRED', 'Setup token is invalid')
        }
        return json(response, 200, { valid: true })
      }
      if (url.pathname === '/api/license/activate' && request.method === 'POST') {
        requireToken(request)
        return json(response, 200, licenseService.activate(await body(request) as unknown as SignedLicense))
      }
      if (url.pathname === '/api/bootstrap/config' && request.method === 'POST') {
        requireToken(request)
        const input = await body(request)
        const secret = requiredString(input.portalSecret, 'portalSecret', 4096)
        if (secret.length < 32) throw new BootstrapHttpError(400, 'PORTAL_SECRET_TOO_SHORT', 'Portal secret must be at least 32 characters')
        const entraInput = input.entra as Record<string, unknown> | undefined
        if (!entraInput || typeof entraInput !== 'object') throw new BootstrapHttpError(400, 'INVALID_INPUT', 'entra is required')
        const entra = {
          tenantId: requiredString(entraInput.tenantId, 'entra.tenantId', 256),
          clientId: requiredString(entraInput.clientId, 'entra.clientId', 256),
          ...(typeof entraInput.clientSecret === 'string' && entraInput.clientSecret.trim() ? { clientSecret: entraInput.clientSecret.trim() } : {}),
          ...(typeof entraInput.scope === 'string' && entraInput.scope.trim() ? { scope: entraInput.scope.trim() } : {}),
        }
        saved = { portalSecret: secret, entra }
        writeBootstrapConfig(context.dataDir, saved)
        return json(response, 200, { saved: true, ...status() })
      }
      if (url.pathname === '/api/bootstrap/complete' && request.method === 'POST') {
        requireToken(request)
        const license = licenseService.status()
        const configReady = Boolean(saved)
        if (configReady && license.valid) {
          onComplete(saved as BootstrapConfig)
          return json(response, 200, { complete: true })
        }
        return json(response, 200, { complete: false, license, portalSecretSet: configReady, entraSet: configReady })
      }
      if (url.pathname.startsWith('/api/')) throw new BootstrapHttpError(404, 'NOT_FOUND', 'API route not found')
      return servePortal(response, url.pathname)
    } catch (cause) {
      const failure = cause instanceof BootstrapHttpError ? cause : new BootstrapHttpError(500, 'INTERNAL_ERROR', cause instanceof Error ? cause.message : 'Unexpected server failure')
      return json(response, failure.status, { error: failure.message, code: failure.code, requestId })
    }
  }

  return createServer(handler)
}
