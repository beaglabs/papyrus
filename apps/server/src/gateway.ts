import { spawn } from 'node:child_process'
import { createHash, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { Readable, Writable } from 'node:stream'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { TLSSocket } from 'node:tls'
import * as acp from '@agentclientprotocol/sdk'
import { createHttpStream } from '@agentclientprotocol/sdk/experimental/http-client'
import { AcpServer } from '@agentclientprotocol/sdk/experimental/server'
import { createNodeHttpHandler } from '@agentclientprotocol/sdk/experimental/node'
import { RUNTIME_CONFIG_HEADER, encodeRuntimeConfig } from '@papyrus/goose-runtime'
import type { Principal, Runtime, Session, Workspace } from '@papyrus/contracts'
import { AuthService } from './auth.js'
import type { ServerConfig } from './config.js'
import { PapyrusService } from './service.js'

function isRequest(message: acp.AnyMessage): message is acp.AnyRequest {
  return 'method' in message && 'id' in message
}

function isResponse(message: acp.AnyMessage): message is acp.AnyResponse {
  return 'id' in message && !('method' in message)
}

interface GatewayConnectionContext {
  principal: Principal
  workspace: Workspace
  runtime: Runtime
}

/** Transparent ACP relay with policy interception between a client and goose. */
export class GatewayRelay {
  private readonly pendingNewSession = new Map<string, Session>()
  private readonly gooseToSession = new Map<string, Session>()

  constructor(
    private readonly service: PapyrusService,
    private readonly context: GatewayConnectionContext,
    private readonly client: acp.Stream,
    private readonly goose: acp.Stream,
  ) {}

  async run(): Promise<void> {
    const clientReader = this.client.readable.getReader()
    const gooseReader = this.goose.readable.getReader()
    const clientWriter = this.client.writable.getWriter()
    const gooseWriter = this.goose.writable.getWriter()

    try {
      await Promise.allSettled([this.pumpClientToGoose(clientReader, gooseWriter, clientWriter), this.pumpGooseToClient(gooseReader, clientWriter, gooseWriter)])
    } finally {
      clientReader.releaseLock()
      gooseReader.releaseLock()
      await Promise.allSettled([clientWriter.close(), gooseWriter.close()]).catch(() => {})
      clientWriter.releaseLock()
      gooseWriter.releaseLock()
    }
  }

  private async pumpClientToGoose(reader: ReadableStreamDefaultReader<acp.AnyMessage>, gooseWriter: WritableStreamDefaultWriter<acp.AnyMessage>, clientWriter: WritableStreamDefaultWriter<acp.AnyMessage>): Promise<void> {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        if (isRequest(value)) {
          if (value.method === 'session/new') {
            const session = this.service.createSession(this.context.principal, this.context.workspace.id, this.context.runtime.id, 'gateway session')
            this.pendingNewSession.set(String(value.id), session)
            const params = value.params as { mcpServers?: unknown }
            params.mcpServers = this.service.runtimeMcpServers(session).map((server) => ({ type: 'http', name: server.name, url: server.url, headers: server.headers }))
          } else if (value.method === 'session/prompt') {
            const params = value.params as { sessionId?: string }
            const session = params.sessionId ? this.gooseToSession.get(params.sessionId) : undefined
            if (!session) {
              await clientWriter.write(errorResponse(value, -32001, 'Unknown session'))
              continue
            }
            try {
              this.service.authorizeSessionPrompt(this.context.principal, session)
            } catch {
              await clientWriter.write(errorResponse(value, -32002, 'Not authorized to prompt this session'))
              continue
            }
          }
        }
        await gooseWriter.write(value)
      }
    } finally {
      reader.releaseLock()
    }
  }

  private async pumpGooseToClient(reader: ReadableStreamDefaultReader<acp.AnyMessage>, clientWriter: WritableStreamDefaultWriter<acp.AnyMessage>, gooseWriter: WritableStreamDefaultWriter<acp.AnyMessage>): Promise<void> {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        if (isRequest(value) && value.method === 'session/request_permission') {
          const params = value.params as { sessionId?: string; toolCall?: { title?: string }; options?: Array<{ kind: string; optionId: string }> }
          const session = params.sessionId ? this.gooseToSession.get(params.sessionId) : undefined
          await gooseWriter.write(permissionResponse(value, session ? this.service.isToolCallAllowed(this.context.principal, session, params.toolCall?.title ?? '') : false, params.options ?? []))
          continue
        }
        if (isResponse(value)) {
          const session = this.pendingNewSession.get(String(value.id))
          if (session) {
            const result = (value as { result?: { sessionId?: string } }).result
            if (result?.sessionId) this.gooseToSession.set(result.sessionId, session)
            this.pendingNewSession.delete(String(value.id))
          }
        }
        await clientWriter.write(value)
      }
    } finally {
      reader.releaseLock()
    }
  }
}

function errorResponse(request: acp.AnyRequest, code: number, message: string): acp.AnyResponse {
  return { jsonrpc: '2.0', id: request.id, error: { code, message } }
}

function permissionResponse(request: acp.AnyRequest, allowed: boolean, options: Array<{ kind: string; optionId: string }>): acp.AnyResponse {
  const desired = allowed ? 'allow_once' : 'reject_once'
  const option = options.find((candidate) => candidate.kind === desired)
  return option
    ? { jsonrpc: '2.0', id: request.id, result: { outcome: { outcome: 'selected', optionId: option.optionId } } }
    : { jsonrpc: '2.0', id: request.id, result: { outcome: { outcome: 'cancelled' } } }
}

class GatewayConnector {
  constructor(private readonly service: PapyrusService, private readonly context: GatewayConnectionContext) {}

