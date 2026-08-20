import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { Duplex } from 'node:stream'
import type { TLSSocket } from 'node:tls'
import { AcpServer } from '@agentclientprotocol/sdk/experimental/server'
import { createNodeHttpHandler } from '@agentclientprotocol/sdk/experimental/node'
import type { Principal, Workspace } from '@papyrus/contracts'
import { WebSocketServer } from 'ws'
import { AuthService } from './auth.js'
import { buildAcpAgent, type AcpAgentContext } from './acp-server.js'
import type { ServerConfig } from './config.js'
import { PapyrusService } from './service.js'

function devPrincipal(config: ServerConfig, request: IncomingMessage, service: PapyrusService): Principal | undefined {
  const secrets = (config.gateway ? [config.gateway.devToken, process.env.GOOSE_SERVER__SECRET_KEY].filter(Boolean) : []) as string[]
  const match = (presented: string): boolean => {
    const a = createHash('sha256').update(presented).digest()
    for (const expected of secrets) {
      const b = createHash('sha256').update(expected).digest()
      if (timingSafeEqual(a, b)) return true
    }
    return false
  }
  const authorization = request.headers.authorization
  if (authorization?.startsWith('Bearer ') && match(authorization.slice(7))) {
    return service.db.upsertUser({ externalId: 'dev:gateway:token', displayName: 'Gateway Developer', authMethod: 'development' })
  }
  const xSecretKey = request.headers['x-secret-key']
  if (typeof xSecretKey === 'string' && match(xSecretKey)) {
    return service.db.upsertUser({ externalId: 'dev:gateway:token', displayName: 'Gateway Developer', authMethod: 'development' })
  }
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
  const queryToken = url.searchParams.get('token')
  if (queryToken && match(queryToken)) {
    return service.db.upsertUser({ externalId: 'dev:gateway:token', displayName: 'Gateway Developer', authMethod: 'development' })
  }
  if (config.devIdentity) {
    const parts = config.devIdentity.split(':')
    return service.db.upsertUser({ externalId: `dev:${parts[0]}`, displayName: parts[1] ?? parts[0] ?? 'Developer', authMethod: 'development' })
  }
  return undefined
}

function authenticate(config: ServerConfig, service: PapyrusService, auth: AuthService, request: IncomingMessage): Principal | undefined {
  const socket = request.socket as TLSSocket
  if (typeof socket.authorized === 'boolean' && socket.encrypted) return auth.principalFromSocket(socket)
  return devPrincipal(config, request, service)
}

function resolveWorkspace(service: PapyrusService, principal: Principal, headerValue: string | string[] | undefined): Workspace | undefined {
  const header = Array.isArray(headerValue) ? headerValue[0] : headerValue
  if (header) return service.db.getWorkspace(header)
  const assigned = service.listWorkspaces(principal)
  return assigned.length === 1 ? assigned[0] : undefined
}

function resolveRequestWorkspace(service: PapyrusService, config: ServerConfig, request: IncomingMessage, principal: Principal): Workspace | undefined {
  const workspace = resolveWorkspace(service, principal, request.headers['x-papyrus-workspace-id'])
  if (workspace) return workspace
  if (!config.devIdentity) return undefined
  const existing = service.listWorkspaces(principal)
  if (existing.length >= 1) return existing[0]
  const ws = service.db.createWorkspace({ name: 'default', description: 'Auto-created dev workspace' })
  service.db.assign('user', principal.id, 'workspace', ws.id)
  console.log(`[gateway] Auto-created default workspace ${ws.id} for dev principal`)
  return ws
}

