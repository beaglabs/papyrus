import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { Duplex } from 'node:stream'
import { AcpServer } from '@agentclientprotocol/sdk/experimental/server'
import { createNodeHttpHandler } from '@agentclientprotocol/sdk/experimental/node'
import type { Principal, Workspace } from '@papyrus/contracts'
import { AuthService } from './auth.js'
import { buildAcpAgent, type AcpAgentContext } from './acp-server.js'
import type { ServerConfig } from './config.js'
import { PapyrusService } from './service.js'

interface ConnectionBinding {
  principalId: string
  workspaceId: string
  lastSeenAt: number
  activeRequests: number
}

function devPrincipal(config: ServerConfig, request: IncomingMessage, service: PapyrusService): Principal | undefined {
  const secrets = (config.gateway ? [config.gateway.devToken].filter(Boolean) : []) as string[]
  const match = (presented: string): boolean => {
    const a = createHash('sha256').update(presented).digest()
    for (const expected of secrets) {
      const b = createHash('sha256').update(expected).digest()
      if (timingSafeEqual(a, b)) return true
    }
    return false
  }
  const authorization = request.headers.authorization
  const xSecretKey = singleHeader(request.headers['x-secret-key'])
  if ((authorization?.startsWith('Bearer ') && match(authorization.slice(7))) || (xSecretKey && match(xSecretKey))) {
    const principal = service.db.upsertUser({ externalId: 'dev:gateway:token', displayName: 'Gateway Developer', authMethod: 'development' })
    service.db.setRole(principal.id, 'User')
    return service.db.getPrincipal(principal.id)
  }
  return undefined
}

function authenticate(config: ServerConfig, service: PapyrusService, auth: AuthService, request: IncomingMessage): Principal | undefined {
  return auth.authenticate(request) ?? devPrincipal(config, request, service)
}

function resolveWorkspace(service: PapyrusService, principal: Principal, headerValue: string | string[] | undefined): Workspace | undefined {
  const available = service.listWorkspaces(principal)
  const header = singleHeader(headerValue)
  if (header) return available.find((workspace) => workspace.id === header)
  return available.length === 1 ? available[0] : undefined
}

function resolveRequestWorkspace(service: PapyrusService, config: ServerConfig, request: IncomingMessage, principal: Principal): Workspace | undefined {
  const workspace = resolveWorkspace(service, principal, request.headers['x-papyrus-workspace-id'])
  if (workspace) return workspace
  if (!config.devIdentity || singleHeader(request.headers['x-papyrus-workspace-id'])) return undefined
  const existing = service.listWorkspaces(principal)
  if (existing.length >= 1) return existing[0]
  const created = service.db.createWorkspace({ name: 'default', description: 'Auto-created dev workspace' })
  service.db.assign('user', principal.id, 'workspace', created.id)
  console.log(`[gateway] Auto-created default workspace ${created.id} for dev principal`)
  return created
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value.length === 1 ? value[0] : undefined
  if (!value || value.includes(',')) return undefined
  return value
}

function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader('cache-control', 'no-store')
  response.setHeader('x-content-type-options', 'nosniff')
  response.setHeader('referrer-policy', 'no-referrer')
}

function json(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...headers,
  })
  response.end(body)
}

function rejectUpgrade(socket: Duplex): void {
  const body = JSON.stringify({
    error: 'streamable_http_required',
    code: 'STREAMABLE_HTTP_REQUIRED',
    message: 'WebSocket transport is disabled; use ACP Streamable HTTP at /acp',
  })
  socket.end([
    'HTTP/1.1 400 Bad Request',
    'Connection: close',
    'Content-Type: application/json; charset=utf-8',
    'Cache-Control: no-store',
    'X-Content-Type-Options: nosniff',
    `Content-Length: ${Buffer.byteLength(body)}`,
    '',
    body,
  ].join('\r\n'))
}