  connect(stream: acp.Stream, _options?: unknown): { closed: Promise<void> } {
    const runtime = this.context.runtime
    if (runtime.mode === 'remote' && runtime.endpoint) return { closed: this.connectRemote(stream, runtime) }
    return { closed: this.connectChild(stream, runtime) }
  }

  private connectChild(stream: acp.Stream, runtime: Runtime): Promise<void> {
    const { command, args } = this.service.runtimeCommand(runtime)
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.service.modelEnvironment(runtime) },
    })
    const goose = acp.ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>)
    child.stderr.on('data', (chunk) => process.stderr.write(`[gateway goose] ${String(chunk).slice(0, 4_096)}\n`))
    return this.bootstrap(stream, goose, () => { try { child.kill('SIGKILL') } catch { /* already gone */ } })
  }

  private connectRemote(stream: acp.Stream, runtime: Runtime): Promise<void> {
    const headers = { ...this.service.runtimeHeaders() }
    const config = encodeRuntimeConfig(this.service.modelEnvironment(runtime))
    if (config) headers[RUNTIME_CONFIG_HEADER] = config
    const fetch = this.service.runtimeFetch()
    const goose = createHttpStream(runtime.endpoint as string, {
      headers,
      ...(fetch ? { fetch } : {}),
    })
    return this.bootstrap(stream, goose, () => {})
  }

  private async bootstrap(client: acp.Stream, goose: acp.Stream, dispose: () => void): Promise<void> {
    try {
      const clientReader = client.readable.getReader()
      const first = await clientReader.read()
      clientReader.releaseLock()
      if (!first.value || !isRequest(first.value) || first.value.method !== 'initialize') {
        throw new Error('Expected an ACP initialize request')
      }
      const capabilities = await this.initializeGoose(goose)
      const writer = client.writable.getWriter()
      await writer.write({
        jsonrpc: '2.0', id: first.value.id,
        result: { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: capabilities, authMethods: [], agentInfo: { name: 'papyrus', version: '0.1.0' } },
      })
      writer.releaseLock()
      await new GatewayRelay(this.service, this.context, client, goose).run()
    } catch (error) {
      console.error('[gateway]', error)
    } finally {
      dispose()
    }
  }

  private async initializeGoose(goose: acp.Stream): Promise<unknown> {
    const reader = goose.readable.getReader()
    const writer = goose.writable.getWriter()
    try {
      await writer.write({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'initialize', params: { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} } })
      const { value } = await reader.read()
      if (!value || !isResponse(value)) throw new Error('goose initialize failed')
      const result = (value as { result?: { agentCapabilities?: unknown } }).result
      return result?.agentCapabilities ?? {}
    } finally {
      reader.releaseLock()
      writer.releaseLock()
    }
  }
}

function devPrincipal(config: ServerConfig, request: IncomingMessage, service: PapyrusService): Principal | undefined {
  if (config.gateway?.devToken) {
    const authorization = request.headers.authorization
    const presented = authorization?.startsWith('Bearer ') ? authorization.slice(7) : ''
    const expected = config.gateway.devToken
    const a = createHash('sha256').update(presented).digest()
    const b = createHash('sha256').update(expected).digest()
    if (!timingSafeEqual(a, b)) return undefined
    return service.db.upsertUser({ externalId: 'dev:gateway:token', displayName: 'Gateway Developer', authMethod: 'development' })
  }
  if (config.devIdentity) {
    const parts = config.devIdentity.split(':')
    return service.db.upsertUser({ externalId: `dev:${parts[0]}`, displayName: parts[1] ?? parts[0] ?? 'Developer', authMethod: 'development' })
  }
  return undefined
}

export function createGatewayServer(config: ServerConfig, service: PapyrusService, auth: AuthService) {
  const gatewayConfig = config.gateway
  if (!gatewayConfig) throw new Error('Gateway is not enabled (set PAPYRUS_GATEWAY_ENABLED=true)')

  const als = new AsyncLocalStorage<GatewayConnectionContext>()

  const acpServer = new AcpServer({
    createAgent: () => {
      const context = als.getStore()
      if (!context) throw new Error('Gateway connection context missing')
      return new GatewayConnector(service, context)
    },
  })

  const handle = createNodeHttpHandler(acpServer)

  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    const runtimeMatch = /^\/acp\/([^/]+)/.exec(request.url ?? '')
    const runtimeId = runtimeMatch ? decodeURIComponent(runtimeMatch[1] as string) : undefined
    const principal = authenticate(config, service, auth, request)
    if (!principal) {
      response.writeHead(401, { 'content-type': 'text/plain' })
      response.end('Unauthorized')
      return
    }
    const runtime = runtimeId ? service.db.getRuntime(runtimeId) : undefined
    if (!runtime) {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('Unknown runtime')
      return
    }
    const workspace = resolveWorkspace(service, principal, request.headers['x-papyrus-workspace-id'])
    if (!workspace) {
      response.writeHead(400, { 'content-type': 'text/plain' })
      response.end('Workspace is ambiguous; set the X-Papyrus-Workspace-Id header')
      return
    }
    als.run({ principal, workspace, runtime }, () => handle(request, response))
  }

  if (gatewayConfig.tls) {
    return createHttpsServer({
      cert: readFileSync(gatewayConfig.tls.certPath), key: readFileSync(gatewayConfig.tls.keyPath), ca: readFileSync(gatewayConfig.tls.caPath),
      requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.2',
    }, handler)
  }
  if (gatewayConfig.host !== '127.0.0.1' && gatewayConfig.host !== '::1') {
    throw new Error('Gateway requires mTLS when listening on a non-loopback address')
  }
  return createHttpServer(handler)
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
