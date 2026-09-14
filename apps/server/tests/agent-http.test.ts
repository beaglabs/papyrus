import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentConfig } from '../src/agent/config.js'
import { AgentDatabase } from '../src/agent/database.js'
import { EntraAuthService } from '../src/agent/entra-auth.js'
import { createAgentServer } from '../src/agent/http.js'
import { AgentService } from '../src/agent/service.js'
import { ActionStore } from '../src/agent/action-store.js'
import { TerrainStore } from '../src/agent/terrain-store.js'
import { MastraRuntime } from '../src/agent/mastra/runtime.js'

describe('agent portal HTTP surface', () => {
  const disposers: Array<() => Promise<void> | void> = []
  afterEach(async () => { while (disposers.length) await disposers.pop()?.() })

  it('exposes sessions and Links without Plugin or scheduler portal APIs', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'papyrus-agent-http-'))
    const db = new AgentDatabase(':memory:')
    const config: AgentConfig = {
      mode: 'local', profile: 'gcc', host: '127.0.0.1', port: 0, publicOrigin: 'http://127.0.0.1:3210',
      dataDir, databasePath: ':memory:', portalSecret: 'portal-secret-at-least-thirty-two-characters',
      organizationName: 'Example Agency', cloud: 'Public', licenseRequired: false, licenseAuthorities: {},
      developmentPrincipal: {
        oid: 'owner', tenantId: 'tenant', displayName: 'Owner', roles: ['Papyrus.System.Owner'], groups: [], source: 'development',
      },
    }
    const terrain = new TerrainStore(db)
    const actionStore = new ActionStore(db)
    const service = new AgentService(db, config, terrain, undefined, actionStore)
    const mastra = new MastraRuntime(config, actionStore, terrain, service)
    await mastra.start()
    const server = createAgentServer(config, service, new EntraAuthService(config), mastra)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener')
    const origin = `http://127.0.0.1:${address.port}`
    disposers.push(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await mastra.stop()
      db.close()
      rmSync(dataDir, { recursive: true, force: true })
    })

    expect(await (await fetch(`${origin}/api/me`)).json()).toMatchObject({ oid: 'owner', roles: ['Papyrus.System.Owner'] })

    const sessionResponse = await fetch(`${origin}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Operator task' }),
    })
    expect(sessionResponse.status).toBe(201)
    const session = await sessionResponse.json() as { id: string; title: string }
    expect(session.title).toBe('Operator task')
    expect(await (await fetch(`${origin}/api/sessions`)).json()).toMatchObject({
      sessions: [expect.objectContaining({ id: session.id, title: 'Operator task' })],
    })

    expect(await (await fetch(`${origin}/api/links`)).json()).toEqual({ links: [] })

    for (const request of [
      [`${origin}/api/plugins`, 'GET'],
      [`${origin}/api/plugins/connect`, 'POST'],
      [`${origin}/api/schedules`, 'GET'],
      [`${origin}/api/schedules`, 'POST'],
      [`${origin}/api/schedules/legacy`, 'DELETE'],
      [`${origin}/api/signals/legacy/webhook`, 'POST'],
      [`${origin}/api/integrations/catalog`, 'GET'],
      [`${origin}/api/integrations`, 'GET'],
      [`${origin}/api/integrations`, 'POST'],
      [`${origin}/api/integrations/legacy`, 'DELETE'],
      [`${origin}/api/integrations/legacy/ingestion-token`, 'POST'],
      [`${origin}/api/integrations/legacy/observations`, 'POST'],
    ] as const) {
      const response = await fetch(request[0], {
        method: request[1],
        ...(request[1] === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}),
      })
      expect(response.status, `${request[1]} ${request[0]}`).toBe(404)
    }
  })

  it('scopes jobs status to one session and refuses unknown or oversized session ids', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'papyrus-agent-jobs-'))
    const db = new AgentDatabase(':memory:')
    const config: AgentConfig = {
      mode: 'local', profile: 'gcc', host: '127.0.0.1', port: 0, publicOrigin: 'http://127.0.0.1:3210',
      dataDir, databasePath: ':memory:', portalSecret: 'portal-secret-at-least-thirty-two-characters',
      organizationName: 'Example Agency', cloud: 'Public', licenseRequired: false, licenseAuthorities: {},
      developmentPrincipal: {
        oid: 'owner', tenantId: 'tenant', displayName: 'Owner', roles: ['Papyrus.System.Owner'], groups: [], source: 'development',
      },
    }
    const terrain = new TerrainStore(db)
    const actionStore = new ActionStore(db)
    const service = new AgentService(db, config, terrain, undefined, actionStore)
    const mastra = new MastraRuntime(config, actionStore, terrain, service)
    await mastra.start()
    const server = createAgentServer(config, service, new EntraAuthService(config), mastra)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener')
    const origin = `http://127.0.0.1:${address.port}`
    disposers.push(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await mastra.stop()
      db.close()
      rmSync(dataDir, { recursive: true, force: true })
    })

    const session = await (await fetch(`${origin}/api/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Jobs' }),
    })).json() as { id: string }

    // Unscoped status stays exactly as before: no jobs block, no session leak.
    const unscoped = await (await fetch(`${origin}/api/agent/status`)).json() as Record<string, unknown>
    expect(unscoped['jobs']).toBeUndefined()

    const scoped = await (await fetch(`${origin}/api/agent/status?session=${encodeURIComponent(session.id)}`)).json() as {
      jobs?: { sessionId: string; schedules: { active: number; paused: number; nextFireAt: number | null }; background: { running: number; queued: number; failed: number; observed: boolean } }
    }
    expect(scoped.jobs?.sessionId).toBe(session.id)
    expect(scoped.jobs?.schedules).toEqual({ active: 0, paused: 0, nextFireAt: null })
    expect(scoped.jobs?.background).toMatchObject({ running: 0, queued: 0, failed: 0, observed: true })

    expect((await fetch(`${origin}/api/agent/status?session=no-such-session`)).status).toBe(404)
    expect((await fetch(`${origin}/api/agent/status?session=${'x'.repeat(300)}`)).status).toBe(400)
  })
})
