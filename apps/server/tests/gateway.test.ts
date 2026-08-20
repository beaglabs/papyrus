import { describe, expect, it } from 'vitest'
import * as acp from '@agentclientprotocol/sdk'
import { buildAcpAgent, type AcpAgentContext } from '../src/acp-server.js'
import { testContext } from './helpers.js'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function setup() {
  const context = testContext()
  const owner = context.db.upsertUser({ externalId: 'dev:owner', displayName: 'Owner', authMethod: 'development' })
  context.db.setRole(owner.id, 'Owner')
  const activeOwner = context.db.getPrincipal(owner.id)!
  const user = context.db.upsertUser({ externalId: 'dev:user', displayName: 'User', authMethod: 'development' })
  context.db.setRole(user.id, 'User')
  const activeUser = context.db.getPrincipal(user.id)!
  const workspace = context.service.createWorkspace(activeOwner, { name: 'Mission', description: '' })
  context.service.assign(activeOwner, activeUser.id, workspace.id)
  return { context, user: activeUser, workspace }
}

describe('ACP server agent', () => {
  it('handles initialize with correct capabilities', async () => {
    const ctx = setup()
    try {
      const agentContext: AcpAgentContext = { principal: ctx.user, workspace: ctx.workspace }
      const agentApp = buildAcpAgent(ctx.context.service, agentContext)
      const clientApp = acp.client({ name: 'test-client' })
      const connection = clientApp.connect(agentApp)

      const result = await connection.agent.request('initialize', {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientInfo: { name: 'test-client', version: '1.0.0' },
      })

      expect(result.protocolVersion).toBe(acp.PROTOCOL_VERSION)
      expect(result.agentCapabilities?.providers).toBeDefined()
      expect(result.agentCapabilities?.session?.new).toBe(true)
      expect(result.agentCapabilities?.session?.prompt).toBe(true)
    } finally { ctx.context.dispose() }
  })

  it('handles providers/set and providers/list', async () => {
    const ctx = setup()
    try {
      const agentContext: AcpAgentContext = { principal: ctx.user, workspace: ctx.workspace }
      const agentApp = buildAcpAgent(ctx.context.service, agentContext)
      const clientApp = acp.client({ name: 'test-client' })
      const connection = clientApp.connect(agentApp)

      // Initialize first
      await connection.agent.request('initialize', {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientInfo: { name: 'test-client', version: '1.0.0' },
      })

      // Set a provider
      await connection.agent.request('providers/set', {
        providerId: 'anthropic',
        apiType: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        headers: { 'x-api-key': 'test-key', 'anthropic-version': '2023-06-01' },
      })

      // List providers
      const listResult = await connection.agent.request('providers/list', {})
      expect(listResult.providers).toHaveLength(1)
      expect(listResult.providers[0].providerId).toBe('anthropic')
      expect(listResult.providers[0].current?.baseUrl).toBe('https://api.anthropic.com')
    } finally { ctx.context.dispose() }
  })

  it('handles session/new and session/list', async () => {
    const ctx = setup()
    try {
      const agentContext: AcpAgentContext = { principal: ctx.user, workspace: ctx.workspace }
      const agentApp = buildAcpAgent(ctx.context.service, agentContext)
      const clientApp = acp.client({ name: 'test-client' })
      const connection = clientApp.connect(agentApp)

      await connection.agent.request('initialize', {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientInfo: { name: 'test-client', version: '1.0.0' },
      })

      // Create session
      const newResult = await connection.agent.request('session/new', { cwd: '/tmp', mcpServers: [] })
      expect(newResult.sessionId).toBeTruthy()

      // List sessions
      const listResult = await connection.agent.request('session/list', {})
      expect(listResult.sessions.length).toBeGreaterThanOrEqual(1)
      expect(listResult.sessions[0].sessionId).toBe(newResult.sessionId)
    } finally { ctx.context.dispose() }
  })

  it('denies prompt when no provider is configured', async () => {
    const ctx = setup()
    try {
      const agentContext: AcpAgentContext = { principal: ctx.user, workspace: ctx.workspace }
      const agentApp = buildAcpAgent(ctx.context.service, agentContext)
      const clientApp = acp.client({ name: 'test-client' })
      const connection = clientApp.connect(agentApp)

      await connection.agent.request('initialize', {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientInfo: { name: 'test-client', version: '1.0.0' },
      })

      const session = await connection.agent.request('session/new', { cwd: '/tmp', mcpServers: [] })

      // Prompt without setting a provider should refuse
      const promptResult = await connection.agent.request('session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'hello' }],
      })
      expect(promptResult.stopReason).toBe('refusal')
    } finally { ctx.context.dispose() }
  })

  it('handles session/close', async () => {
    const ctx = setup()
    try {
      const agentContext: AcpAgentContext = { principal: ctx.user, workspace: ctx.workspace }
      const agentApp = buildAcpAgent(ctx.context.service, agentContext)
      const clientApp = acp.client({ name: 'test-client' })
      const connection = clientApp.connect(agentApp)

      await connection.agent.request('initialize', {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientInfo: { name: 'test-client', version: '1.0.0' },
      })

      const session = await connection.agent.request('session/new', { cwd: '/tmp', mcpServers: [] })
      await connection.agent.request('session/close', { sessionId: session.sessionId })

      // Session should be stopped
      const sessions = ctx.context.db.listSessions()
      const closed = sessions.find((s) => s.id === session.sessionId)
      expect(closed?.status).toBe('stopped')
    } finally { ctx.context.dispose() }
  })
})
