import * as acp from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'
import { buildAcpAgent, type AcpAgentContext } from '../src/acp-server.js'
import { testContext } from './helpers.js'

function setup(runtimeFactory?: Parameters<typeof testContext>[0]) {
  const context = testContext(runtimeFactory)
  const owner = context.db.upsertUser({ externalId: 'dev:owner', displayName: 'Owner', authMethod: 'development' })
  context.db.setRole(owner.id, 'Owner')
  const activeOwner = context.db.getPrincipal(owner.id)!
  const user = context.db.upsertUser({ externalId: 'dev:user', displayName: 'User', authMethod: 'development' })
  context.db.setRole(user.id, 'User')
  const activeUser = context.db.getPrincipal(user.id)!
  const environment = context.service.createEnvironment(activeOwner, { name: 'Mission', description: '' })
  context.service.assign(activeOwner, activeUser.id, environment.id)
  return { context, user: activeUser, environment }
}

function connect(ctx: ReturnType<typeof setup>, updates: acp.SessionUpdate[] = []) {
  const agentContext: AcpAgentContext = { principal: ctx.user, environment: ctx.environment }
  const agentApp = buildAcpAgent(ctx.context.service, agentContext)
  const clientApp = acp.client({ name: 'test-client' })
    .onNotification(acp.methods.client.session.update, ({ params }) => { updates.push(params.update) })
  return clientApp.connect(agentApp)
}

describe('ACP server agent', () => {
  it('advertises the durable governed lifecycle without client provider injection', async () => {
    const ctx = setup()
    try {
      const connection = connect(ctx)
      const result = await connection.agent.request('initialize', {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientInfo: { name: 'test-client', version: '1.0.0' },
      })

      expect(result.protocolVersion).toBe(acp.PROTOCOL_VERSION)
      expect(result.agentCapabilities?.loadSession).toBe(true)
      expect(result.agentCapabilities?.sessionCapabilities?.list).toEqual({})
      expect(result.agentCapabilities?.sessionCapabilities?.resume).toEqual({})
      expect(result.agentCapabilities?.sessionCapabilities?.close).toEqual({})
      expect(result.agentCapabilities?.providers).toBeUndefined()
    } finally { ctx.context.dispose() }
  })

  it('persists session cwd, ownership, and list metadata', async () => {
    const ctx = setup()
    try {
      const connection = connect(ctx)
      await connection.agent.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION })
      const created = await connection.agent.request('session/new', { cwd: '/tmp/mission', mcpServers: [] })
      const listed = await connection.agent.request('session/list', { cwd: '/tmp/mission' })

      expect(listed.sessions).toHaveLength(1)
      expect(listed.sessions[0]).toMatchObject({
        sessionId: created.sessionId,
        cwd: '/tmp/mission',
        title: 'mission',
      })
      expect(ctx.context.db.getSession(created.sessionId)?.ownerId).toBe(ctx.user.id)
      expect(ctx.context.db.getSession(created.sessionId)?.agent).toBe('papyrus')
    } finally { ctx.context.dispose() }
  })

  it('routes prompts through the governor and persists streamed updates', async () => {
    const runtimeFactory = vi.fn(() => ({
      runPrompt: async (request: { onEvent: (event: unknown) => Promise<void> }) => {
        await request.onEvent({
          kind: 'update',
          at: new Date().toISOString(),
          data: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'governed response' },
            messageId: 'agent_1',
          },
        })
        return { runtimeSessionId: 'runtime-1', stopReason: 'end_turn' }
      },
    }))
    const ctx = setup(runtimeFactory as Parameters<typeof testContext>[0])
    const updates: acp.SessionUpdate[] = []
    try {
      const connection = connect(ctx, updates)
      await connection.agent.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION })
      const session = await connection.agent.request('session/new', { cwd: '/tmp', mcpServers: [] })
      const result = await connection.agent.request('session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'hello' }],
      })

      expect(result.stopReason).toBe('end_turn')
      expect(updates).toContainEqual(expect.objectContaining({ sessionUpdate: 'agent_message_chunk' }))
      expect(ctx.context.db.listSessionRuns(session.sessionId)[0]?.status).toBe('completed')
      expect(ctx.context.db.listSessionEvents(session.sessionId).map((event) => event.kind)).toEqual(['update', 'update'])
      expect(runtimeFactory).toHaveBeenCalledTimes(1)
    } finally { ctx.context.dispose() }
  })

  it('closes and resumes a persisted session through ACP', async () => {
    const ctx = setup()
    try {
      const connection = connect(ctx)
      await connection.agent.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION })
      const session = await connection.agent.request('session/new', { cwd: '/tmp', mcpServers: [] })

      await connection.agent.request('session/close', { sessionId: session.sessionId })
      expect(ctx.context.db.getSession(session.sessionId)?.status).toBe('stopped')

      await connection.agent.request('session/resume', { sessionId: session.sessionId, cwd: '/tmp', mcpServers: [] })
      expect(ctx.context.db.getSession(session.sessionId)?.status).toBe('ready')
    } finally { ctx.context.dispose() }
  })
})
