import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { EntraAppRole } from '@papyrus/contracts'
import type { AgentConfig } from '../src/agent/config.js'
import { AgentDatabase } from '../src/agent/database.js'
import { EntraAuthService } from '../src/agent/entra-auth.js'
import { createAgentServer } from '../src/agent/http.js'
import { AgentService } from '../src/agent/service.js'
import { ActionStore } from '../src/agent/action-store.js'
import { TerrainStore } from '../src/agent/terrain-store.js'
import { MastraRuntime } from '../src/agent/mastra/runtime.js'

interface RunningPortal {
  origin: string
  server: Server
  mastra: MastraRuntime
  db: AgentDatabase
  dataDir: string
}

async function openPortal(roles: EntraAppRole[]): Promise<RunningPortal> {
  const dataDir = mkdtempSync(join(tmpdir(), 'papyrus-observability-access-'))
  const db = new AgentDatabase(':memory:')
  const config: AgentConfig = {
    mode: 'local',
    profile: 'gcc',
    host: '127.0.0.1',
    port: 0,
    publicOrigin: 'http://127.0.0.1:3210',
    dataDir,
    databasePath: ':memory:',
    portalSecret: 'portal-secret-at-least-thirty-two-characters',
    organizationName: 'Example Agency',
    cloud: 'Public',
    licenseRequired: false,
    licenseAuthorities: {},
    developmentPrincipal: {
      oid: 'observer',
      tenantId: 'tenant',
      displayName: 'Observer',
      roles,
      groups: [],
      source: 'development',
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
  return { origin: `http://127.0.0.1:${address.port}`, server, mastra, db, dataDir }
}

async function closePortal(portal: RunningPortal): Promise<void> {
  await new Promise<void>((resolve) => portal.server.close(() => resolve()))
  await portal.mastra.stop()
  portal.db.close()
  rmSync(portal.dataDir, { recursive: true, force: true })
}

describe('governance observability access', () => {
  const portals: RunningPortal[] = []
  afterEach(async () => {
    while (portals.length) {
      const portal = portals.pop()
      if (portal) await closePortal(portal)
    }
  })

  for (const role of ['Papyrus.System.Owner', 'Papyrus.Audit.View', 'Papyrus.Security.Manage'] as const) {
    it(`allows ${role} to read traces and logs`, async () => {
      const portal = await openPortal([role])
      portals.push(portal)

      const traces = await fetch(`${portal.origin}/api/observability/traces`)
      expect(traces.status).toBe(200)
      expect(await traces.json()).toMatchObject({
        storage: { provider: 'libsql', database: 'mastra.db' },
        pagination: expect.objectContaining({ page: 0, perPage: 50 }),
        traces: expect.any(Array),
      })

      const logs = await fetch(`${portal.origin}/api/observability/logs`)
      expect(logs.status).toBe(200)
      expect(await logs.json()).toMatchObject({
        storage: { provider: 'libsql', database: 'mastra.db' },
        pagination: expect.objectContaining({ page: 0, perPage: 50 }),
        logs: expect.any(Array),
      })
    })
  }

  it('rejects an authenticated portal user without an observability role', async () => {
    const portal = await openPortal(['Papyrus.Integration.View'])
    portals.push(portal)

    const traces = await fetch(`${portal.origin}/api/observability/traces`)
    expect(traces.status).toBe(403)
    expect(await traces.json()).toMatchObject({ code: 'ENTRA_OBSERVABILITY_ROLE_REQUIRED' })

    const logs = await fetch(`${portal.origin}/api/observability/logs`)
    expect(logs.status).toBe(403)
    expect(await logs.json()).toMatchObject({ code: 'ENTRA_OBSERVABILITY_ROLE_REQUIRED' })
  })
})
