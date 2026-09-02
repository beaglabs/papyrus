import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CyberConfig } from '../src/cyber/config.js'
import { CyberDatabase } from '../src/cyber/database.js'
import { EntraAuthService } from '../src/cyber/entra-auth.js'
import { createCyberServer } from '../src/cyber/http.js'
import { CyberService } from '../src/cyber/service.js'

describe('cyber portal HTTP surface', () => {
  const disposers: Array<() => Promise<void> | void> = []
  afterEach(async () => { while (disposers.length) await disposers.pop()?.() })

  it('exposes the Entra principal and integration lifecycle without session routes', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'papyrus-cyber-http-'))
    const db = new CyberDatabase(':memory:')
    const config: CyberConfig = {
      mode: 'local', profile: 'gcc', host: '127.0.0.1', port: 0, publicOrigin: 'http://127.0.0.1:3210',
      dataDir, databasePath: ':memory:', portalSecret: 'portal-secret-at-least-thirty-two-characters',
      organizationName: 'Example Agency', cloud: 'Public', licenseRequired: false, licenseAuthorities: {},
      developmentPrincipal: {
        oid: 'owner', tenantId: 'tenant', displayName: 'Owner', roles: ['Papyrus.System.Owner'], groups: [], source: 'development',
      },
    }
    const service = new CyberService(db, config)
    const server = createCyberServer(config, service, new EntraAuthService(config))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener')
    const origin = `http://127.0.0.1:${address.port}`
    disposers.push(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); db.close(); rmSync(dataDir, { recursive: true, force: true }) })

    expect(await (await fetch(`${origin}/api/me`)).json()).toMatchObject({ oid: 'owner', roles: ['Papyrus.System.Owner'] })
    const createdResponse = await fetch(`${origin}/api/integrations`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ catalogId: 'zeek', name: 'Zeek East', scope: 'east enclave', settings: {} }),
    })
    expect(createdResponse.status).toBe(201)
    const created = await createdResponse.json() as { id: string; state: string }
    expect(created.state).toBe('active')
    expect((await fetch(`${origin}/api/sessions`)).status).toBe(404)
    const observationBody = JSON.stringify({
        sourceRecordId: 'zeek-1', observedAt: '2026-09-02T07:00:00Z', schema: 'zeek.conn@1',
        payload: { uid: 'C1', 'id.orig_h': '10.0.0.12', 'id.orig_p': 51822, 'id.resp_h': '10.0.0.8', 'id.resp_p': 443, proto: 'tcp' },
      })
    const observationResponse = await fetch(`${origin}/api/integrations/${created.id}/observations`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: observationBody,
    })
    expect(observationResponse.status).toBe(201)
    expect((await fetch(`${origin}/api/integrations/${created.id}/observations`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: observationBody,
    })).status).toBe(200)
    const terrainResponse = await fetch(`${origin}/api/terrain`)
    expect(terrainResponse.status).toBe(200)
    expect(await terrainResponse.json()).toMatchObject({ observationCount: 1, entities: [{ label: '10.0.0.12' }, { label: '10.0.0.8' }], relationships: [{ kind: 'connected_to' }] })
    expect((await fetch(`${origin}/api/integrations/${created.id}`, { method: 'DELETE' })).status).toBe(204)
    expect(await (await fetch(`${origin}/api/integrations`)).json()).toEqual({ integrations: [] })
    expect(await (await fetch(`${origin}/api/terrain`)).json()).toMatchObject({ observationCount: 1 })
  })
})
