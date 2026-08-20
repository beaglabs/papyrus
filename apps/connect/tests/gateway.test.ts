import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import { createHttpStream } from '@agentclientprotocol/sdk/experimental/http-client'
import { describe, expect, it } from 'vitest'
import { createGatewayServer } from '../../server/src/gateway.js'
import { testContext } from '../../server/tests/helpers.js'
import { bridgeAcp } from '../src/bridge.js'

describe('papyrus-connect gateway integration', () => {
  it('bridges a spawn-only stdio client through the governed /acp endpoint', async () => {
    const context = testContext()
    const owner = context.db.upsertUser({ externalId: 'oidc:owner', displayName: 'Owner', authMethod: 'oidc' })
    context.db.setRole(owner.id, 'Owner')
    const activeOwner = context.db.getPrincipal(owner.id)!
    const workspace = context.service.createWorkspace(activeOwner, { name: 'Connector', description: '' })
    context.config.gateway = { host: '127.0.0.1', port: 3220 }
    const server = createGatewayServer(context.config, context.service, context.auth)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const port = (server.address() as AddressInfo).port
    const stream = createHttpStream(`http://127.0.0.1:${port}/acp`, {
      headers: {
        authorization: `Bearer ${context.auth.issueSession(activeOwner.id)}`,
        'x-papyrus-workspace-id': workspace.id,
      },
    })
    const frames = [
      {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: 'spawn-only', version: '1.0.0' } },
      },
      { jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/tmp/connector', mcpServers: [] } },
    ]
    let output = ''
    const sink = new Writable({ write: (chunk, _encoding, done) => { output += chunk.toString(); done() } })

    try {
      await bridgeAcp(stream, Readable.from(frames.map((frame) => `${JSON.stringify(frame)}\n`)), sink)
      const responses = output.trim().split('\n').map((line) => JSON.parse(line) as { id: number; result?: { sessionId?: string } })
      expect(responses.map((response) => response.id)).toEqual([1, 2])
      expect(responses[1]?.result?.sessionId).toBeTruthy()
      expect(context.db.listSessions()).toContainEqual(expect.objectContaining({
        id: responses[1]?.result?.sessionId,
        ownerId: activeOwner.id,
        workspaceId: workspace.id,
        agent: 'goose',
      }))
    } finally {
      server.closeAllConnections()
      server.close()
      await once(server, 'close')
      context.dispose()
    }
  })
})
