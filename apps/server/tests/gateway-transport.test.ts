import { randomBytes } from 'node:crypto'
import { connect } from 'node:net'
import type { AddressInfo } from 'node:net'
import * as acp from '@agentclientprotocol/sdk'
import { createHttpStream } from '@agentclientprotocol/sdk/experimental/http-client'
import { afterEach, describe, expect, it } from 'vitest'
import { createGatewayServer } from '../src/gateway.js'
import { testContext } from './helpers.js'

function maskedTextFrame(text: string): Buffer {
  const payload = Buffer.from(text)
  const mask = randomBytes(4)
  const encoded = Buffer.alloc(payload.length)
  for (let index = 0; index < payload.length; index += 1) {
    encoded[index] = payload[index] ^ mask[index % 4]
  }
  const length = payload.length < 126
    ? Buffer.from([0x80 | payload.length])
    : Buffer.from([0x80 | 126, payload.length >> 8, payload.length & 0xff])
  return Buffer.concat([Buffer.from([0x81]), length, mask, encoded])
}

async function coalescedInitialize(port: number): Promise<string> {
  const initialize = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: 'coalesced-client', version: '1.0.0' },
    },
  })
  const key = randomBytes(16).toString('base64')
  const request = Buffer.from([
    'GET /acp HTTP/1.1',
    `Host: 127.0.0.1:${port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    '',
    '',
  ].join('\r\n'))

  return await new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    const chunks: Buffer[] = []
    const timer = setTimeout(() => finish(), 1_000)
    const finish = (): void => {
      clearTimeout(timer)
      socket.destroy()
      resolve(Buffer.concat(chunks).toString('utf8'))
    }
    socket.on('connect', () => socket.write(Buffer.concat([request, maskedTextFrame(initialize)])))
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      if (Buffer.concat(chunks).includes(Buffer.from('protocolVersion'))) finish()
    })
    socket.on('error', reject)
  })
}

describe('ACP gateway transports', () => {
  const cleanups: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()?.()
  })

  async function startGateway() {
    const context = testContext()
    context.config.devIdentity = 'gateway:developer'
    context.config.gateway = { host: '127.0.0.1', port: 3220 }
    const server = createGatewayServer(context.config, context.service, context.auth)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      context.dispose()
    })
    return { context, port: (server.address() as AddressInfo).port }
  }

  it('preserves an initialize frame coalesced with the WebSocket upgrade', async () => {
    const { port } = await startGateway()
    const response = await coalescedInitialize(port)

    expect(response).toContain('101 Switching Protocols')
    expect(response).toMatch(/Acp-Connection-Id:/i)
    expect(response).toContain('protocolVersion')
  })

  it('keeps authenticated context through Streamable HTTP initialization', async () => {
    const { context, port } = await startGateway()
    const stream = createHttpStream(`http://127.0.0.1:${port}/acp`)
    const sessionId = await acp.client({ name: 'http-context-client' }).connectWith(stream, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      })
      const session = await connection.request(acp.methods.agent.session.new, { cwd: '/tmp', mcpServers: [] })
      return session.sessionId
    })

    const session = context.db.listSessions().find((candidate) => candidate.id === sessionId)
    expect(session?.workspaceId).toBeTruthy()
    expect(session?.ownerId).toBeTruthy()
  })
})
