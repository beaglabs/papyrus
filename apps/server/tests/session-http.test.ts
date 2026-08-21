import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { AgentRuntime } from '@papyrus/acp-runtime'
import { describe, expect, it } from 'vitest'
import { createPapyrusServer } from '../src/http.js'
import { testContext } from './helpers.js'

function fakeRuntime(): AgentRuntime {
  return {
    kind: 'test',
    capabilities: { transports: ['stdio'], sessions: { cancel: true, load: false, resume: false, fork: false } },
    health: async () => ({ available: true }),
    runPrompt: async (request) => {
      await request.onEvent({
        kind: 'update',
        at: new Date().toISOString(),
        data: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'hello' },
          messageId: 'agent_1',
        },
      })
      return { runtimeSessionId: 'runtime-1', stopReason: 'end_turn' }
    },
  }
}

describe('governed session HTTP API', () => {
  it('exposes runs, cursor events, close, and resume to the session owner', async () => {
    const ctx = testContext(() => fakeRuntime())
    const owner = ctx.db.upsertUser({ externalId: 'oidc:owner', displayName: 'Owner', authMethod: 'oidc' })
    ctx.db.setRole(owner.id, 'Owner')
    const activeOwner = ctx.db.getPrincipal(owner.id)!
    const user = ctx.db.upsertUser({ externalId: 'oidc:user', displayName: 'User', authMethod: 'oidc' })
    ctx.db.setRole(user.id, 'User')
    const activeUser = ctx.db.getPrincipal(user.id)!
    const workspace = ctx.service.createWorkspace(activeOwner, { name: 'Mission', description: '' })
    ctx.service.assign(activeOwner, activeUser.id, workspace.id)
    const session = ctx.service.createSession(activeUser, workspace.id, 'goose', 'HTTP')
    const authorization = `Bearer ${ctx.auth.issueSession(activeUser.id)}`
    const server = createPapyrusServer(ctx.config, ctx.service, ctx.auth)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const port = (server.address() as AddressInfo).port
    const origin = `http://127.0.0.1:${port}`
    const request = (path: string, init: RequestInit = {}) => fetch(`${origin}${path}`, {
      ...init,
      headers: { authorization, 'content-type': 'application/json', ...init.headers },
    })

    try {
      const prompted = await request(`/api/sessions/${session.id}/prompt`, {
        method: 'POST',
        body: JSON.stringify({ prompt: 'hello' }),
      })
      expect(prompted.status).toBe(200)

      const events = await request(`/api/sessions/${session.id}/events?after=0&limit=1`)
      expect(events.status).toBe(200)
      expect((await events.json() as { events: unknown[] }).events).toHaveLength(1)

      const runs = await request(`/api/sessions/${session.id}/runs`)
      expect((await runs.json() as { runs: Array<{ status: string }> }).runs[0]?.status).toBe('completed')

      expect((await request(`/api/sessions/${session.id}/close`, { method: 'POST' })).status).toBe(200)
      const blocked = await request(`/api/sessions/${session.id}/prompt`, {
        method: 'POST',
        body: JSON.stringify({ prompt: 'blocked' }),
      })
      expect(blocked.status).toBe(409)
      expect((await blocked.json() as { code: string }).code).toBe('SESSION_STOPPED')

      expect((await request(`/api/sessions/${session.id}/resume`, { method: 'POST' })).status).toBe(200)
      expect(ctx.db.getSession(session.id)?.status).toBe('ready')
    } finally {
      server.close()
      await once(server, 'close')
      ctx.dispose()
    }
  })

  it('provides paginated session detail and a resumable event stream', async () => {
    const ctx = testContext(() => fakeRuntime())
    const owner = ctx.db.upsertUser({ externalId: 'oidc:owner-web', displayName: 'Owner', authMethod: 'oidc' })
    ctx.db.setRole(owner.id, 'Owner')
    const activeOwner = ctx.db.getPrincipal(owner.id)!
    const user = ctx.db.upsertUser({ externalId: 'oidc:user-web', displayName: 'User', authMethod: 'oidc' })
    ctx.db.setRole(user.id, 'User')
    const activeUser = ctx.db.getPrincipal(user.id)!
    const workspace = ctx.service.createWorkspace(activeOwner, { name: 'Web', description: '' })
    ctx.service.assign(activeOwner, activeUser.id, workspace.id)
    const first = ctx.service.createSession(activeUser, workspace.id, 'goose', 'First')
    ctx.service.createSession(activeUser, workspace.id, 'goose', 'Second')
    await ctx.service.prompt(activeUser, first.id, 'hello')

    const authorization = `Bearer ${ctx.auth.issueSession(activeUser.id)}`
    const server = createPapyrusServer(ctx.config, ctx.service, ctx.auth)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const headers = { authorization }

    try {
      const created = await fetch(`${origin}/api/sessions`, {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: workspace.id, title: 'Browser session' }),
      })
      expect(created.status).toBe(201)
      expect(await created.json()).toMatchObject({ title: 'Browser session', agent: 'goose' })

      const page = await fetch(`${origin}/api/sessions?limit=1`, { headers })
      const pageBody = await page.json() as { sessions: unknown[]; nextCursor?: string }
      expect(pageBody.sessions).toHaveLength(1)
      expect(pageBody.nextCursor).toBeTruthy()

      const detail = await fetch(`${origin}/api/sessions/${first.id}`, { headers })
      expect(await detail.json()).toMatchObject({ id: first.id, title: 'First' })

      const controller = new AbortController()
      const stream = await fetch(`${origin}/api/sessions/${first.id}/events/stream`, {
        headers,
        signal: controller.signal,
      })
      expect(stream.status).toBe(200)
      expect(stream.headers.get('content-type')).toContain('text/event-stream')
      const chunk = await stream.body!.getReader().read()
      expect(new TextDecoder().decode(chunk.value)).toContain('event: session_event')
      controller.abort()
    } finally {
      server.close()
      await once(server, 'close')
      ctx.dispose()
    }
  })
})
