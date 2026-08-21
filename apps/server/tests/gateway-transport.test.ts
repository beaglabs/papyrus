import { once } from 'node:events'
import { connect } from 'node:net'
import type { AddressInfo } from 'node:net'
import * as acp from '@agentclientprotocol/sdk'
import { createHttpStream } from '@agentclientprotocol/sdk/experimental/http-client'
import type { AgentRuntime, RuntimeLaunchOptions } from '@papyrus/acp-runtime'
import { afterEach, describe, expect, it } from 'vitest'
import { createGatewayServer } from '../src/gateway.js'
import { testContext } from './helpers.js'

const initializeBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {},
    clientInfo: { name: 'transport-test', version: '1.0.0' },
  },
})

describe('ACP Streamable HTTP gateway', () => {
  const cleanups: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()?.()
  })

  async function startGateway(
    gateway: Partial<NonNullable<ReturnType<typeof testContext>['config']['gateway']>> = {},
    runtimeFactory?: (options: RuntimeLaunchOptions) => AgentRuntime,
  ) {
    const context = testContext(runtimeFactory)
    const owner = context.db.upsertUser({ externalId: 'oidc:owner', displayName: 'Owner', authMethod: 'oidc' })
    context.db.setRole(owner.id, 'Owner')
    const activeOwner = context.db.getPrincipal(owner.id)!
    const first = context.db.upsertUser({ externalId: 'oidc:first', displayName: 'First', authMethod: 'oidc' })
    context.db.setRole(first.id, 'User')
    const activeFirst = context.db.getPrincipal(first.id)!
    const second = context.db.upsertUser({ externalId: 'oidc:second', displayName: 'Second', authMethod: 'oidc' })
    context.db.setRole(second.id, 'User')
    const activeSecond = context.db.getPrincipal(second.id)!
    const firstEnvironment = context.service.createEnvironment(activeOwner, { name: 'First environment', description: '' })
    const secondEnvironment = context.service.createEnvironment(activeOwner, { name: 'Second environment', description: '' })
    context.service.assign(activeOwner, activeFirst.id, firstEnvironment.id)
    context.service.assign(activeOwner, activeFirst.id, secondEnvironment.id)
    context.service.assign(activeOwner, activeSecond.id, secondEnvironment.id)
    context.config.gateway = { host: '127.0.0.1', port: 3220, ...gateway }
    const server = createGatewayServer(context.config, context.service, context.auth)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      context.dispose()
    })
    return {
      context,
      port: (server.address() as AddressInfo).port,
      first: activeFirst,
      second: activeSecond,
      firstEnvironment,
      secondEnvironment,
      firstToken: context.auth.issueSession(activeFirst.id),
      secondToken: context.auth.issueSession(activeSecond.id),
    }
  }

  function headers(token: string, environmentId: string): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-papyrus-environment-id': environmentId,
    }
  }

  async function initialize(port: number, token: string, environmentId: string): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/acp`, {
      method: 'POST',
      headers: headers(token, environmentId),
      body: initializeBody,
    })
  }

  it('keeps authenticated principal and environment context through Streamable HTTP', async () => {
    const { context, port, first, firstToken, firstEnvironment } = await startGateway()
    const stream = createHttpStream(`http://127.0.0.1:${port}/acp`, {
      headers: headers(firstToken, firstEnvironment.id),
    })
    const sessionId = await acp.client({ name: 'http-context-client' }).connectWith(stream, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      })
      const session = await connection.request(acp.methods.agent.session.new, { cwd: '/tmp', mcpServers: [] })
      return session.sessionId
    })

    expect(context.db.getSession(sessionId)).toMatchObject({
      ownerId: first.id,
      environmentId: firstEnvironment.id,
    })
  })

  it('binds connection IDs to the authenticated principal and environment', async () => {
    const { context, port, first, firstToken, secondToken, firstEnvironment, secondEnvironment } = await startGateway()
    const initialized = await initialize(port, firstToken, firstEnvironment.id)
    expect(initialized.status).toBe(200)
    const connectionId = initialized.headers.get('acp-connection-id')
    expect(connectionId).toMatch(/^[0-9a-f-]{36}$/)

    const hijack = await fetch(`http://127.0.0.1:${port}/acp`, {
      headers: { ...headers(secondToken, secondEnvironment.id), 'acp-connection-id': connectionId! },
    })
    expect(hijack.status).toBe(404)
    expect(await hijack.json()).toMatchObject({ code: 'CONNECTION_NOT_FOUND' })

    const environmentSwap = await fetch(`http://127.0.0.1:${port}/acp`, {
      headers: { ...headers(firstToken, secondEnvironment.id), 'acp-connection-id': connectionId! },
    })
    expect(environmentSwap.status).toBe(403)
    expect(await environmentSwap.json()).toMatchObject({ code: 'ENVIRONMENT_MISMATCH' })

    context.auth.revokeSessions(first.id)
    const revoked = await fetch(`http://127.0.0.1:${port}/acp`, {
      headers: { ...headers(firstToken, firstEnvironment.id), 'acp-connection-id': connectionId! },
    })
    expect(revoked.status).toBe(401)
  })

  it('enforces request-body and logical connection limits', async () => {
    const limitedBody = await startGateway({ maxRequestBodyBytes: 64 })
    const oversized = await fetch(`http://127.0.0.1:${limitedBody.port}/acp`, {
      method: 'POST',
      headers: headers(limitedBody.firstToken, limitedBody.firstEnvironment.id),
      body: 'x'.repeat(65),
    })
    expect(oversized.status).toBe(413)

    const limitedConnections = await startGateway({ maxConnections: 1 })
    const first = await initialize(limitedConnections.port, limitedConnections.firstToken, limitedConnections.firstEnvironment.id)
    const connectionId = first.headers.get('acp-connection-id')
    expect(first.status).toBe(200)
    expect(connectionId).toBeTruthy()

    const rejected = await initialize(limitedConnections.port, limitedConnections.firstToken, limitedConnections.firstEnvironment.id)
    expect(rejected.status).toBe(429)
    expect(await rejected.json()).toMatchObject({ code: 'CONNECTION_LIMIT_REACHED' })

    const closed = await fetch(`http://127.0.0.1:${limitedConnections.port}/acp`, {
      method: 'DELETE',
      headers: { ...headers(limitedConnections.firstToken, limitedConnections.firstEnvironment.id), 'acp-connection-id': connectionId! },
    })
    expect(closed.status).toBe(202)
    expect((await initialize(limitedConnections.port, limitedConnections.firstToken, limitedConnections.firstEnvironment.id)).status).toBe(200)
  })

  it('propagates ACP cancellation to the governed runtime over HTTP', async () => {
    let started!: () => void
    const didStart = new Promise<void>((resolve) => { started = resolve })
    const runtimeFactory = (): AgentRuntime => ({
      kind: 'test',
      capabilities: { transports: ['stdio'], sessions: { cancel: true, load: false, resume: false, fork: false } },
      health: async () => ({ available: true }),
      runPrompt: async (request) => {
        started()
        await new Promise<void>((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => reject(request.signal?.reason), { once: true })
        })
        return { runtimeSessionId: 'never', stopReason: 'end_turn' }
      },
    })
    const { context, port, firstToken, firstEnvironment } = await startGateway({}, runtimeFactory)
    const stream = createHttpStream(`http://127.0.0.1:${port}/acp`, {
      headers: headers(firstToken, firstEnvironment.id),
    })

    const result = await acp.client({ name: 'cancel-client' }).connectWith(stream, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      })
      const session = await connection.buildSession({ cwd: '/tmp', mcpServers: [] }).start()
      try {
        const prompt = session.prompt('long-running work')
        await didStart
        await connection.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId })
        return await prompt
      } finally {
        session.dispose()
      }
    })

    expect(result.stopReason).toBe('cancelled')
    expect(context.db.listSessionRuns(context.db.listSessions()[0]!.id)[0]?.status).toBe('cancelled')
  })

  it('rejects WebSocket upgrades and advertises Streamable HTTP status', async () => {
    const { port } = await startGateway()
    const status = await fetch(`http://127.0.0.1:${port}/status`)
    expect(await status.json()).toEqual({ status: 'ok', transport: 'streamable-http', endpoint: '/acp' })

    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1')
      const chunks: Buffer[] = []
      socket.on('connect', () => socket.write([
        'GET /acp HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n')))
      socket.on('data', (chunk: Buffer) => chunks.push(chunk))
      socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      socket.on('error', reject)
    })
    expect(response).toContain('400 Bad Request')
    expect(response).toContain('STREAMABLE_HTTP_REQUIRED')
  })
})
