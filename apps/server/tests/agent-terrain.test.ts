import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentConfig } from '../src/agent/config.js'
import { AgentDatabase } from '../src/agent/database.js'
import { AgentService } from '../src/agent/service.js'

describe('durable terrain observations', () => {
  const disposers: Array<() => void> = []
  afterEach(() => { while (disposers.length) disposers.pop()?.() })

  function setup(catalogId = 'observation-api') {
    const dataDir = mkdtempSync(join(tmpdir(), 'papyrus-terrain-test-'))
    const db = new AgentDatabase(':memory:')
    const config: AgentConfig = {
      mode: 'local', profile: 'gcc', host: 'localhost', port: 3210, publicOrigin: 'http://localhost:3210',
      dataDir, databasePath: ':memory:', portalSecret: 'portal-secret-at-least-thirty-two-characters',
      organizationName: 'Example Agency', cloud: 'Public', licenseRequired: false, licenseAuthorities: {},
    }
    const service = new AgentService(db, config)
    const owner = { oid: 'owner', tenantId: 'tenant', displayName: 'Owner', roles: ['Papyrus.System.Owner' as const], groups: [], source: 'development' as const }
    const integration = service.createIntegration(owner, catalogId, { name: 'Terrain ingest', scope: 'test', settings: {} })
    expect(integration.state).toBe('active')
    disposers.push(() => { db.close(); rmSync(dataDir, { recursive: true, force: true }) })
    return { db, service, owner, integration: service.integrations(owner)[0]! }
  }

  it('projects entities and relationships with observation provenance', async () => {
    const { db, service, owner, integration } = setup()
    const input = {
      sourceRecordId: 'sensor-record-1', observedAt: '2026-09-02T07:00:00Z', evidenceType: 'NetworkConnection', subject: 'device:workstation-1',
      payload: { raw: 'preserved', bytes: 42 },
      terrain: {
        entities: [
          { externalId: 'device:workstation-1', kind: 'Device', label: 'Workstation 1', attributes: { os: 'Windows' }, confidence: 0.9 },
          { externalId: 'ip:10.0.0.8', kind: 'IPAddress', label: '10.0.0.8', confidence: 1 },
        ],
        relationships: [{ kind: 'connected_to', sourceExternalId: 'device:workstation-1', targetExternalId: 'ip:10.0.0.8', confidence: 0.8 }],
      },
    }
    const result = service.ingestObservation(owner, integration.id, input)
    expect(result).toMatchObject({ created: true, entities: 2, relationships: 1 })
    const snapshot = service.terrainSnapshot(owner)
    expect(snapshot).toMatchObject({ observationCount: 1, unresolvedClaims: 0 })
    expect(snapshot.entities.map((entity) => entity.label)).toEqual(['Workstation 1', '10.0.0.8'])
    expect(snapshot.entities[0]).toMatchObject({ sourceIntegrationIds: [integration.id], evidenceIds: [result.observation.id] })
    expect(snapshot.relationships[0]).toMatchObject({ kind: 'connected_to', sourceIntegrationIds: [integration.id], evidenceIds: [result.observation.id] })
    expect(() => db.sqlite.prepare('UPDATE agent_observations SET subject=? WHERE id=?').run('changed', result.observation.id)).toThrow(/append-only/)
  })

  it('is idempotent for identical source records and rejects divergent reuse', async () => {
    const { service, owner, integration } = setup()
    const input = {
      sourceRecordId: 'record-1', observedAt: '2026-09-02T07:00:00Z', evidenceType: 'Device', subject: 'device:1', payload: { value: 1 },
      terrain: { entities: [{ externalId: 'device:1', kind: 'Device', label: 'Device 1' }] },
    }
    expect(service.ingestObservation(owner, integration.id, input).created).toBe(true)
    expect(service.ingestObservation(owner, integration.id, input).created).toBe(false)
    expect(service.terrainSnapshot(owner).observationCount).toBe(1)
    expect(() => service.ingestObservation(owner, integration.id, { ...input, payload: { value: 2 } })).toThrow(/different content/)
  })

  it('atomically rejects relationships whose endpoints are unknown', async () => {
    const { service, owner, integration } = setup()
    expect(() => service.ingestObservation(owner, integration.id, {
      sourceRecordId: 'bad-record', observedAt: '2026-09-02T07:00:00Z', evidenceType: 'NetworkConnection', subject: 'unknown', payload: {},
      terrain: { entities: [], relationships: [{ kind: 'connected_to', sourceExternalId: 'missing-a', targetExternalId: 'missing-b' }] },
    })).toThrow(/unknown entity/i)
    expect(service.terrainSnapshot(owner)).toMatchObject({ observationCount: 0, entities: [], relationships: [] })
  })

  it('normalizes a versioned source-native record and retains its schema', async () => {
    const { service, owner, integration } = setup('zeek')
    const result = service.ingestObservation(owner, integration.id, {
      sourceRecordId: 'zeek-native-1', observedAt: '2026-09-02T07:00:00Z', schema: 'zeek.conn@1',
      payload: { uid: 'C1', 'id.orig_h': '10.0.0.12', 'id.orig_p': 51822, 'id.resp_h': '10.0.0.8', 'id.resp_p': 443, proto: 'tcp' },
    })
    expect(result).toMatchObject({ created: true, entities: 2, relationships: 1, observation: {
      schema: 'zeek.conn@1', evidenceType: 'NetworkConnection', subject: 'connection:C1',
    } })
    expect(service.terrainSnapshot(owner)).toMatchObject({
      entities: [{ externalId: 'ip:10.0.0.12' }, { externalId: 'ip:10.0.0.8' }],
      relationships: [{ kind: 'connected_to', attributes: { sourcePort: 51822, destinationPort: 443, protocol: 'tcp' } }],
    })
  })

  it('constrains source-native schemas and keeps canonical mode unambiguous', async () => {
    const { service, owner, integration } = setup('zeek')
    const base = { sourceRecordId: 'bad-native', observedAt: '2026-09-02T07:00:00Z', payload: { value: 1 } }
    expect(() => service.ingestObservation(owner, integration.id, base)).toThrow(/supported schema or a canonical Terrain projection/)
    expect(() => service.ingestObservation(owner, integration.id, { ...base, schema: 'suricata.eve.flow@1' })).toThrow(/not supported by zeek/)
    expect(() => service.ingestObservation(owner, integration.id, {
      ...base, schema: 'zeek.conn@1', terrain: { entities: [], relationships: [] },
    })).toThrow(/either a versioned source schema or a canonical Terrain projection/)
    expect(service.terrainSnapshot(owner).observationCount).toBe(0)
  })
})
