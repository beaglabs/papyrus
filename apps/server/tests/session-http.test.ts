import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { AgentRuntime } from '@papyrus/acp-runtime'
import { describe, expect, it, vi } from 'vitest'
import { createPapyrusServer } from '../src/http.js'
import { testContext } from './helpers.js'

function fakeRuntime(): AgentRuntime {
  return {
    kind: 'test',
    capabilities: { transports: ['stdio'], sessions: { cancel: true, load: false, resume: false, fork: false } },
    health: async () => ({ available: true }),
    runPrompt: async (request) => {
      await request.onEvent({
        kind: 'update', at: new Date().toISOString(),
        data: { sessionUpdate: 'plan', entries: [{ content: 'Prepare briefing', status: 'in_progress', priority: 'high' }] },
      })
      await request.onEvent({
        kind: 'update', at: new Date().toISOString(),
        data: {
          sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Create briefing', kind: 'edit', status: 'completed',
          locations: [{ path: 'https://example.mil/guidance?token=do-not-retain#evidence' }],
          content: [
            { type: 'diff', path: '/environment/brief.md', oldText: null, newText: '# Brief\n\nPrepared.' },
            { type: 'content', content: { type: 'resource', resource: { uri: 'file:///environment/evidence.txt', mimeType: 'text/plain', text: 'Evidence' } } },
          ],
        },
      })
      await request.onEvent({
        kind: 'update', at: new Date().toISOString(),
        data: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed', content: [{ type: 'diff', path: '/environment/brief.md', oldText: '# Brief\n\nPrepared.', newText: '# Brief\n\nPrepared and reviewed.' }] },
      })
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
  it('governs uploads and sends selected files as ACP embedded content', async () => {
    let receivedPrompt: unknown
    const runtime = fakeRuntime()
    runtime.runPrompt = async (request) => { receivedPrompt = request.prompt; return { runtimeSessionId: 'runtime-attachment', stopReason: 'end_turn' } }
    const ctx = testContext(() => runtime)
    const owner = ctx.db.upsertUser({ externalId: 'oidc:attachment-owner', displayName: 'Owner', authMethod: 'oidc' })
    ctx.db.setRole(owner.id, 'Owner')
    const principal = ctx.db.getPrincipal(owner.id)!
    const environment = ctx.service.createEnvironment(principal, { name: 'Files', description: '' })
    const session = ctx.service.createSession(principal, environment.id, 'papyrus', 'Attachment test')
    const authorization = `Bearer ${ctx.auth.issueSession(principal.id)}`
    const server = createPapyrusServer(ctx.config, ctx.service, ctx.auth)
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      const uploaded = await fetch(`${origin}/api/sessions/${session.id}/attachments`, {
        method: 'POST', headers: { authorization, 'content-type': 'text/plain', 'x-papyrus-file-name': encodeURIComponent('../brief.txt') }, body: 'governed context',
      })
      expect(uploaded.status).toBe(201)
      const attachment = await uploaded.json() as { id: string; name: string; sha256: string; downloadUrl: string }
      expect(attachment.name).toBe('.._brief.txt')
      expect(attachment.sha256).toHaveLength(64)

      const prompt = await fetch(`${origin}/api/sessions/${session.id}/prompts`, {
        method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'Summarize it', attachmentIds: [attachment.id] }),
      })
      expect(prompt.status).toBe(202)
      await vi.waitFor(() => expect(receivedPrompt).toBeDefined())
      expect(receivedPrompt).toMatchObject([
        { type: 'text', text: 'Summarize it' },
        { type: 'resource', resource: { mimeType: 'text/plain', text: 'governed context' } },
      ])
      const downloaded = await fetch(`${origin}${attachment.downloadUrl}`, { headers: { authorization } })
      expect(await downloaded.text()).toBe('governed context')
    } finally {
      server.close(); await once(server, 'close'); ctx.dispose()
    }
  })

  it('exposes runs, cursor events, close, and resume to the session owner', async () => {
    const ctx = testContext(() => fakeRuntime())
    const owner = ctx.db.upsertUser({ externalId: 'oidc:owner', displayName: 'Owner', authMethod: 'oidc' })
    ctx.db.setRole(owner.id, 'Owner')
    const activeOwner = ctx.db.getPrincipal(owner.id)!
    const user = ctx.db.upsertUser({ externalId: 'oidc:user', displayName: 'User', authMethod: 'oidc' })
    ctx.db.setRole(user.id, 'User')
    const activeUser = ctx.db.getPrincipal(user.id)!
    const environment = ctx.service.createEnvironment(activeOwner, { name: 'Mission', description: '' })
    ctx.service.assign(activeOwner, activeUser.id, environment.id)
    const session = ctx.service.createSession(activeUser, environment.id, 'papyrus', 'HTTP')
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
      expect(prompted.status).toBe(202)
      await vi.waitFor(() => expect(ctx.db.listSessionRuns(session.id)[0]?.status).toBe('completed'))

      const events = await request(`/api/sessions/${session.id}/events?after=0&limit=1`)
      expect(events.status).toBe(200)
      expect((await events.json() as { events: unknown[] }).events).toHaveLength(1)

      const runs = await request(`/api/sessions/${session.id}/runs`)
      expect((await runs.json() as { runs: Array<{ status: string }> }).runs[0]?.status).toBe('completed')

      const artifacts = await request(`/api/sessions/${session.id}/artifacts`)
      const artifactBody = await artifacts.json() as { artifacts: Array<{ id: string; name: string; version: number; downloadUrl: string }> }
      expect(artifactBody.artifacts.map((artifact) => artifact.name)).toEqual(['brief.md', 'evidence.txt', 'brief.md'])
      expect(artifactBody.artifacts.filter((artifact) => artifact.name === 'brief.md').map((artifact) => artifact.version)).toEqual([1, 2])
      const downloaded = await request(artifactBody.artifacts[0]!.downloadUrl)
      expect(downloaded.headers.get('content-disposition')).toContain('brief.md')
      expect(await downloaded.text()).toContain('Prepared.')

      const sources = await request(`/api/sessions/${session.id}/sources`)
      expect(await sources.json()).toMatchObject({ sources: [{ sessionId: session.id, url: 'https://example.mil/guidance', host: 'example.mil' }] })
      const allSources = await request('/api/sources')
      expect((await allSources.json() as { sources: unknown[] }).sources).toHaveLength(0)

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
    const environment = ctx.service.createEnvironment(activeOwner, { name: 'Web', description: '' })
    ctx.service.assign(activeOwner, activeUser.id, environment.id)
    const first = ctx.service.createSession(activeUser, environment.id, 'papyrus', 'First')
    ctx.service.createSession(activeUser, environment.id, 'papyrus', 'Second')
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
        body: JSON.stringify({ environmentId: environment.id, title: 'Browser session' }),
      })
      expect(created.status).toBe(201)
      expect(await created.json()).toMatchObject({ title: 'Browser session', agent: 'papyrus' })

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