export function createGatewayServer(config: ServerConfig, service: PapyrusService, auth: AuthService): ReturnType<typeof createHttpServer> {
  const gatewayConfig = config.gateway
  if (!gatewayConfig) throw new Error('Gateway is not enabled (set PAPYRUS_GATEWAY_ENABLED=true)')

  const maxRequestBodyBytes = gatewayConfig.maxRequestBodyBytes ?? 1_048_576
  const maxConnections = gatewayConfig.maxConnections ?? 128
  const connectionIdleMs = gatewayConfig.connectionIdleMs ?? 900_000
  const requestTimeoutMs = gatewayConfig.requestTimeoutMs ?? 30_000
  const bindings = new Map<string, ConnectionBinding>()
  let pendingInitializations = 0

  const agentContext = new AsyncLocalStorage<AcpAgentContext>()
  const acpServer = new AcpServer({
    createAgent: () => {
      const context = agentContext.getStore()
      if (!context) throw new Error('ACP initialization requires authenticated request context')
      return buildAcpAgent(service, context)
    },
  })
  const httpHandler = createNodeHttpHandler(acpServer, { maxRequestBodyBytes })

  const expireConnection = (connectionId: string): void => {
    bindings.delete(connectionId)
    void acpServer.handleRequest(new Request('http://papyrus.local/acp', {
      method: 'DELETE',
      headers: { 'Acp-Connection-Id': connectionId },
    })).catch(() => {})
  }
  const sweep = setInterval(() => {
    const cutoff = Date.now() - connectionIdleMs
    for (const [connectionId, binding] of bindings) {
      if (binding.activeRequests === 0 && binding.lastSeenAt <= cutoff) expireConnection(connectionId)
    }
  }, Math.max(1_000, Math.min(connectionIdleMs, 60_000)))
  sweep.unref()

  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    applySecurityHeaders(response)
    const url = new URL(request.url ?? '/', 'http://papyrus.local')

    if ((url.pathname === '/health' || url.pathname === '/status') && ['GET', 'HEAD'].includes(request.method ?? '')) {
      if (url.pathname === '/status') return json(response, 200, { status: 'ok', transport: 'streamable-http', endpoint: '/acp' })
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      response.end(request.method === 'HEAD' ? undefined : 'ok')
      return
    }

    if (url.pathname !== '/acp') {
      json(response, 404, { error: 'not_found', code: 'NOT_FOUND' })
      return
    }

    const principal = authenticate(config, service, auth, request)
    if (!principal) {
      json(response, 401, auth.challenge(), { 'www-authenticate': 'Bearer realm="Papyrus"' })
      return
    }

    const connectionId = singleHeader(request.headers['acp-connection-id'])
    if (connectionId) {
      const binding = bindings.get(connectionId)
      if (!binding || binding.principalId !== principal.id) {
        json(response, 404, { error: 'connection_not_found', code: 'CONNECTION_NOT_FOUND' })
        return
      }
      const requestedWorkspace = singleHeader(request.headers['x-papyrus-workspace-id'])
      if (requestedWorkspace && requestedWorkspace !== binding.workspaceId) {
        json(response, 403, { error: 'workspace_mismatch', code: 'WORKSPACE_MISMATCH' })
        return
      }
      binding.lastSeenAt = Date.now()
      binding.activeRequests += 1
      let settled = false
      const settle = (): void => {
        if (settled) return
        settled = true
        binding.activeRequests = Math.max(0, binding.activeRequests - 1)
        binding.lastSeenAt = Date.now()
        if (request.method === 'DELETE' && response.statusCode < 300) bindings.delete(connectionId)
      }
      response.once('finish', settle)
      response.once('close', settle)
      httpHandler(request, response)
      return
    }

    if (request.method !== 'POST') {
      httpHandler(request, response)
      return
    }
    if (bindings.size + pendingInitializations >= maxConnections) {
      json(response, 429, { error: 'connection_limit_reached', code: 'CONNECTION_LIMIT_REACHED' }, { 'retry-after': '1' })
      return
    }
    const workspace = resolveRequestWorkspace(service, config, request, principal)
    if (!workspace) {
      json(response, 400, {
        error: 'workspace_required',
        code: 'WORKSPACE_REQUIRED',
        message: 'Workspace is missing, ambiguous, or unavailable; set X-Papyrus-Workspace-Id',
      })
      return
    }

    pendingInitializations += 1
    let settled = false
    const settleInitialization = (completed: boolean): void => {
      if (settled) return
      settled = true
      pendingInitializations = Math.max(0, pendingInitializations - 1)
      if (!completed || response.statusCode < 200 || response.statusCode >= 300) return
      const initializedConnectionId = response.getHeader('acp-connection-id')
      if (typeof initializedConnectionId !== 'string') return
      bindings.set(initializedConnectionId, {
        principalId: principal.id,
        workspaceId: workspace.id,
        lastSeenAt: Date.now(),
        activeRequests: 0,
      })
    }
    response.once('finish', () => settleInitialization(true))
    response.once('close', () => settleInitialization(false))
    agentContext.run({ principal, workspace }, () => httpHandler(request, response))
  }

  let server: ReturnType<typeof createHttpServer>
  if (gatewayConfig.tls) {
    server = createHttpsServer({
      cert: readFileSync(gatewayConfig.tls.certPath),
      key: readFileSync(gatewayConfig.tls.keyPath),
      ca: readFileSync(gatewayConfig.tls.caPath),
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
    }, handler)
  } else if (gatewayConfig.host !== '127.0.0.1' && gatewayConfig.host !== '::1') {
    clearInterval(sweep)
    throw new Error('Gateway requires mTLS when listening on a non-loopback address')
  } else {
    server = createHttpServer(handler)
  }

  server.requestTimeout = requestTimeoutMs
  server.headersTimeout = Math.min(requestTimeoutMs, 60_000)
  server.keepAliveTimeout = 5_000
  server.maxHeadersCount = 64
  server.maxConnections = Math.max(32, maxConnections * 3)
  server.on('upgrade', (_request, socket) => rejectUpgrade(socket))
  server.on('close', () => {
    clearInterval(sweep)
    bindings.clear()
    void acpServer.close()
  })

  return server
}