function rejectUpgrade(socket: Duplex, status: number, statusText: string, message: string): void {
  const body = `${message}\n`
  socket.end([
    `HTTP/1.1 ${status} ${statusText}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
    '',
    body,
  ].join('\r\n'))
}

export function createGatewayServer(config: ServerConfig, service: PapyrusService, auth: AuthService): ReturnType<typeof createHttpServer> {
  const gatewayConfig = config.gateway
  if (!gatewayConfig) throw new Error('Gateway is not enabled (set PAPYRUS_GATEWAY_ENABLED=true)')

  const authenticateRequest = (request: IncomingMessage): Principal | undefined => {
    return authenticate(config, service, auth, request)
  }

  const resolveForRequest = (request: IncomingMessage, principal: Principal): Workspace | undefined => {
    return resolveRequestWorkspace(service, config, request, principal)
  }

  const agentContext = new AsyncLocalStorage<AcpAgentContext>()
  const acpServer = new AcpServer({
    createAgent: () => {
      const context = agentContext.getStore()
      if (!context) throw new Error('ACP initialization requires authenticated request context')
      return buildAcpAgent(service, context)
    },
  })
  const httpHandler = createNodeHttpHandler(acpServer)
  const wss = new WebSocketServer({ noServer: true })

  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)

    if (url.pathname === '/health' || url.pathname === '/status') {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('ok')
      return
    }

    if (url.pathname !== '/acp') {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('Not Found')
      return
    }

    const principal = authenticateRequest(request)
    if (!principal) {
      response.writeHead(401, { 'content-type': 'text/plain' })
      response.end('Unauthorized')
      return
    }
    const workspace = resolveForRequest(request, principal)
    if (!workspace) {
      response.writeHead(400, { 'content-type': 'text/plain' })
      response.end('Workspace is ambiguous; set the X-Papyrus-Workspace-Id header')
      return
    }

    agentContext.run({ principal, workspace }, () => {
      httpHandler(request, response)
    })
  }

  let server: ReturnType<typeof createHttpServer>
  if (gatewayConfig.tls) {
    server = createHttpsServer({
      cert: readFileSync(gatewayConfig.tls.certPath), key: readFileSync(gatewayConfig.tls.keyPath), ca: readFileSync(gatewayConfig.tls.caPath),
      requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.2',
    }, handler)
  } else if (gatewayConfig.host !== '127.0.0.1' && gatewayConfig.host !== '::1') {
    throw new Error('Gateway requires mTLS when listening on a non-loopback address')
  } else {
    server = createHttpServer(handler)
  }

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    if (url.pathname !== '/acp') {
      rejectUpgrade(socket, 404, 'Not Found', 'Not Found')
      return
    }

    const principal = authenticateRequest(request)
    if (!principal) {
      rejectUpgrade(socket, 401, 'Unauthorized', 'Unauthorized')
      return
    }
    const workspace = resolveForRequest(request, principal)
    if (!workspace) {
      rejectUpgrade(socket, 400, 'Bad Request', 'Workspace is ambiguous; set the X-Papyrus-Workspace-Id header')
      return
    }

    const prepared = acpServer.prepareWebSocketUpgrade({
      agent: buildAcpAgent(service, { principal, workspace }),
    })
    let accepted = false
    const cleanup = (): void => {
      wss.off('headers', onHeaders)
      socket.off('close', onUpgradeFailed)
      socket.off('error', onUpgradeFailed)
    }
    const onHeaders = (headers: string[], candidate: IncomingMessage): void => {
      if (candidate === request) headers.push(`Acp-Connection-Id: ${prepared.connectionId}`)
    }
    const onUpgradeFailed = (): void => {
      if (accepted) return
      cleanup()
      prepared.reject()
    }

    wss.on('headers', onHeaders)
    socket.once('close', onUpgradeFailed)
    socket.once('error', onUpgradeFailed)
    try {
      wss.handleUpgrade(request, socket, head, (webSocket) => {
        accepted = true
        cleanup()
        try {
          prepared.accept(webSocket)
        } catch (error) {
          webSocket.close(1011, error instanceof Error ? error.message.slice(0, 123) : 'ACP initialization failed')
        }
      })
    } catch (error) {
      cleanup()
      prepared.reject()
      socket.destroy(error instanceof Error ? error : undefined)
    }
  })
  server.on('close', () => {
    void acpServer.close()
  })

  return server
}
