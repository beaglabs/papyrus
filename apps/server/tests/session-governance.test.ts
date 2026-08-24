import type { AgentRuntime, RuntimeLaunchOptions } from '@papyrus/acp-runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthorizationDenied, PapyrusService, SessionLifecycleError } from '../src/service.js'
import { testContext } from './helpers.js'

function runtime(runPrompt: AgentRuntime['runPrompt']): AgentRuntime {
  return {
    kind: 'test',
    capabilities: { transports: ['stdio'], sessions: { cancel: true, load: false, resume: false, fork: false } },
    health: async () => ({ available: true }),
    runPrompt,
  }
}

function setup(factory?: (options: RuntimeLaunchOptions) => AgentRuntime) {
  const context = testContext(factory)
  const owner = context.db.upsertUser({ externalId: 'oidc:issuer:owner', displayName: 'Owner', authMethod: 'oidc' })
  context.db.setRole(owner.id, 'Owner')
  const activeOwner = context.db.getPrincipal(owner.id)!
  const user = context.db.upsertUser({ externalId: 'oidc:issuer:user', displayName: 'User', authMethod: 'oidc' })
  context.db.setRole(user.id, 'User')
  const activeUser = context.db.getPrincipal(user.id)!
  const other = context.db.upsertUser({ externalId: 'oidc:issuer:other', displayName: 'Other', authMethod: 'oidc' })
  context.db.setRole(other.id, 'User')
  const activeOther = context.db.getPrincipal(other.id)!
  const environment = context.service.createEnvironment(activeOwner, { name: 'Mission', description: '' })
  context.service.assign(activeOwner, activeUser.id, environment.id)
  const session = context.service.createSession(activeUser, environment.id, 'papyrus', 'Governed')
  return { context, owner: activeOwner, user: activeUser, other: activeOther, environment, session }
}

describe('governed session lifecycle', () => {
  const contexts: ReturnType<typeof setup>[] = []
  afterEach(() => { while (contexts.length) contexts.pop()?.context.dispose() })

  it('allows only one active prompt and supports owner cancellation', async () => {
    let started!: () => void
    const didStart = new Promise<void>((resolve) => { started = resolve })
    const factory = vi.fn(() => runtime(async (request) => {
      started()
      await new Promise<void>((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => reject(request.signal?.reason), { once: true })
      })
      return { runtimeSessionId: 'never', stopReason: 'end_turn' }
    }))
    const ctx = setup(factory); contexts.push(ctx)

    const first = ctx.context.service.prompt(ctx.user, ctx.session.id, 'first')
    await didStart
    await expect(ctx.context.service.prompt(ctx.user, ctx.session.id, 'second')).rejects.toMatchObject({
      code: 'SESSION_BUSY',
    })

    expect(ctx.context.service.cancelSession(ctx.user, ctx.session.id)).toBe(true)
    await expect(first).resolves.toMatchObject({ stopReason: 'cancelled' })
    expect(ctx.context.db.getSession(ctx.session.id)?.status).toBe('ready')
    expect(ctx.context.db.listSessionRuns(ctx.session.id).map((run) => run.status)).toEqual(['cancelled'])
  })

  it('cancels an active prompt on close and preserves the stopped state', async () => {
    let started!: () => void
    const didStart = new Promise<void>((resolve) => { started = resolve })
    const ctx = setup(() => runtime(async (request) => {
      started()
      await new Promise<void>((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => reject(request.signal?.reason), { once: true })
      })
      return { runtimeSessionId: 'never', stopReason: 'end_turn' }
    }))
    contexts.push(ctx)

    const pending = ctx.context.service.prompt(ctx.user, ctx.session.id, 'work')
    await didStart
    expect(ctx.context.service.closeSession(ctx.user, ctx.session.id).status).toBe('stopped')
    await expect(pending).resolves.toMatchObject({ stopReason: 'cancelled' })
    expect(ctx.context.db.getSession(ctx.session.id)?.status).toBe('stopped')
    await expect(ctx.context.service.prompt(ctx.user, ctx.session.id, 'blocked')).rejects.toMatchObject({
      code: 'SESSION_STOPPED',
    })
    expect(ctx.context.service.resumeSession(ctx.user, ctx.session.id).status).toBe('ready')
  })

  it('enforces ownership for cancellation, resume, runs, events, goals, and browser input', async () => {
    const ctx = setup(); contexts.push(ctx)
    expect(() => ctx.context.service.cancelSession(ctx.other, ctx.session.id)).toThrow(AuthorizationDenied)
    expect(() => ctx.context.service.resumeSession(ctx.other, ctx.session.id)).toThrow(AuthorizationDenied)
    expect(() => ctx.context.service.sessionRuns(ctx.other, ctx.session.id)).toThrow(AuthorizationDenied)
    expect(() => ctx.context.service.sessionEvents(ctx.other, ctx.session.id)).toThrow(AuthorizationDenied)
    await expect(ctx.context.service.sessionGoal(ctx.other, ctx.session.id)).rejects.toBeInstanceOf(AuthorizationDenied)
    await expect(ctx.context.service.browserInput(ctx.other, ctx.session.id, { kind: 'mouse', event: {} })).rejects.toBeInstanceOf(AuthorizationDenied)
  })

  it('marks orphaned runs interrupted when a daemon instance starts', () => {
    const ctx = setup(); contexts.push(ctx)
    const run = ctx.context.db.beginSessionRun(ctx.session.id, ctx.user.id)

    const recovered = new PapyrusService(ctx.context.db, ctx.context.config, () => runtime(async () => ({
      runtimeSessionId: 'unused',
      stopReason: 'end_turn',
    })))

    expect(ctx.context.db.getSession(ctx.session.id)?.status).toBe('interrupted')
    expect(ctx.context.db.getSessionRun(run.id)).toMatchObject({
      status: 'interrupted',
      stopReason: 'daemon_restart',
    })
    expect(recovered.resumeSession(ctx.user, ctx.session.id).status).toBe('ready')
    expect(recovered.audit.verify()).toEqual({ valid: true })
  })

  it('persists cursor-addressable user and runtime events per run', async () => {
    let runtimeCwd = ''
    const ctx = setup(() => runtime(async (request) => {
      runtimeCwd = request.cwd
      await request.onEvent({ kind: 'update', at: new Date().toISOString(), data: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'one' } } })
      await request.onEvent({ kind: 'update', at: new Date().toISOString(), data: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'two' } } })
      return { runtimeSessionId: 'rt-1', stopReason: 'end_turn' }
    }))
    contexts.push(ctx)

    await ctx.context.service.prompt(ctx.user, ctx.session.id, 'hello')
    const firstPage = ctx.context.service.sessionEvents(ctx.user, ctx.session.id, 0, 2)
    const secondPage = ctx.context.service.sessionEvents(ctx.user, ctx.session.id, firstPage[1]!.sequence, 2)

    expect(firstPage).toHaveLength(2)
    expect(secondPage).toHaveLength(2)
    expect([...firstPage, ...secondPage].map((event) => event.data)).toContainEqual(expect.objectContaining({ sessionUpdate: 'user_message_chunk' }))
    expect(new Set([...firstPage, ...secondPage].map((event) => event.runId)).size).toBe(1)
    expect(runtimeCwd).toBe('/')
  })
})
