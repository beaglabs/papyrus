import { createHash, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { TLSSocket } from 'node:tls'
import type { Principal, Workspace } from '@papyrus/contracts'
import { AcpServer } from '@agentclientprotocol/sdk/experimental/server'
import { createNodeHttpHandler } from '@agentclientprotocol/sdk/experimental/node'
import { WebSocketServer } from 'ws'
import { AuthService } from './auth.js'
import type { ServerConfig } from './config.js'
import { buildAcpAgent, type AcpAgentContext } from './acp-server.js'
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

export function createGatewayServer(config: ServerConfig, service: PapyrusService, auth: AuthService): ReturnType<typeof createHttpServer> {
  const gatewayConfig = config.gateway
  if (!gatewayConfig) throw new Error('Gateway is not enabled (set PAPYRUS_GATEWAY_ENABLED=true)')

  const authenticateRequest = (request: IncomingMessage): Principal | undefined => {
    return authenticate(config, service, auth, request)
  }

  const resolveForRequest = (request: IncomingMessage, principal: Principal): Workspace | undefined => {
    return resolveRequestWorkspace(service, config, request, principal)
  }

  const wss = new WebSocketServer({ noServer: true })

  // Track pending WS upgrades: request → { connectionId, agentApp }
  const pendingWsUpgrades = new Map<IncomingMessage, { connectionId: string; agentApp: ReturnType<typeof buildAcpAgent> }>()

  // Inject Acp-Connection-Id into 101 upgrade response
  wss.on('headers', (headers: string[], request: IncomingMessage) => {
    const pending = pendingWsUpgrades.get(request)
    if (pending) {
      headers.push(`Acp-Connection-Id: ${pending.connectionId}`)
      console.log(`[gateway] Adding Acp-Connection-Id: ${pending.connectionId} to upgrade response`)
    }
  })

  // One AcpServer with a dummy agent — real agents passed per-connection via prepareWebSocketUpgrade/handleRequest
  const acpServer = new AcpServer({ agent: { connect: () => { throw new Error('Use per-request agent override') } } })
  const httpHandler = createNodeHttpHandler(acpServer)

  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)

    if (request.url === '/health' || request.url === '/status') {
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

    const context: AcpAgentContext = { principal, workspace }
    const agentApp = buildAcpAgent(service, context)

    // WebSocket upgrade
    if (request.headers.upgrade?.toLowerCase() === 'websocket') {
      console.log(`[gateway] WebSocket upgrade request`)
      const prepared = acpServer.prepareWebSocketUpgrade({ agent: agentApp })
      pendingWsUpgrades.set(request, { connectionId: prepared.connectionId, agentApp })

      wss.handleUpgrade(request, request.socket, Buffer.alloc(0), (ws) => {
        pendingWsUpgrades.delete(request)
        try {
          ws.on('message', (data) => console.log(`[gateway] WS msg: ${String(data).slice(0, 300)}`))
          ws.on('error', (err) => console.error(`[gateway] WS error:`, err.message))
          ws.on('close', (code, reason) => console.log(`[gateway] WS close: ${code} ${reason}`))
          prepared.accept(ws)
          console.log(`[gateway] WebSocket accepted, connectionId=${prepared.connectionId}`)
        } catch (err) {
          console.error(`[gateway] WebSocket accept error:`, err)
          ws.close(1011, 'Internal error')
        }
      })
      return
    }

    // Streamable HTTP
    console.log(`[gateway] HTTP ${request.method ?? 'GET'} /acp`)
    httpHandler(request, response)
  }

  let server: ReturnType<typeof createHttpServer>
  if (gatewayConfig.tls) {
    server = createHttpsServer({
      cert: readFileSync(gatewayConfig.tls.certPath), key: readFileSync(gatewayConfig.tls.keyPath), ca: readFileSync(gatewayConfig.tls.caPath),
      requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.2',
    }, handler as (req: IncomingMessage, res: ServerResponse) => void)
  } else if (gatewayConfig.host !== '127.0.0.1' && gatewayConfig.host !== '::1') {
    throw new Error('Gateway requires mTLS when listening on a non-loopback address')
  } else {
    server = createHttpServer(handler as (req: IncomingMessage, res: ServerResponse) => void)
  }

  return server
}
