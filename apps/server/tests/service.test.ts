import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRuntime, RuntimeLaunchOptions } from '@papyrus/acp-runtime'
import { AuthorizationDenied } from '../src/service.js'
import { testContext } from './helpers.js'

describe('Papyrus control plane', () => {
  const contexts: ReturnType<typeof testContext>[] = []
  afterEach(() => { while (contexts.length) contexts.pop()?.dispose() })

  it('uses a single-use secret for Owner bootstrap', () => {
    const context = testContext(); contexts.push(context)
    const user = context.db.upsertUser({ externalId: 'oidc:issuer:alice', displayName: 'Alice', authMethod: 'oidc' })
    expect(() => context.service.bootstrap(user, 'wrong')).toThrow(/Invalid bootstrap secret/)
    expect(context.service.bootstrap(user, 'correct horse battery staple').roles).toContain('Owner')
    expect(() => context.service.bootstrap(user, 'correct horse battery staple')).toThrow(/already complete/)
  })

  it('requires environment assignment for session creation', () => {
    const context = testContext(); contexts.push(context)
    const { owner, user, environment } = setup(context)
    context.service.assign(owner, user.id, environment.id)
    const session = context.service.createSession(user, environment.id, 'papyrus', 'Allowed')
    expect(session.ownerId).toBe(user.id)
    expect(context.service.listSessions(user)).toEqual([session])
    expect(context.service.audit.verify()).toEqual({ valid: true })
  })

  it('creates a session against an internal default execution target', () => {
    const context = testContext(); contexts.push(context)
    const { user, environment } = setup(context)
    const session = context.service.createSession(user, undefined, 'papyrus', 'Automatic target')
    const target = context.db.getEnvironment(session.environmentId)
    expect(target).toMatchObject({ name: 'Deployment default' })
    expect(session.environmentId).not.toBe(environment.id)
    expect(context.db.isAssigned(user.id, 'environment', session.environmentId)).toBe(true)
    expect(context.service.audit.verify()).toEqual({ valid: true })
  })

  it('prevents an Admin from assigning privileged roles', () => {
    const context = testContext(); contexts.push(context)
    const admin = context.db.upsertUser({ externalId: 'oidc:issuer:admin', displayName: 'Admin', authMethod: 'oidc' })
    const target = context.db.upsertUser({ externalId: 'oidc:issuer:target', displayName: 'Target', authMethod: 'oidc' })
    context.db.setRole(admin.id, 'Admin')
    expect(() => context.service.assignRole(context.db.getPrincipal(admin.id)!, target.id, 'Owner')).toThrow(AuthorizationDenied)
    expect(context.service.assignRole(context.db.getPrincipal(admin.id)!, target.id, 'User').roles).toContain('User')
  })

  it('isolates sessions between environments', () => {
    const context = testContext(); contexts.push(context)
    const { owner, user, environment } = setup(context)
    const other = context.service.createEnvironment(owner, { name: 'Other', description: '' })
    context.service.assign(owner, user.id, environment.id)
    const session = context.service.createSession(user, environment.id, 'papyrus', 'Mine')
    expect(() => context.service.createSession(user, other.id, 'papyrus', 'Cross')).toThrow(AuthorizationDenied)
    expect(context.service.listSessions(user)).toEqual([session])
  })

  it('blocks MCP tool invocation without a environment grant and across environments', async () => {
    const context = testContext(); contexts.push(context)
    const { owner, user, environment } = setup(context)
    context.service.assign(owner, user.id, environment.id)
    const server = context.db.addMcpServer({ name: 'Tools', endpoint: 'http://tools.internal/mcp', oauthStatus: 'not_required' })
    const session = context.service.createSession(user, environment.id, 'papyrus', 'Tools')

    // A registered server is unavailable until it is explicitly enabled for the environment.
    await expect(context.service.invokeTool(user, session.id, server.id, 'delete_everything', {})).rejects.toThrow(AuthorizationDenied)
    context.service.grantMcpServer(owner, environment.id, server.id)
    expect(context.service.isToolCallAllowed(user, session, 'read_file')).toBe(true)

    // A second user in a different environment cannot use the first environment's grant.
    const other = context.service.createEnvironment(owner, { name: 'Other', description: '' })
    const otherUser = context.db.upsertUser({ externalId: 'oidc:issuer:other', displayName: 'Other', authMethod: 'oidc' })
    context.db.setRole(otherUser.id, 'User')
    const activeOther = context.db.getPrincipal(otherUser.id)!
    context.service.assign(owner, activeOther.id, other.id)
    const otherSession = context.service.createSession(activeOther, other.id, 'papyrus', 'Other tools')
    await expect(context.service.invokeTool(activeOther, otherSession.id, server.id, 'read_file', {})).rejects.toThrow(AuthorizationDenied)
  })

  it('fails closed while MCP OAuth authorization is incomplete', () => {
    const context = testContext(); contexts.push(context)
    const { owner } = setup(context)
    const server = context.db.addMcpServer({
      name: 'Needs OAuth',
      endpoint: 'https://mcp.example/mcp',
      oauthStatus: 'configuration_required',
      oauthIssuer: 'https://auth.example',
      oauthError: 'OAuth client registration required',
    })

    expect(() => context.service.setMcpServerEnabled(owner, server.id, true))
      .toThrow('Complete MCP OAuth authorization before enabling this connection')
    expect(context.db.getMcpServer(server.id)).toMatchObject({
      enabled: false,
      oauthStatus: 'configuration_required',
    })
  })

  it('deletes MCP connections with pending OAuth state and environment grants', () => {
    const context = testContext(); contexts.push(context)
    const { owner, environment } = setup(context)
    const server = context.db.addMcpServer({ name: 'Pending', endpoint: 'https://mcp.example/mcp', oauthStatus: 'authorization_required' })
    context.db.grantMcpServer(environment.id, server.id)
    context.db.createMcpOauthPending({ state: 'old-state', serverId: server.id, actorId: owner.id, issuer: 'https://auth.example', tokenEndpoint: 'https://auth.example/token', clientId: 'client', verifier: 'sealed', redirectUri: 'https://papyrus.example/api/mcp/oauth/callback', resource: server.endpoint })
    context.service.deleteMcpServer(owner, server.id)
    expect(context.db.getMcpServer(server.id)).toBeUndefined()
    expect(context.db.getMcpOauthPending('old-state')).toBeUndefined()
    expect(context.db.listToolGrants()).toEqual([])
    expect(context.service.audit.verify()).toEqual({ valid: true })
  })

  it('revokes sessions and invalidates them on role change', () => {
    const context = testContext(); contexts.push(context)
    const { owner, user } = setup(context)
    const before = context.db.getTokenVersion(user.id)
    context.service.revokeSessions(owner, user.id)
    expect(context.db.getTokenVersion(user.id)).toBe(before + 1)
    const version = context.db.getTokenVersion(user.id)
    context.service.assignRole(owner, user.id, 'User')
    expect(context.db.getTokenVersion(user.id)).toBe(version + 1)
  })

  it('runs an end-to-end session prompt and preserves audit integrity', async () => {
    const factory = vi.fn((_options: RuntimeLaunchOptions): AgentRuntime => ({
      kind: 'test',
      capabilities: { transports: ['stdio'], sessions: { cancel: true, load: false, resume: false, fork: false } },
      health: async () => ({ available: true }),
      runPrompt: async (request) => {
        await request.onEvent({ kind: 'session', at: new Date().toISOString(), data: { runtimeSessionId: 'rt-1' } })
        await request.onEvent({ kind: 'update', at: new Date().toISOString(), data: { chunk: 'hello' } })
        await request.onEvent({ kind: 'complete', at: new Date().toISOString(), data: { ok: true } })
        return { runtimeSessionId: 'rt-1', stopReason: 'end_turn' }
      },
    }))
    const context = testContext(factory); contexts.push(context)
    try {
      const { owner, user, environment } = setup(context)
      context.service.assign(owner, user.id, environment.id)
      const session = context.service.createSession(user, environment.id, 'papyrus', 'E2E')
      const result = await context.service.prompt(user, session.id, 'hello')
      expect(result.stopReason).toBe('end_turn')
      expect(result.events.map((event) => event.kind)).toEqual(['session', 'update', 'complete'])
      expect(context.db.getSession(session.id)!.status).toBe('ready')
      const events = context.db.sqlite.prepare('SELECT count(*) c FROM runtime_events WHERE session_id=?').get(session.id) as { c: number }
      expect(events.c).toBe(6)
      expect(context.db.listSessionEvents(session.id, 0, 100).filter((event) => event.kind === 'run').map((event) => (event.data as { sessionUpdate: string }).sessionUpdate)).toEqual(['run_started', 'run_completed'])
      expect(context.db.listSessionRuns(session.id)[0]).toMatchObject({ status: 'completed', stopReason: 'end_turn' })
      expect(context.service.audit.verify()).toEqual({ valid: true })
      expect(factory).toHaveBeenCalledTimes(1)
    } finally {
      delete process.env.PAPYRUS_SECRET_PRIMARY
    }
  })

  it('keeps an accepted prompt running independently of the submitting request', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const factory = vi.fn((_options: RuntimeLaunchOptions): AgentRuntime => ({
      kind: 'test',
      capabilities: { transports: ['stdio'], sessions: { cancel: true, load: false, resume: false, fork: false } },
      health: async () => ({ available: true }),
      runPrompt: async (request) => {
        await request.onEvent({ kind: 'update', at: new Date().toISOString(), data: { sessionUpdate: 'agent_thought_chunk', messageId: 'thought-1', content: { type: 'text', text: 'Working' } } })
        await gate
        await request.onEvent({ kind: 'complete', at: new Date().toISOString(), data: { ok: true } })
        return { runtimeSessionId: 'rt-detached', stopReason: 'end_turn' }
      },
    }))
    const context = testContext(factory); contexts.push(context)
    const { owner, user, environment } = setup(context)
    context.service.assign(owner, user.id, environment.id)
    const session = context.service.createSession(user, environment.id, 'papyrus', 'Detached')
    const run = await context.service.startPrompt(user, session.id, 'keep going')
    expect(run.status).toBe('running')
    expect(context.db.getSession(session.id)?.status).toBe('running')
    expect(context.db.listSessionEvents(session.id, 0, 100).map((event) => event.kind)).toEqual(['run', 'update', 'update'])
    release()
    await vi.waitFor(() => expect(context.db.getSessionRun(run.id)?.status).toBe('completed'))
    const lifecycle = context.db.listSessionEvents(session.id, 0, 100).filter((event) => event.kind === 'run')
    expect(lifecycle.map((event) => (event.data as { sessionUpdate: string }).sessionUpdate)).toEqual(['run_started', 'run_completed'])
  })

  it('signs and verifies an audit checkpoint', () => {
    const context = testContext(); contexts.push(context)
    const { owner } = setup(context)
    context.service.audit.append({ actorId: null, action: 'Probe', resourceType: 'Test', resourceId: '1', decision: 'info', metadata: {} })
    const checkpoint = context.service.exportAuditCheckpoint(owner)
    expect(checkpoint.count).toBeGreaterThan(0)
    expect(checkpoint.integrity).toBe(true)
    expect(context.service.verifyAuditCheckpoint(checkpoint)).toBe(true)
    const tampered = { ...checkpoint, events: [...checkpoint.events.slice(0, -1)] }
    expect(context.service.verifyAuditCheckpoint(tampered)).toBe(false)
  })
})

function setup(context: ReturnType<typeof testContext>) {
  const owner = context.db.upsertUser({ externalId: 'oidc:issuer:owner', displayName: 'Owner', authMethod: 'oidc' })
  context.db.setRole(owner.id, 'Owner')
  const activeOwner = context.db.getPrincipal(owner.id)!
  const user = context.db.upsertUser({ externalId: 'oidc:issuer:user', displayName: 'User', authMethod: 'oidc' })
  context.db.setRole(user.id, 'User')
  const activeUser = context.db.getPrincipal(user.id)!
  const environment = context.service.createEnvironment(activeOwner, { name: 'Mission', description: 'Segmented mission work' })
  return { owner: activeOwner, user: activeUser, environment }
}
